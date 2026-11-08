// Session token helpers using JSON Web Tokens (JWT).
// 
// Architecture: stateless sessions - no DB table for sessions.
// Spotify users get a 7-day token. Guests get a 24-hour token scoped to one room.
// Token revocation is not supported (logout just clears the cookie client-side).
// If revocation is ever needed, add a server-side blocklist table.

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

/**
 * Issue a session token for a Spotify-authenticated user.
 * Payload: { sub: userId, username, type: 'spotify' }
 */
function issueSpotifySession(userId, username) {
  if (!SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { sub: userId, username, type: 'spotify' },
    SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Issue a session token for a guest.
 * Guests are ephemeral - no DB profile. Token encodes their identity.
 * Payload: { sub: guestId, guestName, roomCode, type: 'guest' }
 */
function issueGuestSession(guestId, guestName, roomCode) {
  if (!SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { sub: guestId, guestName, roomCode, type: 'guest' },
    SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Verify and decode a session token.
 * Returns the decoded payload or null if invalid/expired.
 */
function verifySession(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

module.exports = { issueSpotifySession, issueGuestSession, verifySession };