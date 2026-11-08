// Ocean/spotifyService.js
const axios = require('axios');
const querystring = require('querystring');
const supabase = require('./supabaseClient');
const { runQuery } = require('./queryUtils');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

/**
 * Exchange Authorization Code for Access & Refresh Tokens
 */
async function exchangeCodeForTokens(code) {
  const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authHeader}`,
      },
    }
  );

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresIn: response.data.expires_in,
    expiresAt: Date.now() + response.data.expires_in * 1000,
  };
}

/**
 * Automatically refresh expired Host access token
 */
async function refreshAccessToken(room) {
  if (Date.now() < room.expiresAt - 60000) {
    return room.accessToken; // Token still valid
  }

  try {
    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: room.refreshToken,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${authHeader}`,
        },
      }
    );

    room.accessToken = response.data.access_token;
    room.expiresAt = Date.now() + response.data.expires_in * 1000;
    if (response.data.refresh_token) room.refreshToken = response.data.refresh_token;

    // Persist refreshed token so server restarts can recover the room
    if (room.hostId) {
      runQuery(supabase.from('spotify_tokens').update({
        access_token: room.accessToken,
        refresh_token: room.refreshToken,
        expires_at: new Date(room.expiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', room.hostId), '[spotify] failed to persist refreshed token');
    }

    return room.accessToken;
  } catch (err) {
    console.error(`Failed to refresh token for room ${room.code}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Search Spotify Tracks
 */
async function searchTracks(room, query) {
  const token = await refreshAccessToken(room);
  const response = await axios.get('https://api.spotify.com/v1/search', {
    params: { q: query, type: 'track', limit: 10 },
    headers: { Authorization: `Bearer ${token}` },
  });

  return response.data.tracks.items.map((track) => ({
    id: track.id,
    uri: track.uri,
    title: track.name,
    artist: track.artists.map((a) => a.name).join(', '),
    albumArt: track.album.images[0]?.url || '',
    durationMs: track.duration_ms,
  }));
}

async function searchCatalogTracks(query) {
  const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tokenResponse = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({ grant_type: 'client_credentials' }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${authHeader}` } }
  );

  const response = await axios.get('https://api.spotify.com/v1/search', {
    params: { q: query, type: 'track', limit: 10 },
    headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
  });

  return response.data.tracks.items.map((track) => ({
    id: track.id,
    uri: track.uri,
    title: track.name,
    artist: track.artists.map((artist) => artist.name).join(', '),
    albumArt: track.album.images[0]?.url || '',
    durationMs: track.duration_ms,
  }));
}

/**
 * Push Track to Host's Active Spotify Queue
 */
async function addTrackToSpotifyQueue(room, trackUri) {
  const token = await refreshAccessToken(room);
  await axios.post(
    `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/**
 * Fetch the authenticated user's Spotify profile.
 * Used on OAuth callback to create/update the Ocarina profile.
 */
async function getSpotifyProfile(accessToken) {
  const response = await axios.get('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return {
    spotifyId: response.data.id,
    displayName: response.data.display_name || response.data.id,
    email: response.data.email || null,
    avatarUrl: response.data.images?.[0]?.url || null,
  };
}

/**
 * Check whether the user currently has an active Spotify device.
 * 
 * This is the key signal for user category detection:
 * - hasActiveDevice: true → Spotify is "open" on some device → Category 1 (Listener) → create room
 * - hasActiveDevice: false → Spotify not open / no device → Category 2 (Bandwagon) → friends list only
 * 
 * - 204 No Content = no active device (Spotify app closed or no device selected).
 * - 200 = active device exists, whether or not something is playing.
 */
async function getPlaybackStatus(accessToken) {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // 204 means no active session at all
    if (response.status === 204 || !response.data) {
      return { hasActiveDevice: false, isPlaying: false, currentTrack: null, deviceName: null };
    }

    const data = response.data;
    const currentTrack = data.item
      ? {
          id: data.item.id,
          uri: data.item.uri,
          title: data.item.name,
          artist: data.item.artists.map((a) => a.name).join(', '),
          albumArt: data.item.album.images[0]?.url || '',
          durationMs: data.item.duration_ms,
        }
      : null;

    return {
      hasActiveDevice: !!data.device,
      isPlaying: data.is_playing || false,
      currentTrack,
      deviceName: data.device?.name || null,
    };
  } catch (err) {
    // Some axios versions throw on 204 instead of resolving
    if (err.response?.status === 204) {
      return { hasActiveDevice: false, isPlaying: false, currentTrack: null, deviceName: null };
    }
    throw err;
  }
}

/**
 * Refresh a stored token by user ID without a live room object.
 * - Used for bandwagon users in /start-listening where no room exists yet.
 * - Returns fresh tokens and persists them to spotify_tokens.
 */
async function refreshStoredTokenForUser(userId, refreshToken) {
  const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${authHeader}` } }
  );

  const accessToken = response.data.access_token;
  const newRefreshToken = response.data.refresh_token || refreshToken;
  const expiresAt = Date.now() + response.data.expires_in * 1000;

  await runQuery(supabase.from('spotify_tokens').update({
    access_token: accessToken,
    refresh_token: newRefreshToken,
    expires_at: new Date(expiresAt).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId), '[spotify] failed to persist refreshed stored token');

  return { accessToken, refreshToken: newRefreshToken, expiresAt };
}

/**
 * Fetch Currently Playing & Spotify Queue
 */
async function getPlaybackState(room) {
  const token = await refreshAccessToken(room);

  try {
    const [currentlyPlayingRes, queueRes] = await Promise.all([
      axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      axios.get('https://api.spotify.com/v1/me/player/queue', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    const cpData = currentlyPlayingRes.data;
    const currentlyPlaying = cpData?.item
      ? {
          id: cpData.item.id,
          uri: cpData.item.uri,
          title: cpData.item.name,
          artist: cpData.item.artists.map((a) => a.name).join(', '),
          albumArt: cpData.item.album.images[0]?.url || '',
          progressMs: cpData.progress_ms,
          durationMs: cpData.item.duration_ms,
          isPlaying: cpData.is_playing,
        }
      : null;

    // shuffle_state is present on the currently-playing response
    const shuffleState = cpData?.shuffle_state ?? undefined;

    return { currentlyPlaying, shuffleState, spotifyQueue: queueRes.data?.queue || [] };
  } catch (err) {
    if (err.response?.status === 204) return { currentlyPlaying: null, shuffleState: undefined, spotifyQueue: [] };
    throw err;
  }
}

module.exports = {
  exchangeCodeForTokens,
  getSpotifyProfile,
  getPlaybackStatus,
  refreshStoredTokenForUser,
  searchTracks,
  searchCatalogTracks,
  addTrackToSpotifyQueue,
  getPlaybackState,
};