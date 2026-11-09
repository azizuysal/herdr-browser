// Open DevTools in a disposable browser, then HERDR_DEVTOOLS_TEST_PORT=<loopback CDP port> mise exec -- node --test tests/devtools-menu.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

const port = Number(process.env.HERDR_DEVTOOLS_TEST_PORT);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Set HERDR_DEVTOOLS_TEST_PORT to a disposable browser CDP port');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const target = targets.find(item => item.url.startsWith('devtools://'));
assert.ok(target, 'Open DevTools in the disposable browser before running this test');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
};
socket.onclose = () => { for (const request of pending.values()) request.reject(new Error('DevTools connection closed')); };
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const findAll = `(function findAll(root, selector) {
  const result = [...root.querySelectorAll(selector)];
  for (const element of root.querySelectorAll('*')) if (element.shadowRoot) result.push(...findAll(element.shadowRoot, selector));
  return result;
})`;
async function click(selector, text) {
  const rect = await evaluate(`(() => {
    const element = ${findAll}(document, ${JSON.stringify(selector)}).find(element => element.getBoundingClientRect().width && (${JSON.stringify(text)} === null || element.innerText === ${JSON.stringify(text)}));
    if (!element) throw new Error('Control unavailable');
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
}
async function settle() { await evaluate('new Promise(resolve => setTimeout(resolve, 100))'); }
async function escape() {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await settle();
}
const menus = () => evaluate(`${findAll}(document, '[role="menu"]').filter(element => element.getBoundingClientRect().width).length`);
try {
  await test('embedded DevTools overflow renders in-page, selects a panel, and dismisses on Escape', { timeout: 15000 }, async () => {
    assert.equal(await evaluate("import('./ui/legacy/legacy.js').then(ui => ui.ContextMenu.ContextMenu.useSoftMenu)"), true, 'The installed controls must enable in-page menus automatically');
    await escape();
    await evaluate(`window.__menuTestOriginal = InspectorFrontendHost.showContextMenuAtPoint;
      window.__menuTestRequests = 0;
      InspectorFrontendHost.showContextMenuAtPoint = function() { window.__menuTestRequests++; };
      DevToolsAPI.setUseSoftMenu(false);`);
    try {
      await click('[aria-label="More tabs"]', null);
      await settle();
      assert.equal(await evaluate('window.__menuTestRequests'), 1, 'Original mode requests an unrendered native menu');
      assert.equal(await menus(), 0);
    } finally {
      await evaluate(`InspectorFrontendHost.showContextMenuAtPoint = window.__menuTestOriginal;
        delete window.__menuTestOriginal; delete window.__menuTestRequests;
        DevToolsAPI.setUseSoftMenu(true);`);
    }
    await click('[aria-label="More tabs"]', null);
    await settle();
    assert.equal(await menus(), 1);
    const items = await evaluate(`${findAll}(document, '[role="menuitem"]').map(element => element.innerText)`);
    assert.ok(items.includes('Properties'));
    assert.ok(items.includes('Accessibility'));
    await click('[role="menuitem"]', 'Properties');
    await settle();
    assert.equal(await menus(), 0);
    const selected = await evaluate(`${findAll}(document, '[role="tab"][aria-selected="true"]').map(element => element.textContent.trim())`);
    assert.ok(selected.includes('Properties'), `Selected tabs: ${selected.join(', ')}`);
    await click('[aria-label="More tabs"]', null);
    await settle();
    assert.equal(await menus(), 1);
    await escape();
    assert.equal(await menus(), 0);
  });
} finally {
  socket.close();
}
