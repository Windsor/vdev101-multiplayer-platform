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

function playerCtx({ state, players = baseCtx().players, me = players[0], phaseIdRef }) {
  return {
    state,
    players,
    me: { id: me.id, name: me.name, isHost: me.isHost ?? false },
    goTo(id) { phaseIdRef.value = id; },
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

test('automatically resolves to results after every player votes', () => {
  const players = baseCtx().players.slice(0, 3);
  const state = {
    ...Imposter.setup(baseCtx({ players, config: { category: 'food', imposters: 1, rounds: 1 } })),
    votes: {},
  };
  const phaseIdRef = { value: 'vote' };

  Imposter.phases.vote.actions['cast-vote'](
    playerCtx({ state, players, me: players[0], phaseIdRef }),
    players[0].id,
    { value: players[1].id }
  );
  assert.equal(phaseIdRef.value, 'vote');
  assert.equal(state.result, null);

  Imposter.phases.vote.actions['cast-vote'](
    playerCtx({ state, players, me: players[1], phaseIdRef }),
    players[1].id,
    { value: players[0].id }
  );
  assert.equal(phaseIdRef.value, 'vote');
  assert.equal(state.result, null);

  Imposter.phases.vote.actions['cast-vote'](
    playerCtx({ state, players, me: players[2], phaseIdRef }),
    players[2].id,
    { value: players[1].id }
  );

  assert.equal(phaseIdRef.value, 'results');
  assert.deepEqual(state.result.tally, { [players[1].id]: 2, [players[0].id]: 1 });
  assert.deepEqual(state.result.accused, [players[1].id]);
});

test('ignores votes for non-players so invalid ballots cannot resolve the game', () => {
  const players = baseCtx().players.slice(0, 3);
  const state = {
    ...Imposter.setup(baseCtx({ players, config: { category: 'food', imposters: 1, rounds: 1 } })),
    votes: {},
  };
  const phaseIdRef = { value: 'vote' };

  Imposter.phases.vote.actions['cast-vote'](
    playerCtx({ state, players, me: players[0], phaseIdRef }),
    players[0].id,
    { value: 'not-a-player' }
  );

  assert.deepEqual(state.votes, {});
  assert.equal(phaseIdRef.value, 'vote');
});
