// socket/handlers.js - Real-time event handlers.
// 
// Design: the host is the PASSIVE side (walks, listens, phone in pocket).
// Friends are the ACTIVE side (they read the vibe, they choose, they drop).
// Nothing interrupts the host during listening.
// 
// Events inbound:
//  join_room        { roomCode, userName, userId }
//  host_connect     { roomCode, userId }
//  add_to_queue     { roomCode, track, userName, userId }
//  add_chain        { roomCode, tracks: [track, track], userName, userId }
//  vote_track       { roomCode, itemId }
//  lock_queue_item  { roomCode, itemId, hostUserId }
//  leave_room       { roomCode }
//  disconnect
// 
// Events outbound:
//  room_state_update { roomCode, guestCount, currentlyPlaying, queue, recentPlays, shuffleState }
//  track_echoed      { dropId, artist }   - ambient signal, no host action needed
//  room_closed       { message }
//  error_message     { code, message }

const crypto = require('crypto');
const roomManager = require('../roomManager');
const spotifyService = require('../spotifyService');
const supabase = require('../supabaseClient');
const { getPastelColor } = require('../colorUtils');
const { runQuery } = require('../queryUtils');

function setupSocketHandlers(io) {

  async function broadcastRoomState(roomCode, preloadedState = null) {
    const room = roomManager.getRoomFromCache(roomCode);
    if (!room) return;

    try {
      const { currentlyPlaying, shuffleState } = preloadedState
        || await spotifyService.getPlaybackStatus(room);
      const previousTrack = room.currentTrack;
      const shuffleChanged = shuffleState !== room.shuffleState;

      // Song change detected
      if (currentlyPlaying && previousTrack?.id !== currentlyPlaying.id) {

        // 1. Push completed track to recent plays (vibe context for bandwagon friends)
        roomManager.pushToRecentPlays(room, previousTrack);

        // 2. Mark drop as PLAYED and release the rate-limit slot for that contributor
        if (previousTrack && room.id) {
          const contributorKey = roomManager.evictPlayedTrack(room, previousTrack.uri);
          if (contributorKey) {
            roomManager.releaseDropsSlot(contributorKey, roomCode);
          }

          runQuery(supabase.from('track_drops')
            .update({ status: 'PLAYED' })
            .eq('room_id', room.id)
            .eq('spotify_uri', previousTrack.uri)
            .eq('status', 'QUEUED'), '[socket] failed to mark played drop');
        }

        // 3. Echo detection - passive ambient feedback signal.
        // If the new song's primary artist matches the artist of any PLAYED drop in this
        // session, the host chose to keep going with that artist on their own. Mark it.
        if (room.id && currentlyPlaying.artist) {
          const primaryArtist = currentlyPlaying.artist.split(',')[0].trim();

          supabase.from('track_drops')
            .update({ was_echoed: true })
            .eq('room_id', room.id)
            .eq('status', 'PLAYED')
            .eq('was_echoed', false)
            .ilike('artist', `%${primaryArtist}%`) // Match primary artist
            .select('id, artist')
            .then(({ data, error }) => {
              if (error) {
                console.error('[socket] failed to mark echoed drops:', error.message);
                return;
              }
              if (data?.length) {
                // Notify the room so the dropper sees the echo live if they're watching
                io.to(roomCode).emit('track_echoed', {
                  echoed: data.map((d) => d.id),
                  artist: primaryArtist,
                });
              }
            }, (error) => console.error('[socket] failed to detect echoed drops:', error.message));
        }

        room.currentTrack = currentlyPlaying;
      }

      // 4. Persist recent plays and current track to Supabase
      // (friends list reads this to show vibe context without joining the room)
      if (room.id) {
        runQuery(supabase.from('rooms').update({
          current_track: currentlyPlaying,
          recent_plays: room.recentPlays,
          last_ping_at: new Date().toISOString(),
        }).eq('room_code', roomCode), `[socket] failed to persist room state for ${roomCode}`);
      }

      // Shuffle state sync
      if (shuffleChanged) {
        room.shuffleState = shuffleState;
        if (room.id) {
          runQuery(supabase.from('rooms').update({ shuffle_state: shuffleState })
            .eq('room_code', roomCode), `[socket] failed to persist shuffle state for ${roomCode}`);
        }
      }

      io.to(roomCode).emit('room_state_update', {
        roomCode,
        guestCount: room.guests.size,
        currentlyPlaying,
        shuffleState: room.shuffleState,
        recentPlays: room.recentPlays,
        queue: room.customQueue.map((item) => ({
          id: item.id,
          track: item.track,
          addedBy: item.addedBy,
          addedByColor: getPastelColor(item.addedBy),
          votes: item.votes,
          locked: item.locked,
          chainId: item.chainId,
          chainOrder: item.chainOrder,
        })),
      });
    } catch (err) {
      console.error(`[socket] broadcastRoomState error for ${roomCode}:`, err.message);
    }
  }

  // Connection
  io.on('connection', (socket) => {

    // -- join_room
    socket.on('join_room', async ({ roomCode, userName, userId }) => {
      if (!roomCode) return;
      const room = await roomManager.getRoom(roomCode.toUpperCase());
      if (!room) {
        socket.emit('error_message', { code: 'ROOM_NOT_FOUND', message: 'Room not found or no longer active' });
        return;
      }
      socket.join(room.code);
      room.guests.set(socket.id, { name: userName, userId: userId || null });
      broadcastRoomState(room.code);
    });

    // -- host_connect
    socket.on('host_connect', async ({ roomCode, userId }) => {
      if (!roomCode || !userId) return;
      const room = await roomManager.getRoom(roomCode.toUpperCase());
      if (!room || room.hostId !== userId) {
        socket.emit('error_message', { code: 'UNAUTHORIZED', message: 'Room not found or not yours' });
        return;
      }
      socket.join(room.code);
      broadcastRoomState(room.code);
    });

    // -- add_to_queue
    socket.on('add_to_queue', async ({ roomCode, track, userName, userId }) => {
      if (!roomCode || !track?.uri) return;
      const room = await roomManager.getRoom(roomCode.toUpperCase());
      if (!room) {
        socket.emit('error_message', { code: 'ROOM_NOT_FOUND', message: 'Room not found' });
        return;
      }

      const key = userId || socket.id;
      const check = roomManager.checkDropAllowed(key, room.code);
      if (!check.allowed) {
        const msg = check.reason === 'total_cap'
          ? 'You have reached the session maximum of 20 drops across all friends. Give it a rest! 🎵'
          : `You have added ${check.limit} songs to this queue this session - someone else's turn! 🎵`;
        socket.emit('error_message', { code: 'DROP_LIMIT_REACHED', message: msg });
        return;
      }

      try {
        await spotifyService.addTrackToSpotifyQueue(room, track.uri);
        roomManager.addTrackToRoomQueue(room, track, userName || 'Guest', userId || null);

        if (room.id) {
          const payload = {
            room_id: room.id,
            receiver_id: room.hostId,
            spotify_uri: track.uri,
            title: track.title,
            artist: track.artist,
            album_art: track.albumArt || null,
            status: 'QUEUED',
          };
          if (userId) payload.sender_id = userId;
          else payload.guest_name = userName || 'Guest';

          runQuery(supabase.from('track_drops').insert(payload), '[socket] track_drops insert failed');
        }

        broadcastRoomState(room.code);
      } catch (err) {
        // Undo the rate limit slot since the Spotify add failed
        roomManager.releaseDropsSlot(key, room.code);
        console.error('[socket] add_to_queue error:', err.message);
        socket.emit('error_message', { code: 'QUEUE_FAILED', message: 'Failed to add track to Spotify queue' });
      }
    });

    // -- add_chain
    // Drop 2 songs as a bundle. They appear together in the queue and take 1 turn
    // in the round-robin - so your 2-song intention is preserved, not split by others.
    // Both are pushed to Spotify back-to-back (they WILL play consecutively in Spotify).
    socket.on('add_chain', async ({ roomCode, tracks, userName, userId }) => {
      if (!roomCode || !Array.isArray(tracks) || tracks.length !== 2) {
        socket.emit('error_message', { code: 'INVALID_CHAIN', message: 'A chain requires exactly 2 songs' });
        return;
      }
      if (!tracks[0]?.uri || !tracks[1]?.uri) return;

      const room = await roomManager.getRoom(roomCode.toUpperCase());
      if (!room) {
        socket.emit('error_message', { code: 'ROOM_NOT_FOUND', message: 'Room not found' });
        return;
      }

      const key = userId || socket.id;

      // A chain costs 2 drops (one per song) from the budget
      const check1 = roomManager.checkDropAllowed(key, room.code);
      if (!check1.allowed) {
        socket.emit('error_message', { code: 'DROP_LIMIT_REACHED', message: 'Not enough drop budget for a chain' });
        return;
      }

      const check2 = roomManager.checkDropAllowed(key, room.code);
      if (!check2.allowed) {
        // Undo the first check
        roomManager.releaseDropsSlot(key, room.code);
        socket.emit('error_message', { code: 'DROP_LIMIT_REACHED', message: 'Not enough drop budget for both songs in the chain' });
        return;
      }

      try {
        const chainId = crypto.randomUUID();

        for (let i = 0; i < 2; i++) {
          await spotifyService.addTrackToSpotifyQueue(room, tracks[i].uri);
          roomManager.addTrackToRoomQueue(room, tracks[i], userName || 'Guest', userId || null, chainId, i);

          if (room.id) {
            const payload = {
              room_id: room.id,
              receiver_id: room.hostId,
              spotify_uri: tracks[i].uri,
              title: tracks[i].title,
              artist: tracks[i].artist,
              album_art: tracks[i].albumArt || null,
              chain_id: chainId,
              chain_order: i,
              status: 'QUEUED',
            };
            if (userId) payload.sender_id = userId;
            else payload.guest_name = userName || 'Guest';

            runQuery(supabase.from('track_drops').insert(payload), '[socket] chained track_drops insert failed');
          }
        }

        broadcastRoomState(room.code);
      } catch (err) {
        roomManager.releaseDropsSlot(key, room.code);
        roomManager.releaseDropsSlot(key, room.code);
        console.error('[socket] add_chain error:', err.message);
        socket.emit('error_message', { code: 'QUEUE_FAILED', message: 'Failed to add chain to Spotify queue' });
      }
    });

    // -- vote_track
    socket.on('vote_track', ({ roomCode, itemId }) => {
      if (!roomCode || !itemId) return;
      const room = roomManager.getRoomFromCache(roomCode.toUpperCase());
      if (!room) {
        socket.emit('error_message', { code: 'ROOM_NOT_FOUND', message: 'Room not in active session' });
        return;
      }
      if (roomManager.voteTrack(room, itemId, socket.id)) {
        broadcastRoomState(room.code);
      }
    });

    // -- lock_queue_item
    // Universal lock: host can lock/unlock ANY song regardless of who added it.
    // Locked songs are anchored at their current position in the display queue.
    socket.on('lock_queue_item', ({ roomCode, itemId, hostUserId }) => {
      if (!roomCode || !itemId) return;
      const room = roomManager.getRoomFromCache(roomCode.toUpperCase());
      if (!room) return;
      if (room.hostId !== hostUserId) {
        socket.emit('error_message', { code: 'UNAUTHORIZED', message: 'Only the host can lock queue items' });
        return;
      }
      if (roomManager.lockQueueItem(room, itemId)) {
        broadcastRoomState(room.code);
      }
    });

    // -- leave_room
    socket.on('leave_room', ({ roomCode }) => {
      if (!roomCode) return;
      const code = roomCode.toUpperCase();
      socket.leave(code);
      const room = roomManager.getRoomFromCache(code);
      if (room?.guests.has(socket.id)) {
        room.guests.delete(socket.id);
        broadcastRoomState(code);
      }
    });

    // -- disconnect
    socket.on('disconnect', () => {
      for (const [code, room] of roomManager.getRoomsMap()) {
        if (room.guests.has(socket.id)) {
          room.guests.delete(socket.id);
          broadcastRoomState(code);
        }
      }
    });

  });

  return { broadcastRoomState };
}

module.exports = { setupSocketHandlers };