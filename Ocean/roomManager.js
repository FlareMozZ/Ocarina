// roomManager.js - Room store with fair queue, chaining, and progressive rate limiting.
// 
// — Queue Fairness —
// Songs are stored per-contributor in buckets, then interleaved round-robin.
// Each contributor takes one "turn" at a time; chains (2-song bundles) count as 1 turn.
// Lock any song to fix it at its current position - locked songs are unaffected by interleaving.
// 
// Spotify constraint: the Spotify queue API only allows appending (no insertion/reorder).
// Songs are pushed to Spotify at add-time in arrival order, which may differ from our
// fair display order. Our queue view in Ocarina shows the intended fair order.
// The just-in-time queue (push one at a time) is a future upgrade path.
// 
// — Rate Limiting —
// Progressive per-friend: the more distinct friends you drop to, the fewer per friend.
// Tiers: [5, 4, 3, 3, 2, 2, 1] per Nth friend. Total cap: 20 active drops.
// "Active" = QUEUED status. Played songs free up slots.
// Tracked in module-level memory (resets on server restart - acceptable for session concept).

const supabase = require('./supabaseClient');
const crypto = require('crypto');
const { runQuery } = require('./queryUtils');

const rooms = new Map(); // roomCode -> room object

// Per-user global drop budget. Tracks drops across all rooms.
// Key: userId or socket.id. Value: { roomDrops: Map<roomCode, count>, total: number }
const userDropBudgets = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_RECENT_PLAYS = 5;

// Progressive drop tiers per Nth friend/room.
// Index 0 = first friend you drop to (up to 5 songs).
// Index 6+ = 7th friend onwards (max 1 song each).
const DROP_TIERS = [5, 4, 3, 3, 2, 2, 1];
const DROP_TOTAL_CAP = DROP_TIERS.reduce((a, b) => a + b, 0); // 20

// Room Code
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * ROOM_CODE_CHARS.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

