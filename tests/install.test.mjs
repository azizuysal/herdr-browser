import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, installationPlan, verifyArchive, copyContents } from '../scripts/install.mjs';

test('runtime files copy into an exclusively owned directory without overwriting existing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-copy-test-'));
  try {
    const source = path.join(root, 'source'), destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'nested/main.js'), 'source');
    execFileSync('xattr', ['-w', 'dev.herdr-browser.test', 'preserved', path.join(source, 'nested/main.js')]);
    fs.symlinkSync('nested/main.js', path.join(source, 'current.js'));
    copyContents(source, destination);
    assert.equal(fs.readlinkSync(path.join(destination, 'current.js')), 'nested/main.js');
    assert.equal(fs.readFileSync(path.join(destination, 'current.js'), 'utf8'), 'source');
    assert.equal(execFileSync('xattr', ['-p', 'dev.herdr-browser.test', path.join(destination, 'nested/main.js')], { encoding: 'utf8' }).trim(), 'preserved');
    assert.equal(fs.readFileSync(path.join(destination, 'nested/main.js'), 'utf8'), 'source');
    fs.writeFileSync(path.join(destination, 'nested/main.js'), 'existing');
    assert.throws(() => copyContents(source, destination), /exists/);
    assert.equal(fs.readFileSync(path.join(destination, 'nested/main.js'), 'utf8'), 'existing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installation rejects existing runtime, launcher, mod or layout without changing them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-install-test-'));
  try {
    const options = parseOptions(['--with-layout'], root);
    const targets = installationPlan(options);
    for (const file of Object.values(targets)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'existing user content');
      assert.throws(() => installationPlan(options), /Refusing to overwrite/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'existing user content');
      fs.unlinkSync(file);
    }
    fs.symlinkSync(path.join(root, 'missing'), targets.launcher);
    assert.throws(() => installationPlan(options), /Refusing to overwrite/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unsupported existing render settings stop installation without rewriting preferences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-test-'));
  try {
    const options = parseOptions([], root);
    fs.mkdirSync(options.configDir, { recursive: true });
    const settings = path.join(options.configDir, 'settings.json');
    fs.writeFileSync(settings, '{"render.presenter":"tiles"}');
    assert.throws(() => installationPlan(options), /must use/);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"render.presenter":"tiles"}');
    fs.writeFileSync(settings, JSON.stringify({ 'render.presenter': 'full', 'render.transport': 'inline', 'telemetry.usage': 'on' }));
    assert.throws(() => installationPlan(options), /telemetry.usage=off/);
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8'))['telemetry.usage'], 'on');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime downloads are rejected if their contents do not match the pinned digest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-digest-test-'));
  try {
    const archive = path.join(root, 'archive.tar.gz');
    fs.writeFileSync(archive, 'verified archive');
    const hash = createHash('sha256').update('verified archive').digest('hex');
    assert.equal(await verifyArchive(archive, hash), archive);
    fs.appendFileSync(archive, 'tampered');
    await assert.rejects(verifyArchive(archive, hash), /Checksum mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer options reject mistakes rather than silently choosing another location', () => {
  assert.throws(() => parseOptions(['--prefix']), /Missing value/);
  assert.throws(() => parseOptions(['--force']), /Unknown option/);
});
