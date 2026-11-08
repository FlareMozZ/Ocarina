// Ocean/server.js - Ocarina backend entry point.
// 
// Architecture:
//  - Express handles all REST API routes (auth, rooms, friends, search, drops, profile).
//  - Socket.IO handles real-time room sync (join, queue, votes, presence).
// Two background workers run on intervals:
//  - Every 4s: Sync Spotify playback state for all active rooms
//  - Every 5m: Mark stale rooms inactive (no host ping for 5 minutes)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { runQuery } = require('./queryUtils');

const roomManager = require('./roomManager');
const spotifyService = require('./spotifyService');
const supabase = require('./supabaseClient');
const { setupSocketHandlers } = require('./socket/handlers');

// Route modules
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const friendRoutes = require('./routes/friends');
const searchRoutes = require('./routes/search');
const trackDropRoutes = require('./routes/trackDrops');
const profileRoutes = require('./routes/profile');
const backlogRoutes = require('./routes/backlog');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true, // Required for cookie-based auth with cross-origin sockets
  },
});

// — Middleware —

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true, // Allow cookies in cross-origin requests
}));
app.use(express.json());
app.use(cookieParser());

// — REST Routes —

app.use('/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/drops', trackDropRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/backlog', backlogRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// — Socket.IO —

const { broadcastRoomState } = setupSocketHandlers(io);

// — Background Workers —

// Worker 1: Sync Spotify playback state for every active in-memory room.
// Runs every 4 seconds (matching Spotify's ~4s poll window recommendation).
// 
// Design: this worker detects changes and delegates all state mutation to
// broadcastRoomState - it never pre-updates room.currentTrack itself.
// Pre-updating would cause broadcastRoomState to miss the song change,
// skipping eviction, echo detection, recent plays, and rate-limit release.
// 
// Also: always update last_ping_at whenever Spotify responds, not just on change.
// This keeps the room alive even when Arun is paused (phone in pocket, not playing).
setInterval(async () => {
  for (const [code, room] of roomManager.getRoomsMap()) {
    try {
      const state = await spotifyService.getPlaybackState(room);
      const { currentlyPlaying, shuffleState } = state;

      // Keep room alive as long as Spotify session is responsive.
      // The cleanup worker reaps rooms with no ping for 5 minutes.
      // A paused host with phone locked would be reaped without this.
      runQuery(supabase.from('rooms')
        .update({ last_ping_at: new Date().toISOString() })
        .eq('room_code', code), `[rooms] failed to update last ping for ${code}`);

      const trackChanged = currentlyPlaying && room.currentTrack?.id !== currentlyPlaying.id;
      const shuffleChanged = shuffleState !== undefined && shuffleState !== room.shuffleState;

      if (trackChanged || shuffleChanged) {
        // Pass the already-fetched state so broadcastRoomState doesn't call Spotify again.
        // DO NOT update room.currentTrack here - broadcastRoomState owns that update
        // after it runs the eviction + echo + recent-plays pipeline.
        broadcastRoomState(code, state);
      }
    } catch {
      // Non-fatal - room may have no active playback or Spotify may be momentarily down
    }
  }
}, 4000);

// Worker 2: Stale room cleanup.
// Marks rooms inactive if Spotify hasn't responded in 5 minutes.
// Emits 'room_closed' so connected clients can redirect gracefully.
// Saves backlog before eviction so unheard friend drops survive session end.
setInterval(async () => {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);

  const { data: staleRooms } = await supabase
    .from('rooms')
    .update({ is_active: false })
    .eq('is_active', true)
    .lt('last_ping_at', cutoff)
    .select('room_code');

  for (const row of staleRooms || []) {
    // Save unheard drops to host's backlog before evicting the room.
    // Without this, any drops queued but not yet played silently disappear
    // when a session ends from timeout (host phone died, lost connectivity, etc).
    await roomManager.saveBacklogAndEvict(row.room_code);
    io.to(row.room_code).emit('room_closed', {
      message: 'The host has left the session.',
    });
  }
}, 5 * 60 * 1000);

// — Boot —

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Ocarina backend listening on port ${PORT}`);
  });
}

module.exports = { app, server };