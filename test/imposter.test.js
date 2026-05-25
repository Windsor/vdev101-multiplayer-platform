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

test('defaults to two clue rounds and clamps configured rounds to three', () => {
  assert.equal(Imposter.setup(baseCtx()).rounds, 2);
  assert.equal(
    Imposter.setup(baseCtx({ config: { category: 'food', imposters: 1, rounds: 99 } })).rounds,
    3
  );
});

test('requires all players to clue twice by default before vote can start', () => {
  const players = baseCtx().players;
  const state = Imposter.setup(baseCtx());
  const host = { id: players[0].id, name: players[0].name, isHost: true };
  let phaseId = 'clues';
  const ctx = {
    state,
    players,
    me: host,
    goTo(id) { phaseId = id; },
  };

  for (const playerId of state.order) {
    Imposter.phases.clues.actions['submit-clue'](ctx, playerId, { text: `round1-${playerId}` });
  }

  assert.equal(state.currentRound, 2);
  assert.equal(state.currentClueGiver, 0);
  assert.equal(phaseId, 'clues');

  let hostView = Imposter.phases.clues.getView(ctx);
  assert.equal(hostView.some((section) => section.actionId === 'to-vote'), false);

  for (const playerId of state.order) {
    Imposter.phases.clues.actions['submit-clue'](ctx, playerId, { text: `round2-${playerId}` });
  }

  hostView = Imposter.phases.clues.getView(ctx);
  assert.equal(hostView.some((section) => section.actionId === 'to-vote'), true);
  assert.equal(state.clues.length, players.length * 2);
});
