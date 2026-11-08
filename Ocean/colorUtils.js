// Deterministic pastel color generation from a username string.
// 
// Uses djb2 hash to map any username to a consistent hue.
// HSL parameters are fixed to the pastel range: S=50%, L=78%.
// Same username always produces the same color - no DB storage needed.
// The frontend can call getPastelColor(username) at any time and get the same result.

// djb2 hash - fast, good distribution, no dependencies.

function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // Bitwise operations wrap at 32 bits; Math.abs avoids negative values
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return Math.abs(hash >>> 0); // Unsigned right-shift forces positive 32-bit int
}

/**
 * Returns an HSL CSS string for the given username.
 * Example: "arun" -> "hsl(214, 50%, 78%)"
 * 
 * Pastel range:
 *  - Saturation: 50% - muted enough to not be harsh, vivid enough to be distinct
 *  - Lightness: 78% - bright pastel, readable as a banner background
 */
function getPastelColor(username) {
  const hue = djb2Hash((username || 'guest').toLowerCase()) % 360;
  return `hsl(${hue}, 50%, 78%)`;
}

/**
 * Returns HSL components as separate values for frontend flexibility
 * (e.g., constructing rgba for transparency effects).
 */
function getPastelColorComponents(username) {
  const hue = djb2Hash((username || 'guest').toLowerCase()) % 360;
  return { h: hue, s: 50, l: 78 };
}

module.exports = { getPastelColor, getPastelColorComponents };