import test from 'node:test';
import assert from 'node:assert/strict';
import { changes, patchBrowser } from '../scripts/patch-browser.mjs';

test('browser patches add cookie flushing, native sharing and visible DevTools menus exactly once', () => {
  const source = changes.map(([before]) => before).join('\n');
  const patched = patchBrowser(source);
  for (const [, after] of changes) assert.ok(patched.includes(after));
  assert.equal(patchBrowser(patched), patched);
});

test('an incompatible or ambiguous bundle is rejected before any file is written', () => {
  assert.throws(() => patchBrowser('unrecognized browser bundle'), /Unsupported browser source/);
  const source = changes.map(([before]) => before).join('\n');
  assert.throws(() => patchBrowser(`${source}\n${changes[0][0]}`), /Unsupported browser source/);
});
