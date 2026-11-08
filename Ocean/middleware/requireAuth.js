// Authentication middleware for Ocarina API routes.
// 
// Token lookup order:
//  1. Authorization: Bearer <token> header (preferred for API calls)
//  2. ocarina_session httpOnly cookie (set after OAuth callback)
// 
// Two variants:
//  requireAuth        - accepts both Spotify and guest sessions
//  requireSpotifyAuth - rejects guest sessions (for friend/profile features)

const { verifySession } = require('../sessionUtils');

/**
 * Accepts any valid session (Spotify or guest).
 * Attaches decoded payload to req.session.
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const session = verifySession(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  req.session = session;
  next();
}

/**
 * Requires a Spotify-authenticated session specifically.
 * Use on endpoints that need Spotify tokens, friend lists, or profile data.
 */
function requireSpotifyAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const session = verifySession(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
  if (session.type !== 'spotify') {
    return res.status(403).json({ error: 'A Spotify account is required for this action' });
  }

  req.session = session;
  next();
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return req.cookies?.ocarina_session || null;
}

module.exports = { requireAuth, requireSpotifyAuth };