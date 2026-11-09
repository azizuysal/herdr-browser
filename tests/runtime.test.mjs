import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { checkEnvironment, contextEnv, ensureRuntimeBase, loadProjects, resolveProject, resolveSpace, withStartupCleanup } from '../runtime/herdr-browser.mjs';

test('project components and linked worktrees share the parent profile; unrelated projects do not', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-profiles-test-')));
  const workspace = `${root}/workspace`;
  const component = `${workspace}/component`;
  const unrelated = `${root}/personal`;
  const worktree = `${root}/worktree`;
  for (const folder of [component, unrelated]) fs.mkdirSync(folder, { recursive: true });
  const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
  try {
    git('init', component);
    git('-C', component, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'test');
    git('-C', component, 'worktree', 'add', '--detach', worktree);
    const projects = [
      { id: 'workspace', name: 'workspace', root: workspace, context_group: 'workspace' },
      { id: 'component', root: component, context_group: 'workspace', git_common_dir: `${component}/.git` },
    ];
    const parent = resolveProject(workspace, projects);
    assert.equal(resolveProject(component, projects).id, parent.id);
    assert.equal(resolveProject(worktree, projects).id, parent.id);
    assert.notEqual(resolveProject(unrelated, projects, true).id, parent.id);
    assert.throws(() => resolveProject(unrelated, projects), /No project found/);
    assert.throws(() => resolveProject(os.homedir(), projects, true), /No project found/);
    assert.equal(resolveProject(worktree, []).id, resolveProject(component, []).id);
    const spaces = [{ id: 'worktree-space', folder: unrelated, tabs: [{ terminals: [{ terminal: 'worker' }] }] }];
    const terminals = [{ address: 'worker', cwd: unrelated, foreground: { cwd: worktree } }];
    assert.equal(resolveSpace(parent, spaces, terminals, projects)?.id, 'worktree-space');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('browser space selection follows the requested project', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-spaces-test-')));
  const alpha = `${root}/alpha`, beta = `${root}/beta`, missing = `${root}/missing`;
  for (const folder of [alpha, beta, missing]) fs.mkdirSync(folder);
  const project = resolveProject(beta, [], true);
  const spaces = [
    { id: 'alpha-space', folder: beta, active: true, tabs: [{ terminals: [{ terminal: 'alpha-agent' }, { terminal: 'browser' }] }] },
    { id: 'beta-space', folder: alpha, tabs: [{ terminals: [{ terminal: 'beta-agent' }] }] },
  ];
  const terminals = [
    { address: 'alpha-agent', cwd: beta, foreground: { cwd: alpha } },
    { address: 'beta-agent', cwd: alpha, foreground: { cwd: beta } },
    { address: 'browser', cwd: beta },
  ];
  const select = (list = spaces, agents = terminals, caller = 'alpha-agent') =>
    resolveSpace(project, list, agents, [], caller, ['browser']);
  try {
    await t.test('live project folders override stale space folders, caller and window focus', () => {
      assert.equal(select()?.id, 'beta-space');
    });
    await t.test('a misplaced browser cannot make an unrelated space match', () => {
      assert.equal(select([spaces[0]]), null);
    });
    await t.test('an inherited terminal ID cannot redirect another project', () => {
      assert.equal(select(spaces, terminals, 'browser')?.id, 'beta-space');
      assert.equal(select(spaces, terminals, undefined)?.id, 'beta-space');
    });
    await t.test('the caller wins between spaces belonging to the same project', () => {
      const sameProject = terminals.map(item => ({ ...item, foreground: { cwd: beta } }));
      assert.equal(select(spaces, sameProject, 'beta-agent')?.id, 'beta-space');
    });
    await t.test('an existing browser-only space retains its project association', () => {
      const onlyBrowser = [{ id: 'browser-space', folder: beta, tabs: [{ terminals: [{ terminal: 'browser' }] }] }];
      assert.equal(select(onlyBrowser)?.id, 'browser-space');
    });
    await t.test('remote spaces and unrelated local spaces never receive the browser', () => {
      assert.equal(select(spaces.map(item => ({ ...item, machine: 'remote' }))), null);
      assert.equal(resolveSpace(resolveProject(missing, [], true), spaces, terminals, [], 'alpha-agent', ['browser']), null);
    });
    await t.test('the menu launcher itself cannot make an unrelated space match', () => {
      const agents = terminals.map(item => item.address === 'browser'
        ? { ...item, argv: [path.resolve('runtime/herdr-browser.mjs'), 'menu'] } : item);
      assert.equal(resolveSpace(project, [spaces[0]], agents, [], 'browser'), null);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('optional project configuration is validated and resolves registered groups', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-test-')));
  try {
    const config = path.join(root, 'config');
    const workspace = path.join(root, 'workspace');
    const component = path.join(workspace, 'component');
    fs.mkdirSync(config);
    fs.mkdirSync(component, { recursive: true });
    assert.deepEqual(loadProjects(config), []);
    assert.throws(() => resolveProject(component, []), /No project found/);
    assert.equal(resolveProject(component, [], true).root, component);
    const file = path.join(config, 'projects.json');
    fs.writeFileSync(file, JSON.stringify({ projects: [
      { id: 'workspace', root: workspace, name: 'Workspace' },
      { id: 'component', root: component, context_group: 'workspace' },
    ] }));
    const projects = loadProjects(config);
    assert.equal(resolveProject(component, projects).root, workspace);
    assert.equal(resolveProject(component, projects).label, 'Workspace');
    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'a', root: component, context_group: 'missing' }] }));
    assert.throws(() => loadProjects(config), /Unknown context_group/);
    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'a', root: 'relative' }] }));
    assert.throws(() => loadProjects(config), /Invalid project entry/);
    fs.writeFileSync(file, '{}');
    assert.throws(() => loadProjects(config), /projects array/);
    assert.throws(() => resolveProject('/', [], true), /No project found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('configuration override is honored by a fresh runtime process', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-env-test-')));
  try {
    fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[]}');
    const moduleUrl = new URL('../runtime/herdr-browser.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import { loadProjects } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(loadProjects()));`], { env: { ...process.env, HERDR_BROWSER_CONFIG_DIR: root }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('runtime directory must be private and cannot be a symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-runtime-test-'));
  try {
    const directory = path.join(root, 'runtime');
    ensureRuntimeBase(directory);
    ensureRuntimeBase(directory);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    fs.chmodSync(directory, 0o755);
    assert.throws(() => ensureRuntimeBase(directory), /private directory/);
    const link = path.join(root, 'link');
    fs.symlinkSync(directory, link);
    assert.throws(() => ensureRuntimeBase(link), /private directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session configuration survives a fresh browser environment', () => {
  const env = contextEnv({ storage: '/storage', runtime: '/runtime', configDir: '/custom/config' });
  assert.equal(env.HERDR_BROWSER_CONFIG_DIR, '/custom/config');
  assert.equal(env.TERM_PROGRAM, 'herdr-app');
  assert.equal(env.TERMINAL_BROWSER_NO_TELEMETRY, '1');
});

test('unsupported platforms and Codex sandbox fail before browser operations', () => {
  assert.doesNotThrow(() => checkEnvironment('darwin', 'arm64', {}));
  assert.throws(() => checkEnvironment('linux', 'arm64', {}), /macOS on Apple Silicon/);
  assert.throws(() => checkEnvironment('darwin', 'x64', {}), /macOS on Apple Silicon/);
  assert.throws(() => checkEnvironment('darwin', 'arm64', { CODEX_SANDBOX: 'seatbelt' }), /command sandbox/);
});


test('startup failures terminate an unresponsive child and retain the diagnostic', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error })); });
  try {
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    const failure = new Error('readiness failed');
    await assert.rejects(withStartupCleanup(child, exit, async () => { throw failure; }, 100), error => error === failure);
    assert.equal((await exit).signal, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
