// routes/search.js - Spotify track search.
// 
// No authentication required - guests need to search too.
// If a room code is provided, searches using the host's OAuth token (richer results,
// personalised for the host's market). Falls back to client_credentials (public catalog).

const express = require('express');
const router = express.Router();

const spotifyService = require('../spotifyService');
const roomManager = require('../roomManager');

router.get('/', async (req, res) => {
  const { roomCode, q } = req.query;

  if (!q?.trim()) return res.status(400).json({ error: 'Search query is required' });

  try {
    let results;
    if (roomCode) {
      // Use host's authenticated token - better search quality (market, personalisation)
      const room = await roomManager.getRoom(roomCode.trim().toUpperCase());
      results = room
        ? await spotifyService.searchTracks(room, q)
        : await spotifyService.searchCatalogTracks(q);
    } else {
      results = await spotifyService.searchCatalogTracks(q);
    }

    res.json(results);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;