require('dotenv').config();
const dns = require('node:dns/promises');
const axios = require('axios');

const REQUIRED_ENV = [
  'PORT',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI',
  'FRONTEND_URL',
  'JWT_SECRET',
  'PUBLIC_SUPABASE_URL',
  'SECRET_SUPABASE_SERVICE_ROLE_KEY',
];

const REQUIRED_COLUMNS = {
  profiles: ['id', 'username', 'avatar_url', 'spotify_id', 'is_guest', 'created_at', 'updated_at'],
  friendships: ['id', 'user_id', 'friend_id', 'status', 'created_at'],
  rooms: [
    'id', 'host_id', 'room_code', 'is_active', 'current_track', 'recent_plays',
    'shuffle_state', 'session_started_at', 'last_ping_at', 'device_queue',
    'created_at', 'updated_at',
  ],
  track_drops: [
    'id', 'room_id', 'sender_id', 'receiver_id', 'guest_name', 'sender_name',
    'spotify_uri', 'title', 'artist', 'album_art', 'status', 'host_note',
    'was_echoed', 'chain_id', 'chain_order', 'session_started_at', 'created_at',
  ],
  spotify_tokens: ['user_id', 'access_token', 'refresh_token', 'expires_at', 'updated_at'],
  backlogs: [
    'id', 'host_id', 'spotify_uri', 'title', 'artist', 'album_art',
    'dropped_by_name', 'dropped_by_id', 'dropped_at', 'session_room_code',
    'chain_id', 'chain_order', 'expires_at', 'is_dismissed',
  ],
};

const RELATION_CHECKS = [
  ['friendships', 'id,user_profile:profiles!friendships_user_id_fkey(id),friend_profile:profiles!friendships_friend_id_fkey(id)'],
  ['track_drops', 'id,sender:profiles!track_drops_sender_id_fkey(id),receiver:profiles!track_drops_receiver_id_fkey(id)'],
  ['backlogs', 'id,dropper:profiles!backlogs_dropped_by_id_fkey(id)'],
];

let failures = 0;
let warnings = 0;

function pass(label, detail = '') {
  console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail) {
  failures++;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function warn(label, detail) {
  warnings++;
  console.warn(`  WARN ${label}${detail ? ` — ${detail}` : ''}`);
}

function configuredUrl(name) {
  try {
    return new URL(process.env[name]);
  } catch {
    fail(`${name} URL`, 'must be a valid absolute URL');
    return null;
  }
}

async function checkEnvironment() {
  console.log('\n[1/5] Environment');
  for (const name of REQUIRED_ENV) {
    if (!process.env[name] || process.env[name].includes('your_')) {
      fail(`${name} configured`, 'missing or still a placeholder');
    } else {
      pass(`${name} configured`);
    }
  }

  const redirectUri = configuredUrl('SPOTIFY_REDIRECT_URI');
  if (redirectUri) {
    const loopback = ['127.0.0.1', '::1'].includes(redirectUri.hostname);
    if (redirectUri.hostname === 'localhost') {
      fail('Spotify redirect hostname', 'Spotify requires an explicit loopback IP, not localhost');
    } else if (loopback && redirectUri.protocol !== 'http:') {
      fail('Spotify loopback redirect scheme', 'loopback redirect URIs must use HTTP');
    } else {
      pass('Spotify redirect URI configured', `${redirectUri.origin}${redirectUri.pathname}`);
    }
  }

  const frontendUrl = configuredUrl('FRONTEND_URL');
  if (redirectUri && frontendUrl && redirectUri.hostname !== frontendUrl.hostname) {
    fail('OAuth cookie hostname', 'FRONTEND_URL and SPOTIFY_REDIRECT_URI must use the same hostname');
  } else if (redirectUri && frontendUrl) {
    pass('OAuth cookie hostname matches frontend');
  }

  const supabaseUrl = configuredUrl('PUBLIC_SUPABASE_URL');
  if (supabaseUrl) {
    try {
      const addresses = await dns.lookup(supabaseUrl.hostname, { all: true });
      pass('Supabase hostname resolves', supabaseUrl.hostname);
      if (!addresses.length) fail('Supabase DNS', 'no IP addresses returned');
    } catch (error) {
      fail('Supabase hostname resolves', `${supabaseUrl.hostname}: ${error.code || error.message}`);
    }
  }
}

async function checkSpotify() {
  console.log('\n[2/5] Spotify credentials and catalog');
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return;

  try {
    const credentials = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString('base64');
    const tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        timeout: 10000,
      }
    );
    if (!tokenResponse.data.access_token) {
      fail('Spotify client credentials', 'Spotify returned no access token');
      return;
    }
    pass('Spotify client credentials accepted');

    await axios.get('https://api.spotify.com/v1/search', {
      params: { q: 'Ocarina setup check', type: 'track', limit: 1 },
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      timeout: 10000,
    });
    pass('Spotify catalog API reachable');
  } catch (error) {
    fail('Spotify API', error.response?.data?.error_description
      || error.response?.data?.error?.message
      || error.code
      || error.message);
  }
}

