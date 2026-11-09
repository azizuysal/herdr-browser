const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAgent, pasteText } = require('../runtime/native-agent.cjs');

test('a single live project agent receives an unbound selection', () => {
  const agent = { address: 't1' };
  assert.equal(chooseAgent({}, [agent]), agent);
});
test('multiple project agents require an explicit selection', () => {
  assert.throws(() => chooseAgent({}, [{ address: 't1' }, { address: 't2' }]), /Several agents/);
});
test('an explicit binding chooses its target even with other project agents', () => {
  assert.equal(chooseAgent({ agent: 't2' }, [{ address: 't1' }, { address: 't2' }]).address, 't2');
});
test('a stale or cross-project binding never falls back to another agent', () => {
  assert.throws(() => chooseAgent({ agent: 't2' }, [{ address: 't1' }]), /no longer running/);
});
test('no project agent produces an actionable error', () => {
  assert.throws(() => chooseAgent({}, []), /No live agent/);
});
test('empty and oversized selections are rejected before opening a connection', () => {
  assert.throws(() => pasteText({}, '\x1b\r'), /must contain text/);
  assert.throws(() => pasteText({}, 'a'.repeat(128 * 1024 + 1)), /128 KiB/);
});

test('browser profile environment never redirects native Herdr to a separate core', () => {
  const { nativeEnvironment } = require('../runtime/native-agent.cjs');
  const env = nativeEnvironment({nativeEnv:{HC_SOCKET:'/native/core.sock',XDG_STATE_HOME:'/native/state'}}, {HC_SOCKET:'/browser/core.sock',XDG_STATE_HOME:'/browser/state',XDG_RUNTIME_DIR:'/browser/runtime',XDG_CONFIG_HOME:'/browser/config',HC_SESSION:'private',HOME:'/unchanged'});
  assert.equal(env.HC_SOCKET,'/native/core.sock');
  assert.equal(env.XDG_STATE_HOME,'/native/state');
  assert.equal(env.HOME,'/unchanged');
  for(const key of ['XDG_RUNTIME_DIR','XDG_CONFIG_HOME','HC_SESSION']) assert.equal(key in env,false);
  assert.throws(()=>nativeEnvironment({}),/Reopen/);
});
