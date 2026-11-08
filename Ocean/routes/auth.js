// routes/auth.js - Authentication flow for Ocarina.
// 
// Endpoints:
//  GET  /auth/spotify      -> Redirect to Spotify OAuth
//  GET  /auth/callback     -> Spotify callback - detects listener vs bandwagon
//  POST /auth/guest        -> Guest login with username + room code
//  GET  /auth/me           -> Get current session info
//  POST /auth/logout       -> Clear session cookie + deactivate room

const express = require('express');
const querystring = require('querystring');
const crypto = require('crypto');
const router = express.Router();

const spotifyService = require('../spotifyService');
const roomManager = require('../roomManager');
const supabase = require('../supabaseClient');
const { issueSpotifySession, issueGuestSession } = require('../sessionUtils');
const { requireAuth } = require('../middleware/requireAuth');

const FRONTEND_URL = process.env.FRONTEND_URL;

// Scopes needed regardless of user category.
// Bandwagon users need user-read-playback-state so we can detect hasActiveDevice.
// Listener users need all three for full queue management.
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-read-email',
].join(' ');

// Step 1: Initiate Spotify OAuth
router.get('/spotify', (req, res) => {
  const params = querystring.stringify({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    scope: SPOTIFY_SCOPES,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// Step 2: Spotify OAuth Callback
// 
// Detection logic after OAuth:
//  Spotify API /v1/me/player returns 200 with a device -> Spotify is open -> Category 1 (Listener)
//  Spotify API /v1/me/player returns 204 (no device) -> Spotify not open -> Category 2 (Bandwagon)
// 
// Category 1: Create a room -> redirect to /room/:code?isHost=true
// Category 2: No room created -> redirect to /friends
// 
// In both cases the user gets a session JWT as an httpOnly cookie.

router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect(`${FRONTEND_URL}?error=missing_code`);

  try {
    // 1. Exchange authorization code for Spotify tokens
    const tokens = await spotifyService.exchangeCodeForTokens(code);

    // 2. Fetch the Spotify user's profile to identify them
    const spotifyProfile = await spotifyService.getSpotifyProfile(tokens.accessToken);

    // 3. Upsert into our profiles table (creates on first login, updates avatar on repeat)
    const user = await upsertProfile(spotifyProfile);

    // 4. Persist Spotify tokens so rooms can be recovered after server restart
    await persistSpotifyTokens(user.id, tokens);

    // 5. Issue Ocarina session JWT as httpOnly cookie
    const sessionToken = issueSpotifySession(user.id, user.username);
    setSessionCookie(res, sessionToken, 7 * 24 * 60 * 60 * 1000);

    // 6. Check if Spotify is "open" on any device right now
    const playback = await spotifyService.getPlaybackStatus(tokens.accessToken);

    if (playback.hasActiveDevice) {
      // Category 1: Listener
      // Spotify is open (playing or paused). Create a room and go to the music page.
      const room = await roomManager.createOrReuseRoom(tokens, user);
      return res.redirect(`${FRONTEND_URL}/room/${room.code}?isHost=true`);
    } else {
      // Category 2: Bandwagon
      // Spotify is not open. No room needed - show friends list so they can
      // see who's listening and join a room to add songs.
      return res.redirect(`${FRONTEND_URL}/friends`);
    }
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// Guest Login
// 
// For people who join via room code (QR scan or shared link).
// No Spotify account needed. Token is scoped to one room for 24 hours.

router.post('/guest', async (req, res) => {
  const { username, roomCode } = req.body;

  if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
  if (!roomCode?.trim()) return res.status(400).json({ error: 'Room code is required' });

  const cleanName = username.trim().slice(0, 30);
  const cleanCode = roomCode.trim().toUpperCase();

  // Verify the room exists and is active before issuing a token
  const room = await roomManager.getRoom(cleanCode);
  if (!room) return res.status(404).json({ error: 'Room not found or no longer active' });

  // Ephemeral guest ID - not stored in DB, embedded in JWT only
  const guestId = crypto.randomUUID();
  const sessionToken = issueGuestSession(guestId, cleanName, cleanCode);
  setSessionCookie(res, sessionToken, 24 * 60 * 60 * 1000);

  res.json({ guestId, guestName: cleanName, roomCode: cleanCode, sessionType: 'guest' });
});

// Session Info

router.get('/me', requireAuth, async (req, res) => {
  const { sub: userId, type, guestName, roomCode } = req.session;

  if (type === 'guest') {
    return res.json({ sessionType: 'guest', guestName, roomCode });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, spotify_id, created_at')
    .eq('id', userId)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json({ sessionType: 'spotify', ...profile });
});

// Logout

router.post('/logout', requireAuth, async (req, res) => {
  if (req.session.type === 'spotify') {
    // Deactivate the host's room so it disappears from friends' lists
    await roomManager.deactivateRoomForHost(req.session.sub).catch(() => {});
  }

  res.clearCookie('ocarina_session');
  res.json({ message: 'Logged out' });
});

// Internal Helpers

/**
 * Upsert a Spotify user into profiles.
 * * First login -> insert with a unique username derived from Spotify display name.
 * * Repeat login -> update avatar (display name may have changed on Spotify side).
 */
async function upsertProfile(spotifyProfile) {
  const { spotifyId, displayName, avatarUrl } = spotifyProfile;

  // Check for existing profile by Spotify ID
  const { data: existing } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('spotify_id', spotifyId)
    .maybeSingle();

  if (existing) {
    // Keep username stable; only sync avatar on repeat logins
    await supabase
      .from('profiles')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  // First login: derive a username from their Spotify display name
  const base = (displayName || spotifyId)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 25);

  const username = await ensureUniqueUsername(base);

  const { data: newProfile, error } = await supabase
    .from('profiles')
    .insert({ username, avatar_url: avatarUrl, spotify_id: spotifyId, is_guest: false })
    .select('id, username')
    .single();

  if (error) throw new Error(`Profile creation failed: ${error.message}`);
  return newProfile;
}

/**
 * Append a numeric suffix until the username is unique.
 * e.g. "manoj" -> "manoj_2" -> "manoj_3"
 */
async function ensureUniqueUsername(base) {
  let candidate = base || 'user';
  let suffix = 2;
  while (true) {
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', candidate)
      .maybeSingle();

    if (!data) return candidate;
    candidate = `${base}_${suffix++}`;
  }
}

/**
 * Store Spotify tokens in DB so rooms survive server restarts.
 */
async function persistSpotifyTokens(userId, tokens) {
  const { error } = await supabase.from('spotify_tokens').upsert(
    {
      user_id: userId,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: new Date(tokens.expiresAt).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(`Spotify credentials could not be saved: ${error.message}`);
}

/**
 * Set session cookie with appropriate security flags.
 */
function setSessionCookie(res, token, maxAgeMs) {
  res.cookie('ocarina_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeMs,
  });
}

module.exports = router;