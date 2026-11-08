// Ocean/testBackend.js
require('dotenv').config();
const axios = require('axios');
const http = require('http');
const spotifyService = require('./spotifyService');
const roomManager = require('./roomManager');

// Color helpers for terminal output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

async function runBackendTests() {
  console.log('\n----------------------------------------');
  console.log('       OCEAN BACKEND VERIFICATION       ');
  console.log('----------------------------------------\n');

  // ————————————————————————————————————————
  // TEST 1: Environment Variables Check
  // ————————————————————————————————————————
  console.log(colors.cyan, '[1/5] Checking .env configuration...');
  const requiredEnvVars = [
    'PORT',
    'SPOTIFY_CLIENT_ID',
    'SPOTIFY_CLIENT_SECRET',
    'SPOTIFY_REDIRECT_URI',
    'FRONTEND_URL',
    'JWT_SECRET',
    'PUBLIC_SUPABASE_URL',
    'SECRET_SUPABASE_SERVICE_ROLE_KEY',
  ];
  const secretEnvVars = new Set([
    'SPOTIFY_CLIENT_SECRET',
    'JWT_SECRET',
    'SECRET_SUPABASE_SERVICE_ROLE_KEY',
  ]);

  let missingEnv = false;
  requiredEnvVars.forEach((key) => {
    if (!process.env[key] || process.env[key].includes('your_')) {
      console.log(colors.red, `  ✗ Missing or placeholder value for: ${key}`);
      missingEnv = true;
    } else {
      const value = secretEnvVars.has(key) ? '***' : process.env[key];
      console.log(colors.green, `  ✓ ${key} is set (${value})`);
    }
  });

  if (missingEnv) {
    console.log(colors.red, '\nFAILED: Please fix your .env file before proceeding.');
    process.exit(1);
  }

  // ————————————————————————————————————————
  // TEST 2: In-Memory Room Manager Logic
  // ————————————————————————————————————————
  console.log('\n' + colors.cyan, '[2/5] Testing Room Manager...');
  try {
    const roomCode = roomManager.generateRoomCode();
    if (!/^[A-Z2-9]{6}$/.test(roomCode)) {
      throw new Error(`Generated invalid room code: ${roomCode}`);
    }

    const room = {
      code: roomCode,
      customQueue: [],
      contributorBuckets: new Map(),
    };
    roomManager.getRoomsMap().set(roomCode, room);
    console.log(colors.green, `  ✓ Room code generated successfully: ${roomCode}`);

    const fetchedRoom = roomManager.getRoomFromCache(roomCode);
    if (!fetchedRoom || fetchedRoom.code !== room.code) {
      throw new Error('Failed to retrieve cached room.');
    }
    console.log(colors.green, '  ✓ Room cache lookup verified.');

    // Test Adding & Voting Track
    const dummyTrack = { id: 'track123', title: 'Test Song', artist: 'Test Artist', uri: 'spotify:track:123' };
    const queueItem = roomManager.addTrackToRoomQueue(room, dummyTrack, 'Alex');
    console.log(colors.green, '  ✓ Track queued locally for guest "Alex".');

    const voted = roomManager.voteTrack(room, queueItem.id, 'socket_client_1');
    if (!voted) throw new Error('Voting track failed.');
    if (queueItem.votes !== 1) throw new Error('Upvoting track failed.');
    console.log(colors.green, `  ✓ Upvoting logic working (Votes: ${queueItem.votes}).`);
    roomManager.getRoomsMap().delete(roomCode);
  } catch (err) {
    console.log(colors.red, `  ✗ Room Manager Test Failed: ${err.message}`);
    process.exit(1);
  }

  // ————————————————————————————————————————
  // TEST 3: Verify Spotify Developer Credentials (Client Credentials Check)
  // ————————————————————————————————————————
  console.log('\n' + colors.cyan, '[3/5] Verifying Spotify Credentials with Spotify Accounts API...');
  try {
    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString('base64');

    const res = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${authHeader}`,
        },
      }
    );

    if (res.data.access_token) {
      console.log(colors.green, '  ✓ Spotify Client ID & Secret are VALID!');
    }

    // Test search function using client credentials
    const searchRes = await axios.get('https://api.spotify.com/v1/search', {
      params: { q: 'Dua Lipa', type: 'track', limit: 1 },
      headers: { Authorization: `Bearer ${res.data.access_token}` },
    });

    if (searchRes.data.tracks?.items?.length > 0) {
      const track = searchRes.data.tracks.items[0];
      console.log(colors.green, `  ✓ Spotify Catalog Search test passed! Found: "${track.name}" by ${track.artists[0].name}`);
    }
  } catch (err) {
    console.log(colors.red, '  ✗ Spotify Credential Check Failed! Check your Client ID & Secret.');
    console.log(colors.yellow, `  Error Details: ${err.response?.data?.error_description || err.message}`);
    process.exit(1);
  }

  // ————————————————————————————————————————
  // TEST 4: Local Express Server & Endpoint Ping
  // ————————————————————————————————————————
  console.log('\n' + colors.cyan, '[4/5] Testing Express Server Endpoints...');
  const { server } = require('./server');
  const PORT = process.env.PORT || 5000;

  // Bind the server instance once during the test
  let runningserver = server.listen(PORT, async () => {
    console.log(colors.green, `  ✓ Server successfully bound to port ${PORT}`);

    try {
      const healthRes = await axios.get(`http://127.0.0.1:${PORT}/health`);
      if (healthRes.status === 200 && healthRes.data.status === 'ok') {
        console.log(colors.green, '  ✓ Health endpoint is responding.');
      } else {
        throw new Error(`Unexpected health response: ${healthRes.status}`);
      }

      console.log('\n' + colors.cyan, '[5/5] Testing OAuth Redirect URL Construction...');
      const loginRes = await axios.get(`http://127.0.0.1:${PORT}/auth/spotify`, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const redirectLocation = loginRes.headers.location;
      if (redirectLocation && redirectLocation.includes('accounts.spotify.com/authorize')) {
        console.log(colors.green, '  ✓ Login redirect endpoint correctly routes to Spotify Accounts!');
      }

      console.log('\n========================================');
      console.log(colors.green, '  🎉 ALL BACKEND CHECKS PASSED SUCCESSFULLY! ');
      console.log('========================================\n');

      runningserver.close();
      process.exit(0);
    } catch (err) {
      console.log(colors.red, `  ✗ Server endpoint test failed: ${err.message}`);
      runningserver.close();
      process.exit(1);
    }
  });
}

runBackendTests();