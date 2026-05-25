const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('client includes an SMS invite link in the lobby', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/client.js'), 'utf8');

  assert.match(source, /sms:\?&body=/);
  assert.match(source, /Join my Imposter Who\?/);
  assert.match(source, /Room code:/);
});
