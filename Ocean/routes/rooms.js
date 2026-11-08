// routes/rooms.js - Room management endpoints.
// 
// Endpoints:
//  GET    /api/rooms/my/active        -> Get caller's own active room (if any)
//  POST   /api/rooms/start-listening  -> Bandwagon user opens Spotify; create room on-demand
//  GET    /api/rooms/:code            -> Get room details (any authenticated user)
//  POST   /api/rooms/:code/ping       -> Host heartbeat to keep room alive
//  DELETE /api/rooms/:code            -> Host closes their room

const express = require('express');
const router = express.Router();

const roomManager = require('../roomManager');
const spotifyService = require('../spotifyService');
const supabase = require('../supabaseClient');
const { requireSpotifyAuth, requireAuth } = require('../middleware/requireAuth');

// -- GET /api/rooms/my/active --
// Allows the frontend to check on load whether this user already has an active room
// (e.g. after a page refresh).
// Must be declared BEFORE /:code so Express doesn't interpret "my" as a room code.

router.get('/my/active', requireSpotifyAuth, async (req, res) => {
  const { data } = await supabase
    .from('rooms')
    .select('room_code, current_track, created_at')
    .eq('host_id', req.session.sub)
    .eq('is_active', true)
    .single();

  if (!data) return res.json({ hasActiveRoom: false });
  res.json({ hasActiveRoom: true, roomCode: data.room_code, currentTrack: data.current_track });
});

// -- POST /api/rooms/start-listening --
// Called when a bandwagon user opens Spotify after arriving in the app.
// Loads their stored Spotify tokens, checks for an active device, creates room.

router.post('/start-listening', requireSpotifyAuth, async (req, res) => {
  const userId = req.session.sub;

  const { data: tokenData } = await supabase
    .from('spotify_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .single();

  if (!tokenData) {
    return res.status(400).json({
      error: 'No Spotify credentials found. Please log in again.',
    });
  }

  let tokens = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(tokenData.expires_at).getTime(),
  };

  // Refresh if token is expired or within 60s of expiry.
  // Stored tokens can be stale for bandwagon users who haven't touched the app in a while.
  if (Date.now() > tokens.expiresAt - 60_000) {
    tokens = await spotifyService.refreshStoredTokenForUser(userId, tokens.refreshToken);
    tokens.expiresAt = new Date(tokens.expiresAt).getTime();
  }

  const playback = await spotifyService.getPlaybackStatus(tokens.accessToken);
  if (!playback.hasActiveDevice) {
    return res.status(400).json({
      error: 'No active Spotify device detected. Open Spotify on a device first.',
      hasActiveDevice: false,
    });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', userId)
    .single();

  const room = await roomManager.createOrReuseRoom(tokens, profile);

  res.status(201).json({
    roomCode: room.code,
    isPlaying: playback.isPlaying,
    currentTrack: playback.currentTrack,
  });
});

// -- GET /api/rooms/:code --
// Fetch room metadata. Both Spotify users and guests can view rooms,
// but guests are restricted to the room their token is scoped to.

router.get('/:code', requireAuth, async (req, res) => {
  const code = req.params.code.toUpperCase();

  // Guests may only access the room embedded in their token
  if (req.session.type === 'guest' && req.session.roomCode !== code) {
    return res.status(403).json({ error: 'Access denied to this room' });
  }

  const room = await roomManager.getRoom(code);
  if (!room) return res.status(404).json({ error: 'Room not found or no longer active' });

  const { data: host } = await supabase
    .from('profiles')
    .select('username, avatar_url')
    .eq('id', room.hostId)
    .single();

  res.json({
    code: room.code,
    host: host || { username: 'Unknown' },
    guestCount: room.guests.size,
    currentTrack: room.currentTrack || null,
    queueLength: room.customQueue.length,
  });
});

// -- POST /api/rooms/:code/ping --
// Host sends this every ~30 seconds to signal they're still active.
// Background cleanup marks rooms inactive after 5 minutes of no pings.

router.post('/:code/ping', requireSpotifyAuth, async (req, res) => {
  const code = req.params.code.toUpperCase();
  // Use getRoom() (async, with DB fallback) so pings survive server restarts.
  // getRoomFromCache() returns null after restart until something triggers a DB load.
  const room = await roomManager.getRoom(code);

  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.session.sub) return res.status(403).json({ error: 'Only the host can ping' });

  await supabase
    .from('rooms')
    .update({ last_ping_at: new Date().toISOString() })
    .eq('room_code', code);

  res.json({ ok: true });
});

// -- DELETE /api/rooms/:code --
// Host explicitly closes their room (e.g. "Stop sharing" button).

router.delete('/:code', requireSpotifyAuth, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = await roomManager.getRoomFromCache(code);

  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.session.sub) return res.status(403).json({ error: 'Only the host can close this room' });

  await roomManager.deactivateRoom(code);
  res.json({ message: 'Room closed' });
});

module.exports = router;