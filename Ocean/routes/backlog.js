// routes/backlog.js - Missed recommendations inbox.
// 
// When a room closes (host logs off, timeout, or explicit close), any QUEUED drops
// that never played get saved as backlog entries for the host.
// 
// Design intent: this is a gentle "your friends were thinking of you" inbox.
// It's NOT a history - it's only the most recent session's unheard drops.
// Entries expire after 48 hours automatically. No accumulation across many sessions.
// 
// Endpoints:
//  GET  /api/backlog               -> Active (non-expired, non-dismissed) backlog items
//  POST /api/backlog/:id/queue     -> Add a backlog item to the current active room
//  DELETE /api/backlog/:id         -> Dismiss (remove) a single item
//  DELETE /api/backlog             -> Clear all backlog items (host reviewed them all)

const express = require('express');
const router = express.Router();

const supabase = require('../supabaseClient');
const roomManager = require('../roomManager');
const spotifyService = require('../spotifyService');
const { requireSpotifyAuth } = require('../middleware/requireAuth');
const { getPastelColor } = require('../colorUtils');
const { runQuery } = require('../queryUtils');

// GET /api/backlog
// Returns active backlog for the authenticated host.
// Only shows non-expired, non-dismissed items. Grouped by which session they came from.

router.get('/', requireSpotifyAuth, async (req, res) => {
  // clean up expired entries first (housekeeping on read)
  await runQuery(supabase
    .from('backlogs')
    .delete()
    .eq('host_id', req.session.sub)
    .lt('expires_at', new Date().toISOString()), '[backlog] expired item cleanup failed');

  const { data, error } = await supabase
    .from('backlogs')
    .select(`
      id,
      spotify_uri,
      title,
      artist,
      album_art,
      dropped_by_name,
      dropped_by_id,
      dropped_at,
      session_room_code,
      expires_at,
      dropper:profiles!backlogs_dropped_by_id_fkey(username, avatar_url)
    `)
    .eq('host_id', req.session.sub)
    .eq('is_dismissed', false)
    .gt('expires_at', new Date().toISOString())
    .order('dropped_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch backlog' });

  // Enrich with dropper color
  const items = (data || []).map((item) => ({
    id: item.id,
    spotifyUri: item.spotify_uri,
    title: item.title,
    artist: item.artist,
    albumArt: item.album_art,
    droppedBy: {
      name: item.dropper?.username || item.dropped_by_name,
      avatarUrl: item.dropper?.avatar_url || null,
      color: getPastelColor(item.dropped_by_name),
    },
    droppedAt: item.dropped_at,
    sessionRoomCode: item.session_room_code,
    expiresAt: item.expires_at,
  }));

  res.json(items);
});

// POST /api/backlog/:id/queue
// Host wants to actually listen to a backlog recommendation now.
// Requires an active room - otherwise tell them to open Spotify first.

router.post('/:id/queue', requireSpotifyAuth, async (req, res) => {
  const { data: item } = await supabase
    .from('backlogs')
    .select('*')
    .eq('id', req.params.id)
    .eq('host_id', req.session.sub)
    .single();

  if (!item) return res.status(404).json({ error: 'Backlog item not found' });

  // Find caller's active room
  const { data: dbRoom } = await supabase
    .from('rooms')
    .select('room_code')
    .eq('host_id', req.session.sub)
    .eq('is_active', true)
    .single();

  if (!dbRoom) {
    return res.status(400).json({
      error: 'You need an active listening session to queue a backlog item. Open Spotify first.',
    });
  }

  const room = await roomManager.getRoom(dbRoom.room_code);
  if (!room) return res.status(500).json({ error: 'Room could not be loaded' });

  await spotifyService.addTrackToSpotifyQueue(room, item.spotify_uri);
  roomManager.addTrackToRoomQueue(
    room,
    {
      id: item.spotify_uri.split(':').pop(), // Extract track ID from URI
      uri: item.spotify_uri,
      title: item.title,
      artist: item.artist,
      albumArt: item.album_art || '',
    },
    item.dropped_by_name
  );

  // Mark backlog item as dismissed once acted upon
  await supabase.from('backlogs').update({ is_dismissed: true }).eq('id', item.id);

  res.json({ message: 'Added to queue', roomCode: dbRoom.room_code });
});

// DELETE /api/backlog/:id
// Dismiss a single backlog recommendation (host decides they don't want it).

router.delete('/:id', requireSpotifyAuth, async (req, res) => {
  const { error } = await supabase
    .from('backlogs')
    .update({ is_dismissed: true })
    .eq('id', req.params.id)
    .eq('host_id', req.session.sub);

  if (error) return res.status(500).json({ error: 'Failed to dismiss item' });
  res.json({ message: 'Dismissed' });
});

// DELETE /api/backlog
// Clear the entire backlog (host has reviewed everything and is done).

router.delete('/', requireSpotifyAuth, async (req, res) => {
  const { error } = await supabase
    .from('backlogs')
    .update({ is_dismissed: true })
    .eq('host_id', req.session.sub)
    .eq('is_dismissed', false);

  if (error) return res.status(500).json({ error: 'Failed to clear backlog' });
  res.json({ message: 'Backlog cleared' });
});

module.exports = router;