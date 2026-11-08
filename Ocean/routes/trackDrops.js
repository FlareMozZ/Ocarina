// routes/trackDrops.js - Track recommendations (the "Drops" system).
// 
// A "drop" is recorded whenever someone adds a song to a room.
// This powers two UI panels:
//  1. Recommendations Panel - songs YOU dropped to friends, grouped by friend
//  2. Room Queue Attribution - all drops in a room, with who-added-each info
// 
// Feedback model (no likes, no metrics):
//  host_note   - Optional reflection the host writes after the session, max 150 chars.
//                Surfaced in the dropper's Recommendations Panel.
//  was_echoed  - Automatically set true when the host organically plays the same artist
//                after your drop. Detected passively. No button to tap.
// 
// Endpoints:
//  PUT    /api/drops/:id/note       -> Host writes a post-session note for a drop
//  GET    /api/drops/sent           -> Drops you sent, grouped by recipient
//  GET    /api/drops/room/:roomCode -> All drops in a room with attribution
//  POST   /api/drops                -> Quick-drop a track to a friend's active room

const express = require('express');
const router = express.Router();

const supabase = require('../supabaseClient');
const roomManager = require('../roomManager');
const spotifyService = require('../spotifyService');
const { requireAuth, requireSpotifyAuth } = require('../middleware/requireAuth');
const { getPastelColor } = require('../colorUtils');

// -- PUT /api/drops/:id/note --
// The host can leave an optional note for any drop they received.
// Written after the session - a quiet acknowledgement, not a public metric.
// Max 150 characters (same constraint as the DB CHECK).

router.put('/:id/note', requireSpotifyAuth, async (req, res) => {
  const { note } = req.body;
  if (typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }
  if (note.length > 150) {
    return res.status(400).json({ error: 'Note cannot exceed 150 characters' });
  }

  const { error } = await supabase
    .from('track_drops')
    .update({ host_note: note.trim() || null })
    .eq('id', req.params.id)
    .eq('receiver_id', req.session.sub); // Only the host (receiver) can write a note

  if (error) return res.status(500).json({ error: 'Failed to save note' });
  res.json({ message: 'Note saved' });
});

// -- GET /api/drops/sent --
// Powers the Recommendations Panel on the home screen.
// Returns all tracks you've dropped to friends, grouped by friend, newest first.
// Each friend tile uses their pastel color as the banner.

router.get('/sent', requireSpotifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('track_drops')
    .select(`
      id,
      spotify_uri,
      title,
      artist,
      album_art,
      status,
      host_note,
      was_echoed,
      chain_id,
      chain_order,
      created_at,
      receiver:profiles!track_drops_receiver_id_fkey(id, username, avatar_url)
    `)
    .eq('sender_id', req.session.sub)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'Failed to fetch your drops' });

  // Group by recipient friend
  const grouped = {};
  for (const drop of data || []) {
    const rid = drop.receiver.id;
    if (!grouped[rid]) {
      grouped[rid] = {
        friend: {
          userId: drop.receiver.id,
          username: drop.receiver.username,
          avatarUrl: drop.receiver.avatar_url,
          color: getPastelColor(drop.receiver.username),
        },
        drops: [],
      };
    }
    grouped[rid].drops.push({
      id: drop.id,
      spotifyUri: drop.spotify_uri,
      title: drop.title,
      artist: drop.artist,
      albumArt: drop.album_art,
      status: drop.status,                     // QUEUED -> PLAYED when host hears it
      hostNote: drop.host_note || null,         // Host's optional post-session reflection
      wasEchoed: drop.was_echoed,               // Did the host keep going with your artist?
      chainId: drop.chain_id || null,
      chainOrder: drop.chain_order ?? null,
      droppedAt: drop.created_at,
    });
  }

  res.json(Object.values(grouped));
});

// -- GET /api/drops/room/:roomCode --
// Powers the colorful queue view inside a room.
// Each drop carries the sender's identity and their pastel color.
// Guests are restricted to their scoped room.

