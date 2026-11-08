// routes/profile.js - User profile management (Settings page).
// 
// Endpoints:
//  GET    /api/profile           -> Get own profile (with pastel color)
//  PUT    /api/profile           -> Update username or avatar
//  GET    /api/profile/search    -> Search for other users by username (for adding friends)
//  DELETE /api/profile           -> Delete account and all associated data

const express = require('express');
const router = express.Router();

const supabase = require('../supabaseClient');
const roomManager = require('../roomManager');
const { requireSpotifyAuth } = require('../middleware/requireAuth');
const { getPastelColor } = require('../colorUtils');

// GET /api/profile

router.get('/', requireSpotifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, spotify_id, created_at')
    .eq('id', req.session.sub)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Profile not found' });

  res.json({ ...data, color: getPastelColor(data.username) });
});

// PUT /api/profile
// Update username or avatar URL. Username change updates the pastel color the user
// sees everywhere (it's derived from username). We don't warn about this -
// it's an intentional trade-off for simplicity.

router.put('/', requireSpotifyAuth, async (req, res) => {
  const { username, avatarUrl } = req.body;
  const updates = { updated_at: new Date().toISOString() };

  if (username !== undefined) {
    const clean = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
    if (clean.length < 3 || clean.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, underscores)' });
    }

    // Ensure uniqueness, excluding the caller
    const { data: taken } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', clean)
      .neq('id', req.session.sub)
      .maybeSingle();

    if (taken) return res.status(409).json({ error: 'Username is already taken' });
    updates.username = clean;
  }

  if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.session.sub)
    .select('id, username, avatar_url')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to update profile' });
  res.json({ ...data, color: getPastelColor(data.username) });
});

// GET /api/profile/search?q=...
// Find other Ocarina users by username to send friend requests.
// Must be declared before /:userId to avoid routing conflicts.

router.get('/search', requireSpotifyAuth, async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Search query is required' });

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .ilike('username', `%${q.trim()}%`)
    .neq('id', req.session.sub) // Exclude self from results
    .eq('is_guest', false)
    .limit(20);

  if (error) return res.status(500).json({ error: 'Search failed' });

  res.json((data || []).map((u) => ({ ...u, color: getPastelColor(u.username) })));
});

// -- DELETE /api/profile --
// Full account deletion. The ON DELETE CASCADE in the DB schema handles:
//  - friendships, rooms, track_drops, spotify_tokens
// After deletion, clear the session cookie.

router.delete('/', requireSpotifyAuth, async (req, res) => {
  const userId = req.session.sub;

  // Close active room first so friends' lists update immediately
  await roomManager.deactivateRoomForHost(userId).catch(() => {});

  // Cascade deletion via DB FK constraints handles all related rows
  const { error } = await supabase.from('profiles').delete().eq('id', userId);

  if (error) return res.status(500).json({ error: 'Failed to delete account' });

  res.clearCookie('ocarina_session');
  res.json({ message: 'Account deleted' });
});

module.exports = router;