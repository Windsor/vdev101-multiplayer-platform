const test = require('node:test');
const assert = require('node:assert/strict');
const Imposter = require('../games/imposter');

function baseCtx(overrides = {}) {
  const players = [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
    { id: 'c', name: 'Carol' },
    { id: 'd', name: 'Drew' },
  ];
  return {
    players,
    config: { category: 'food', imposters: 1 },
    shuffle: (items) => items.slice().reverse(),
    randomFrom: (items) => items[0],
    ...overrides,
  };
}

test('sets up one imposter, one shared secret, and a turn order', () => {
  const state = Imposter.setup(baseCtx());

  assert.equal(state.secret, 'Pizza');
  assert.equal(state.category, 'Food');
  assert.equal(state.imposterIds.length, 1);
  assert.equal(state.order.length, 4);
  assert.deepEqual(new Set(state.order), new Set(['a', 'b', 'c', 'd']));
});

test('never assigns more imposters than players minus two', () => {
  const state = Imposter.setup(baseCtx({ config: { category: 'food', imposters: 10 } }));

  assert.equal(state.imposterIds.length, 2);
});

test('keeps private role views private per player', () => {
  const state = Imposter.setup(baseCtx());
  const player = { id: state.imposterIds[0], name: 'Drew', isHost: false };
  const view = Imposter.phases.reveal.getView({
    state,
    me: player,
    players: baseCtx().players,
  });

  const card = view.find((section) => section.type === 'role-card');
  assert.equal(card.value, 'IMPOSTER');
  assert.equal(card.description.includes(state.secret), false);
});