router.get('/room/:roomCode', requireAuth, async (req, res) => {
  const code = req.params.roomCode.toUpperCase();

  if (req.session.type === 'guest' && req.session.roomCode !== code) {
    return res.status(403).json({ error: 'Access denied to this room' });
  }

  const { data: roomData } = await supabase
    .from('rooms')
    .select('id')
    .eq('room_code', code)
    .eq('is_active', true)
    .single();

  if (!roomData) return res.status(404).json({ error: 'Room not found or inactive' });

  const { data, error } = await supabase
    .from('track_drops')
    .select(`
      id,
      spotify_uri,
      title,
      artist,
      album_art,
      status,
      host_note,
      was_echoed,
      chain_id,
      chain_order,
      guest_name,
      created_at,
      sender:profiles!track_drops_sender_id_fkey(id, username, avatar_url)
    `)
    .eq('room_id', roomData.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Failed to fetch room drops' });

  const drops = (data || []).map((d) => {
    const displayName = d.sender?.username || d.guest_name || 'Guest';
    return {
      id: d.id,
      spotifyUri: d.spotify_uri,
      title: d.title,
      artist: d.artist,
      albumArt: d.album_art,
      status: d.status,
      hostNote: d.host_note || null,
      wasEchoed: d.was_echoed,
      chainId: d.chain_id || null,
      chainOrder: d.chain_order ?? null,
      droppedAt: d.created_at,
      addedBy: {
        userId: d.sender?.id || null,
        username: displayName,
        avatarUrl: d.sender?.avatar_url || null,
        isGuest: !d.sender,
        color: getPastelColor(displayName),
      },
    };
  });

  res.json(drops);
});

// -- POST /api/drops --
// Quick-drop: add a track to a friend's room without navigating into it.
// Powers the "Add" button directly from the Recommendations Panel.
// Verifies friendship, checks friend has an active room, queues the track.

router.post('/', requireSpotifyAuth, async (req, res) => {
  const { friendId, track } = req.body;
  const senderId = req.session.sub;

  if (!friendId) return res.status(400).json({ error: 'friendId is required' });
  if (!track?.uri || !track?.title || !track?.artist) {
    return res.status(400).json({ error: 'track must include uri, title, and artist' });
  }

  const { data: friendship } = await supabase
    .from('friendships')
    .select('id')
    .or(
      `and(user_id.eq.${senderId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${senderId})`
    )
    .eq('status', 'ACCEPTED')
    .maybeSingle();

  if (!friendship) {
    return res.status(403).json({ error: 'You can only drop tracks to friends' });
  }

  const { data: dbRoom } = await supabase
    .from('rooms')
    .select('id, room_code, host_id')
    .eq('host_id', friendId)
    .eq('is_active', true)
    .single();

  if (!dbRoom) {
    return res.status(404).json({ error: 'Your friend is not currently listening' });
  }

  const key = senderId;
  const liveRoom = await roomManager.getRoom(dbRoom.room_code);

  if (liveRoom) {
    const check = roomManager.checkDropAllowed(key, dbRoom.room_code);
    if (!check.allowed) {
      const msg = check.reason === 'total_cap'
        ? 'You have reached the session drop maximum across all friends'
        : 'You have reached the limit for this friend\'s queue';
      return res.status(429).json({ error: msg });
    }

    try {
      await spotifyService.addTrackToSpotifyQueue(liveRoom, track.uri);
      roomManager.addTrackToRoomQueue(liveRoom, track, req.session.username, senderId);
    } catch {
      roomManager.releaseDropsSlot(key, dbRoom.room_code);
      return res.status(502).json({ error: 'Failed to add track to Spotify queue' });
    }
  }

  await supabase.from('track_drops').insert({
    room_id: dbRoom.id,
    sender_id: senderId,
    receiver_id: friendId,
    spotify_uri: track.uri,
    title: track.title,
    artist: track.artist,
    album_art: track.albumArt || null,
    status: 'QUEUED',
  });

  res.status(201).json({ message: 'Track dropped successfully' });
});

module.exports = router;