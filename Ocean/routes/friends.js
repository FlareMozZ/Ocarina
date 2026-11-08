// routes/friends.js - Ocarina social graph.
// 
// Spotify does not expose a public friends API, so Ocarina maintains its own.
// Users find each other by searching by username, send requests, and accept them.
// 
// Endpoints:
//  GET  /api/friends                       -> List accepted friends with room/listening status
//  GET  /api/friends/requests              -> Pending incoming friend requests
//  POST /api/friends/request               -> Send a friend request
//  PUT  /api/friends/requests/:id/accept   -> Accept a pending request
//  DELETE /api/friends/:friendId           -> Remove friend or decline request

const express = require('express');
const router = express.Router();

const supabase = require('../supabaseClient');
const { requireSpotifyAuth } = require('../middleware/requireAuth');
const { getPastelColor } = require('../colorUtils');

// GET /api/friends
// Returns accepted friends enriched with:
//  isListening - do they have an active room right now?
//  activeRoomCode - if yes, the room code so the UI can show a "Join" button
//  currentTrack - what they're playing (from rooms.current_track)
//  color - their pastel identity color

router.get('/', requireSpotifyAuth, async (req, res) => {
  const userId = req.session.sub;

  const { data: friendships, error } = await supabase
    .from('friendships')
    .select(`
      id,
      user_id,
      friend_id,
      user_profile:profiles!friendships_user_id_fkey(id, username, avatar_url),
      friend_profile:profiles!friendships_friend_id_fkey(id, username, avatar_url)
    `)
    .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
    .eq('status', 'ACCEPTED');

  if (error) return res.status(500).json({ error: 'Failed to fetch friends' });

  // Normalize to always get the "other" person in the friendship pair
  const friends = (friendships || []).map((f) => {
    const other = f.user_id === userId ? f.friend_profile : f.user_profile;
    return {
      friendshipId: f.id,
      userId: other.id,
      username: other.username,
      avatarUrl: other.avatar_url,
      color: getPastelColor(other.username),
    };
  });

  if (friends.length === 0) return res.json([]);

  // Single batch query for all friends' room status.
  // recent_plays lets bandwagon friends understand the current mood before dropping -
  // e.g. "Manoj just played 3 Coldplay songs" tells you to drop Yellow, not Slayer.
  const friendIds = friends.map((f) => f.userId);
  const { data: activeRooms } = await supabase
    .from('rooms')
    .select('host_id, room_code, current_track, recent_plays')
    .in('host_id', friendIds)
    .eq('is_active', true);

  const roomByHostId = {};
  for (const r of activeRooms || []) roomByHostId[r.host_id] = r;

  const enriched = friends.map((friend) => {
    const room = roomByHostId[friend.userId];
    return {
      ...friend,
      isListening: !!room,
      activeRoomCode: room?.room_code || null,
      currentTrack: room?.current_track || null,
      recentPlays: room?.recent_plays || [],
    };
  });

  res.json(enriched);
});

// GET /api/friends/requests
// Incoming pending requests - shown as notification badges in the UI.
// Must be declared before /:friendId to avoid routing conflict.

router.get('/requests', requireSpotifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('friendships')
    .select(`
      id,
      created_at,
      requester:profiles!friendships_user_id_fkey(id, username, avatar_url)
    `)
    .eq('friend_id', req.session.sub)
    .eq('status', 'PENDING');

  if (error) return res.status(500).json({ error: 'Failed to fetch requests' });

  const requests = (data || []).map((r) => ({
    requestId: r.id,
    from: {
      userId: r.requester.id,
      username: r.requester.username,
      avatarUrl: r.requester.avatar_url,
      color: getPastelColor(r.requester.username),
    },
    sentAt: r.created_at,
  }));

  res.json(requests);
});

// POST /api/friends/request
// Send a friend request to another Ocarina user (found via profile search).

router.post('/request', requireSpotifyAuth, async (req, res) => {
  const { targetUserId } = req.body;
  const myId = req.session.sub;

  if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });
  if (targetUserId === myId) return res.status(400).json({ error: 'You cannot add yourself' });

  // Check both directions to prevent duplicates
  const { data: existing } = await supabase
    .from('friendships')
    .select('id, status')
    .or(
      `and(user_id.eq.${myId},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${myId})`
    )
    .maybeSingle();

  if (existing) {
    const msg = existing.status === 'ACCEPTED' ? 'Already friends' : 'Friend request already pending';
    return res.status(409).json({ error: msg });
  }

  const { error } = await supabase
    .from('friendships')
    .insert({ user_id: myId, friend_id: targetUserId, status: 'PENDING' });

  if (error) return res.status(500).json({ error: 'Failed to send friend request' });
  res.json({ message: 'Friend request sent' });
});

// PUT /api/friends/requests/:id/accept

router.put('/requests/:id/accept', requireSpotifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('friendships')
    .update({ status: 'ACCEPTED' })
    .eq('id', req.params.id)
    .eq('friend_id', req.session.sub)
    .eq('status', 'PENDING')
    .select();

  if (error || !data) return res.status(404).json({ error: 'Request not found or already handled' });
  res.json({ message: 'Friend request accepted' });
});

// DELETE /api/friends/:friendId
// Remove an accepted friend or decline a pending request.
// Works in both directions (either party can remove).

router.delete('/:friendId', requireSpotifyAuth, async (req, res) => {
  const userId = req.session.sub;
  const { friendId } = req.params;

  const { error } = await supabase
    .from('friendships')
    .delete()
    .or(
      `and(user_id.eq.${userId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${userId})`
    );

  if (error) return res.status(500).json({ error: 'Failed to remove friend' });
  res.json({ message: 'Friend removed' });
});

module.exports = router;