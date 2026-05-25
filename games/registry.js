/**
 * Game registry. Add a new game by requiring it here.
 * Each game module exports a definition implementing setup(), getView()
 * per phase, and action handlers. See ./imposter.js for the canonical example.
 */
const imposter = require('./imposter');

const games = [imposter];

module.exports = {
  list: () => games.slice(),
  byId: (id) => games.find((g) => g.id === id) || null,
};
