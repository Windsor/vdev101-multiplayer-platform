/**
 * Smoke test: walks 3 simulated players through a full Imposter game.
 * Run while the server is up: `node server.js` in one terminal, then
 * `PORT=8765 node smoke.js` in another. Exits 0 on success.
 */
const WebSocket = require('ws');

const PORT = process.env.PORT || 8765;
const URL = `ws://localhost:${PORT}`;

function makeClient(name) {
  const ws = new WebSocket(URL);
  const state = {
    name,
    code: null,
    playerId: null,
    lastView: null,
    inbox: [],
  };
  return new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      state.inbox.push(msg);
      if (msg.type === 'identity') {
        state.code = msg.code;
        state.playerId = msg.playerId;
      } else if (msg.type === 'view') {
        state.lastView = msg.view;
      }
    });
    ws.on('open', () => resolve({ ws, state }));
    ws.on('error', reject);
  });
}

const send = (c, msg) => c.ws.send(JSON.stringify(msg));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until predicate(state.lastView) is truthy or timeout.
async function waitFor(client, predicate, label) {
  for (let i = 0; i < 50; i++) {
    if (client.state.lastView && predicate(client.state.lastView)) return;
    await wait(20);
  }
  throw new Error(`Timeout waiting for: ${label}\nLast view: ${JSON.stringify(client.state.lastView, null, 2)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓', msg);
}

async function main() {
  console.log('Connecting 3 clients…');
  const a = await makeClient('Alice');
  const b = await makeClient('Bob');
  const c = await makeClient('Carol');

  // Wait for home view
  await waitFor(a, (v) => v.screen === 'home', 'Alice home');

  console.log('\n— Create room as Alice —');
  send(a, { type: 'create', name: 'Alice', gameId: 'imposter' });
  await waitFor(a, (v) => v.screen === 'lobby', 'Alice lobby');
  const code = a.state.code;
  assert(code && code.length === 4, `room code is 4 chars: ${code}`);
  assert(a.state.lastView.me.isHost, 'Alice is host');

  console.log('\n— Bob & Carol join —');
  send(b, { type: 'join', name: 'Bob', code });
  send(c, { type: 'join', name: 'Carol', code });
  await waitFor(a, (v) => v.players.length === 3, '3 players in lobby');
  assert(a.state.lastView.canStart === true, 'host can start with 3 players');

  console.log('\n— Host starts game —');
  send(a, { type: 'start' });
  await waitFor(a, (v) => v.screen === 'playing', 'game playing');
  await waitFor(b, (v) => v.screen === 'playing', 'Bob playing');
  await waitFor(c, (v) => v.screen === 'playing', 'Carol playing');

  // Determine who is the imposter based on the role-card values.
  function rolesOf(client) {
    const card = (client.state.lastView.sections || []).find((s) => s.type === 'role-card');
    return card;
  }
  const cards = [rolesOf(a), rolesOf(b), rolesOf(c)];
  const imposters = cards.filter((c) => c.value === 'IMPOSTER');
  const villagers = cards.filter((c) => c.value !== 'IMPOSTER');
  assert(imposters.length === 1, 'exactly one imposter assigned');
  assert(villagers.length === 2, 'two villagers');
  // All villagers see the same word
  const villagerWords = new Set(villagers.map((c) => c.value));
  assert(villagerWords.size === 1, 'villagers see the same secret word');
  console.log('  ↪ Secret was', [...villagerWords][0]);

  console.log('\n— All players ready —');
  send(a, { type: 'action', actionId: 'ready' });
  send(b, { type: 'action', actionId: 'ready' });
  send(c, { type: 'action', actionId: 'ready' });
  await waitFor(a, (v) => v.phaseId === 'clues', 'advanced to clues');

  console.log('\n— Players give clues across configured rounds —');
  // Walk turn order for all configured clue rounds: each turn, find the client whose turn it is and submit.
  const clueTurns = 3 * 2; // default is 2 rounds for 3 simulated players
  for (let i = 0; i < clueTurns; i++) {
    // Find which client is currently being asked for a clue
    const all = [a, b, c];
    let actor = null;
    for (const cl of all) {
      const sections = cl.state.lastView.sections || [];
      const hasForm = sections.some((s) => s.type === 'form' && s.actionId === 'submit-clue');
      if (hasForm) { actor = cl; break; }
    }
    assert(actor, `someone has the clue form (round ${i + 1})`);
    send(actor, { type: 'action', actionId: 'submit-clue', payload: { text: `clue${i + 1}` } });
    await waitFor(actor, (v) => {
      const sects = v.sections || [];
      // After submitting, this player should NOT have the form anymore
      return !sects.some((s) => s.type === 'form' && s.actionId === 'submit-clue');
    }, `clue ${i + 1} submitted`);
  }

  console.log('\n— Host moves to vote —');
  send(a, { type: 'action', actionId: 'to-vote' });
  await waitFor(a, (v) => v.phaseId === 'vote', 'voting started');

  console.log('\n— Everyone votes for Bob —');
  send(a, { type: 'action', actionId: 'cast-vote', payload: { value: b.state.playerId } });
  send(b, { type: 'action', actionId: 'cast-vote', payload: { value: a.state.playerId } });
  send(c, { type: 'action', actionId: 'cast-vote', payload: { value: b.state.playerId } });
  console.log('\n— Final vote auto-resolves —');
  await waitFor(a, (v) => v.phaseId === 'results', 'results phase reached');
  await waitFor(b, (v) => v.phaseId === 'results', 'Bob sees results');
  await waitFor(c, (v) => v.phaseId === 'results', 'Carol sees results');

  // Verify results header is one of the expected strings
  const header = (a.state.lastView.sections || []).find((s) => s.type === 'header');
  assert(/imposter/i.test(header.text) || /tie/i.test(header.text), `result header set: "${header.text}"`);

  console.log('\nALL ASSERTIONS PASSED ✅');
  a.ws.close(); b.ws.close(); c.ws.close();
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