// Room Creation
async function createOrReuseRoom(tokens, user) {
  const { data: oldRooms } = await supabase
    .from('rooms')
    .update({ is_active: false })
    .eq('host_id', user.id)
    .eq('is_active', true)
    .select('room_code');

  // Save unheard drops before closing old rooms. Without this, if a user's session
  // expires and they re-authenticate, any drops from their previous session are lost.
  for (const r of oldRooms || []) {
    const oldRoom = rooms.get(r.room_code);
    if (oldRoom) await saveBacklog(oldRoom);
    rooms.delete(r.room_code);
  }

  const code = generateRoomCode();
  const { data: dbRoom, error } = await supabase
    .from('rooms')
    .insert({
      host_id: user.id,
      room_code: code,
      is_active: true,
      current_track: {},
      recent_plays: [],
      shuffle_state: false,
      last_ping_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create room: ${error.message}`);

  const room = buildRoomObject(dbRoom, tokens, user.id);
  rooms.set(code, room);
  return room;
}

// Room Lookup
async function getRoom(code) {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (rooms.has(upper)) return rooms.get(upper);

  const { data: dbRoom } = await supabase
    .from('rooms')
    .select('id, host_id, room_code')
    .eq('room_code', upper)
    .eq('is_active', true)
    .single();

  if (!dbRoom) return null;

  const { data: tokenData } = await supabase
    .from('spotify_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', dbRoom.host_id)
    .single();

  if (!tokenData) return null;

  const tokens = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(tokenData.expires_at).getTime(),
  };

  const room = buildRoomObject(dbRoom, tokens, dbRoom.host_id);
  rooms.set(upper, room);
  return room;
}

function getRoomFromCache(code) {
  return rooms.get(code?.toUpperCase()) || null;
}

function getRoomsMap() { return rooms; }

// Room Deactivation
async function deactivateRoom(roomCode) {
  const upper = roomCode.toUpperCase();
  const room = rooms.get(upper);
  if (room) {
    await saveBacklog(room);
    rooms.delete(upper);
  }
  await supabase.from('rooms').update({ is_active: false }).eq('room_code', upper);
}

async function deactivateRoomForHost(hostId) {
  const { data } = await supabase
    .from('rooms')
    .update({ is_active: false })
    .eq('host_id', hostId)
    .eq('is_active', true)
    .select('room_code');

  for (const r of data || []) {
    const room = rooms.get(r.room_code);
    if (room) await saveBacklog(room);
    rooms.delete(r.room_code);
  }
}

// Rate Limiting
/**
 * Check whether a user is allowed to drop a song into a specific room.
 * Returns { allowed: bool, reason?: string, limit?: number, current?: number }
 * 
 * Logic:
 *  - Max DROP_TOTAL_CAP (20) active drops across ALL ROOMS.
 *  - Per room (per friend): allowed drops = DROP_TIERS[N] where N = how many
 *    distinct rooms this user has already dropped to (0-indexed).
 *  - "Active" means the song hasn't played yet (status QUEUED).
 *  - Once it plays, the slot frees up -> so active listening = active budget.
 */
function checkDropAllowed(contributorKey, roomCode) {
  if (!userDropBudgets.has(contributorKey)) {
    userDropBudgets.set(contributorKey, { roomDrops: new Map(), total: 0 });
  }
  const budget = userDropBudgets.get(contributorKey);

  // Total cap across all friends
  if (budget.total >= DROP_TOTAL_CAP) {
    return { allowed: false, reason: 'total_cap', limit: DROP_TOTAL_CAP };
  }

  // Per-friend (per-room) tier
  let roomIndex = [...budget.roomDrops.keys()].indexOf(roomCode);
  if (roomIndex === -1) {
    roomIndex = budget.roomDrops.size;
    budget.roomDrops.set(roomCode, 0);
  }

  const tierLimit = DROP_TIERS[Math.min(roomIndex, DROP_TIERS.length - 1)];
  const current = budget.roomDrops.get(roomCode);

  if (current >= tierLimit) {
    return { allowed: false, reason: 'per_friend_cap', limit: tierLimit, current };
  }

  // Allow: increment counters
  budget.roomDrops.set(roomCode, current + 1);
  budget.total++;
  return { allowed: true, limit: tierLimit, current: current + 1 };
}

/**
 * Free up a drop slot when a song plays (or is skipped).
 * Called from the broadcast worker when status transitions QUEUED -> PLAYED/SKIPPED.
 */
function releaseDropsSlot(contributorKey, roomCode) {
  const budget = userDropBudgets.get(contributorKey);
  if (!budget) return;
  const current = budget.roomDrops.get(roomCode) || 0;
  if (current > 0) budget.roomDrops.set(roomCode, current - 1);
  if (budget.total > 0) budget.total--;
}

// Queue Operations

/**
 * Add a single track from a contributor.
 * Songs go into the contributor's bucket and are interleaved fair into the display queue.
 * The fair display order ≠ Spotify playback order (Spotify only allows append).
 * @param {string|null} chainId - If part of a chain, the shared chain UUID, null otherwise.
 * @param {number|null} chainOrder - 0 for first in chain, 1 for second.
 */
function addTrackToRoomQueue(room, track, addedByName, addedByUserId = null, chainId = null, chainOrder = null) {
  const item = {
    id: `${(track.id)}-${Date.now()}`,
    track,
    addedBy: addedByName,
    addedByUserId,
    votes: 0,
    voters: new Set(),
    addedAt: Date.now(),
    locked: false,
    chainId,
    chainOrder,
  };

  const bucketKey = addedByUserId || addedByName;
  if (!room.contributorBuckets.has(bucketKey)) {
    room.contributorBuckets.set(bucketKey, []);
  }
  room.contributorBuckets.get(bucketKey).push(item);

  recomputeDisplayQueue(room);
  return item;
}

// Lock or unlock any queue item (host only, any song regardless of who added it).
// Locked items are fixed at their current positions.
// The rest of the queue reflows around them.
function lockQueueItem(room, itemId) {
  // Search both display queue and contributor buckets
  const item = room.customQueue.find((i) => i.id === itemId);
  if (!item) return false;
  item.locked = !item.locked;

  // Also update the copy in the contributor's bucket
  const bucketKey = item.addedByUserId || item.addedBy;
  const bucket = room.contributorBuckets.get(bucketKey);
  if (bucket) {
    const bucketItem = bucket.find((i) => i.id === itemId);
    if (bucketItem) bucketItem.locked = item.locked;
  }

  recomputeDisplayQueue(room);
  return true;
}

// Toggle vote on an unlocked queue item.
// Votes reorder items within each contributor's bucket, then the display queue
// is recomputed from the reordered buckets.
function voteTrack(room, itemId, socketId) {
  const item = room.customQueue.find((i) => i.id === itemId);
  if (!item || item.locked) return false;

  if (item.voters.has(socketId)) {
    item.voters.delete(socketId);
    item.votes--;
  } else {
    item.voters.add(socketId);
    item.votes++;
  }

  // Reorder within the contributor's bucket (higher-voted songs play sooner for that contributor)
  const bucketKey = item.addedByUserId || item.addedBy;
  const bucket = room.contributorBuckets.get(bucketKey);
  if (bucket) {
    bucket.sort((a, b) => b.votes - a.votes || a.addedAt - b.addedAt);
  }

  recomputeDisplayQueue(room);
  return true;
}

// Evict a played track from both the display queue and all contributor buckets.
// Returns the contributor key so the caller can free the rate-limit slot.
function evictPlayedTrack(room, trackUri) {
  let contributorKey = null;

  for (const [key, bucket] of room.contributorBuckets) {
    const idx = bucket.findIndex((i) => i.track.uri === trackUri);
    if (idx !== -1) {
      contributorKey = key;
      bucket.splice(idx, 1);
      if (bucket.length === 0) room.contributorBuckets.delete(key);
      break;
    }
  }

  room.customQueue = room.customQueue.filter((i) => i.track.uri !== trackUri);
  return contributorKey;
}

// Add to the recent plays ring buffer.
function pushToRecentPlays(room, completedTrack) {
  if (!completedTrack) return;
  room.recentPlays.unshift(completedTrack);
  room.recentPlays = room.recentPlays.slice(0, MAX_RECENT_PLAYS);
}

// — Display Queue Computation (the Fair Interleaving Engine) —
// Rebuild the flat display queue from contributor buckets using round-robin.
// Algorithm:
//  1. Locked items keep their current positions (they're fixed anchors).
//  2. Unlocked items are re-interleaved from contributor buckets in round-robin.
//  3. Chains (chainId not null) are treated as a single turn in round-robin -
//     both songs advance together, playing back to back.
// Why buckets, not position-based insertion:
//  - Position-based insertion requires O(N) scans per add and breaks when
//    songs are removed (played). Buckets give a clean O(N) recompute on any change.

function recomputeDisplayQueue(room) {
  // Preserve locked items in their current display positions
  const locked = room.customQueue.filter((i) => i.locked);

  // Build round-robin interleaved sequence from unlocked items only
  // Each bucket is already vote-sorted within itself
  const bucketIterators = [...room.contributorBuckets.values()]
    .map((b) => b.filter((i) => !i.locked)); // Skip locked items from buckets

  const interleaved = [];
  let anyLeft = true;

  while (anyLeft) {
    anyLeft = false;
    for (const bucket of bucketIterators) {
      if (bucket.length === 0) continue;
      anyLeft = true;

      // If this starts a chain, immediately take the chained partner too (1 turn for the pair)
      const item = bucket.shift();
      interleaved.push(item);
      if (item.chainId !== null && bucket.length > 0 && bucket[0].chainId === item.chainId) {
        interleaved.push(bucket.shift());
      }
    }
  }

  // Reinsert locked items at their original index positions in the interleaved sequence.
  // Sort locked by their position in the last known display queue.
  const lockedWithPositions = locked.map((li) => ({
    item: li,
    pos: room.customQueue.findIndex((qi) => qi.id === li.id),
  })).sort((a, b) => a.pos - b.pos);

  const result = [...interleaved];
  for (const { item, pos } of lockedWithPositions) {
    // Clamp position to valid range in the new array
    const insertAt = Math.min(pos, result.length);
    result.splice(insertAt, 0, item);
  }

  room.customQueue = result;
}

// — Backlog —

/**
 * Save unheard drops to backlog, then remove the room from the in-memory cache.
 * Used by the cleanup worker for timeout-closed rooms (where DB is already set inactive).
 * Avoids a double Supabase write for is_active since the worker already handled it.
 */
async function saveBacklogAndEvict(roomCode) {
  const upper = roomCode.toUpperCase();
  const room = rooms.get(upper);
  if (room) {
    await saveBacklog(room);
    rooms.delete(upper);
  }
}

async function saveBacklog(room) {
  if (!room.id || !room.hostId) return;

  // Include guest drops (sender_id IS NULL) alongside friend drops.
  // SQL: `sender_id != hostid` evaluates to NULL when sender_id is NULL,
  // which is falsy - so a plain .neq() silently excludes all guest drops.
  const { data: pendingDrops } = await supabase
    .from('track_drops')
    .select(`
      id, spotify_uri, title, artist, album_art, created_at, sender_id, guest_name, chain_id, chain_order,
      sender:profiles!track_drops_sender_id_fkey(username)
    `)
    .eq('room_id', room.id)
    .eq('status', 'QUEUED')
    .or(`sender_id.is.null,sender_id.neq.${room.hostId}`);

  if (!pendingDrops?.length) return;

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  await runQuery(supabase.from('backlogs').insert(
    pendingDrops.map((d) => ({
      host_id: room.hostId,
      spotify_uri: d.spotify_uri,
      title: d.title,
      artist: d.artist,
      album_art: d.album_art || null,
      dropped_by_name: d.sender?.username || d.guest_name || 'Someone',
      dropped_by_id: d.sender_id || null,
      dropped_at: d.created_at,
      session_room_code: room.code,
      chain_id: d.chain_id || null,
      chain_order: d.chain_order ?? null,
      expires_at: expiresAt,
    }))
  ), '[roomManager] backlog save failed');
}

// — Internal Helpers —

function buildRoomObject(dbRoom, tokens, hostId) {
  return {
    id: dbRoom.id,
    code: dbRoom.room_code,
    hostId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    guests: new Map(),                          // socketId -> { name, userId }
    customQueue: [],                            // Flat display queue (fair interleaved order)
    contributorBuckets: new Map(),              // contributorKey -> [TrackItem...] (round-robin source)
    currentTrack: null,
    recentPlays: [],                            // Last N completed tracks (vibe context)
    shuffleState: false,                        // Mirrors Spotify's shuffle state
  };
}

module.exports = {
  generateRoomCode,
  createOrReuseRoom,
  getRoom,
  getRoomFromCache,
  getRoomsMap,
  deactivateRoom,
  deactivateRoomForHost,
  saveBacklogAndEvict,
  addTrackToRoomQueue,
  lockQueueItem,
  voteTrack,
  evictPlayedTrack,
  pushToRecentPlays,
  checkDropAllowed,
  releaseDropsSlot,
};