const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function clientSource() {
  return fs.readFileSync(path.join(__dirname, '../public/js/client.js'), 'utf8');
}

test('client includes an SMS invite link in the lobby', () => {
  const source = clientSource();

  assert.match(source, /sms:\?&body=/);
  assert.match(source, /Join my Imposter Who\?/);
  assert.match(source, /Room code:/);
});

test('SMS invite body includes a join URL with the room code query parameter', () => {
  const source = clientSource();

  assert.match(source, /function inviteUrl\(code\)/);
  assert.match(source, /url\.searchParams\.set\('code', code\)/);
  assert.match(source, /Open \$\{inviteUrl\(code\)\}/);
});

test('home join form pre-populates room code from invite URL query parameter', () => {
  const source = clientSource();

  assert.match(source, /function invitedRoomCode\(\)/);
  assert.match(source, /new URLSearchParams\(location\.search\)/);
  assert.match(source, /value="\$\{esc\(invitedCode\)\}"/);
});