async function supabaseRequest(table, select) {
  const baseUrl = process.env.PUBLIC_SUPABASE_URL.replace(/\/+$/, '');
  const response = await fetch(
    `${baseUrl}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(select)}&limit=0`,
    {
      headers: {
        apikey: process.env.SECRET_SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SECRET_SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(10000),
    }
  );
  const body = await response.text();
  return { response, body };
}

async function checkDatabase() {
  console.log('\n[3/5] Supabase schema');
  if (!process.env.PUBLIC_SUPABASE_URL || !process.env.SECRET_SUPABASE_SERVICE_ROLE_KEY) return;

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    try {
      const { response, body } = await supabaseRequest(table, columns.join(','));
      if (response.ok) {
        pass(`${table} table and required columns`);
        continue;
      }
      let detail = `HTTP ${response.status}`;
      try {
        const error = JSON.parse(body);
        detail += ` ${error.code || ''} ${error.message || error.details || ''}`.trim();
      } catch {
        detail += ` ${body.slice(0, 180)}`;
      }
      fail(`${table} table and required columns`, detail);
    } catch (error) {
      fail(`${table} schema request`, `${error.cause?.code || error.code || error.name}: ${error.message}`);
      return;
    }
  }

  for (const [table, select] of RELATION_CHECKS) {
    try {
      const { response, body } = await supabaseRequest(table, select);
      if (response.ok) {
        pass(`${table} profile relationships`);
      } else {
        let detail = `HTTP ${response.status}`;
        try {
          const error = JSON.parse(body);
          detail += ` ${error.code || ''} ${error.message || error.details || ''}`.trim();
        } catch {
          detail += ` ${body.slice(0, 180)}`;
        }
        fail(`${table} profile relationships`, detail);
      }
    } catch (error) {
      fail(`${table} relationship request`, `${error.cause?.code || error.code || error.name}: ${error.message}`);
      return;
    }
  }

  try {
    const response = await fetch(`${process.env.PUBLIC_SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/`, {
      headers: {
        apikey: process.env.SECRET_SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SECRET_SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      fail('Supabase profile insert metadata', `OpenAPI returned HTTP ${response.status}`);
    } else {
      const schema = await response.json();
      const idDefault = schema.definitions?.profiles?.properties?.id?.default;
      if (typeof idDefault === 'string' && idDefault.toLowerCase().includes('gen_random_uuid')) {
        pass('OAuth profile ID generation', `profiles.id default is ${idDefault}`);
      } else {
        fail(
          'OAuth profile ID generation',
          `expected profiles.id DEFAULT gen_random_uuid(); received ${idDefault || 'no column default'}`
        );
      }
    }
  } catch (error) {
    fail('Supabase profile insert metadata', `${error.cause?.code || error.code || error.name}: ${error.message}`);
  }

  warn('Stored user Spotify credentials', 'schema checks cannot inspect private token rows; authenticate once, then verify /api/rooms/start-listening for that user');
}

async function checkBackend() {
  console.log('\n[4/5] Running Ocean backend');
  const port = process.env.PORT || '5000';
  const backendUrl = (process.env.BACKEND_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');

  try {
    const health = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) {
      fail('Ocean health endpoint', `HTTP ${health.status}`);
    } else {
      const result = await health.json();
      result.status === 'ok'
        ? pass('Ocean health endpoint')
        : fail('Ocean health endpoint', 'unexpected response payload');
    }
  } catch (error) {
    fail('Ocean health endpoint', `${error.cause?.code || error.code || error.name}: ${error.message}`);
    return;
  }

  try {
    const frontend = new URL(process.env.FRONTEND_URL);
    const response = await fetch(`${backendUrl}/auth/me`, {
      headers: { Origin: frontend.origin },
      signal: AbortSignal.timeout(5000),
    });
    const allowedOrigin = response.headers.get('access-control-allow-origin');
    if (allowedOrigin === frontend.origin && response.headers.get('access-control-allow-credentials') === 'true') {
      pass('Credentialed CORS origin');
    } else {
      fail('Credentialed CORS origin', `expected ${frontend.origin}; received ${allowedOrigin || 'no allow-origin header'}`);
    }
    response.status === 401
      ? pass('Unauthenticated session check', '401 is expected before sign-in')
      : fail('Unauthenticated session check', `expected 401 before sign-in, received ${response.status}`);
  } catch (error) {
    fail('Backend CORS/session check', `${error.cause?.code || error.code || error.name}: ${error.message}`);
  }

  try {
    const response = await fetch(`${backendUrl}/auth/spotify`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      fail('Spotify OAuth route', `expected redirect, received HTTP ${response.status}`);
      return;
    }

    const authorize = new URL(location);
    const redirectUri = new URL(process.env.SPOTIFY_REDIRECT_URI);
    if (authorize.hostname !== 'accounts.spotify.com' || authorize.pathname !== '/authorize') {
      fail('Spotify authorization URL', 'redirect is not Spotify /authorize');
    } else if (authorize.searchParams.get('response_type') !== 'code') {
      fail('Spotify authorization response_type', 'must be code');
    } else if (authorize.searchParams.get('redirect_uri') !== redirectUri.href) {
      fail('Spotify callback URL', `backend sends ${authorize.searchParams.get('redirect_uri') || 'no redirect_uri'} but .env configures ${redirectUri.href}`);
    } else if (!authorize.searchParams.get('client_id') || !authorize.searchParams.get('scope')) {
      fail('Spotify authorization parameters', 'client_id or scope is missing');
    } else {
      pass('Spotify OAuth route', 'authorization code and callback URL match configuration');
    }
  } catch (error) {
    fail('Spotify OAuth route', `${error.cause?.code || error.code || error.name}: ${error.message}`);
  }
}

async function main() {
  console.log('Ocarina / Ocean setup validation (read-only)');
  await checkEnvironment();
  await checkSpotify();
  await checkDatabase();
  await checkBackend();

  console.log(`\nValidation finished: ${failures} failure(s), ${warnings} warning(s).`);
  if (failures) {
    console.error('Fix the failures above before testing Spotify sign-in or room creation.');
    process.exitCode = 1;
  } else {
    console.log('Setup checks passed. Complete one browser-based Spotify consent flow to verify account-specific token storage and room creation.');
  }
}

main().catch((error) => {
  console.error(`Validator failed unexpectedly: ${error.message}`);
  process.exitCode = 1;
});
