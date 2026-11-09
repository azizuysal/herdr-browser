#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const home = homedir();
const self = fileURLToPath(import.meta.url);
const base = path.dirname(self);
const configDir = path.resolve(process.env.HERDR_BROWSER_CONFIG_DIR || path.join(home, '.config/herdr-browser'));
const installId = createHash('sha256').update(base).digest('hex').slice(0, 12);
const runtimeBase = path.join('/tmp', `hb-${process.getuid()}-${installId}`);
const sessions = `${base}/sessions`;
const vendor = `${base}/app/bin/terminal-browser`;
const defaultPage = `${base}/home.html`;
process.umask(0o077);

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 20000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${program} failed (${result.signal ?? result.status})`);
  return result.stdout;
}
function nativeCommand(command) {
  const local = path.join(home, '.local/bin', command);
  return fs.existsSync(local) ? local : command;
}
const native = (command, args) => JSON.parse(run(nativeCommand(command), args));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function optional(file) {
  try { return read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const within = (root, child) => child === root || child.startsWith(`${root}${path.sep}`);
function birth(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim() : null;
}
const alive = record => record?.pid && birth(record.pid) === record.birth;
const identity = pid => ({ pid, birth: birth(pid) });

export function resolveProject(directory, projects, explicit = false) {
  const cwd = fs.realpathSync(directory);
  const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (git.error) throw git.error;
  const common = git.status === 0 ? fs.realpathSync(git.stdout.trim()) : null;
  const registered = projects.find(item => common && item.git_common_dir === common)
    ?? projects.filter(item => within(item.root, cwd)).sort((a, b) => b.root.length - a.root.length)[0];
  const group = registered && (projects.find(item => item.id === registered.context_group) ?? registered);
  const root = group ? fs.realpathSync(group.root) : common ? path.dirname(common) : explicit ? cwd : null;
  if (!root || root === home || root === '/') throw new Error('No project found. Use --project /absolute/project/folder; a global browser profile is never selected.');
  return { id: createHash('sha256').update(root).digest('hex').slice(0, 20), root, label: group?.name ?? path.basename(root) };
}
export function loadProjects(directory = configDir) {
  const config = optional(path.join(directory, 'projects.json'));
  if (config === null) return [];
  if (!config || !Array.isArray(config.projects)) throw new Error('projects.json must contain a projects array.');
  const ids = new Set();
  const projects = config.projects.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.root !== 'string' || !path.isAbsolute(item.root)
      || (item.name !== undefined && typeof item.name !== 'string')
      || (item.context_group !== undefined && typeof item.context_group !== 'string')
      || (item.git_common_dir !== undefined && (typeof item.git_common_dir !== 'string' || !path.isAbsolute(item.git_common_dir)))) {
      throw new Error('Invalid project entry in projects.json.');
    }
    ids.add(item.id);
    return { ...item, root: fs.realpathSync(item.root),
      ...(item.git_common_dir === undefined ? {} : { git_common_dir: fs.realpathSync(item.git_common_dir) }) };
  });
  if (projects.some(item => item.context_group && !ids.has(item.context_group))) throw new Error('Unknown context_group in projects.json.');
  return projects;
}
function projectFor(directory, explicit = false) {
  return resolveProject(directory, loadProjects(), explicit);
}
export function resolveSpace(project, spaces, terminals, projects, callerId, browserTerminals = []) {
  const hosts = new Set(browserTerminals);
  const matches = directory => {
    if (!directory || !fs.existsSync(directory)) return false;
    const root = fs.realpathSync(directory);
    if (root === home || root === '/') return false;
    return resolveProject(root, projects, true).id === project.id;
  };
  const candidates = spaces.filter(space => {
    if (space.machine) return false;
    const addresses = new Set(space.tabs.flatMap(tab => tab.terminals.map(item => item.terminal)));
    const regular = terminals.filter(terminal => addresses.has(terminal.address) && !hosts.has(terminal.address)
      && !(terminal.argv?.includes(self) && terminal.argv.some(arg => ['host', 'menu'].includes(arg))));
    return regular.length
      ? regular.some(terminal => matches(terminal.foreground?.cwd ?? terminal.cwd))
      : matches(space.folder);
  });
  return candidates.find(space => space.tabs.some(tab => tab.terminals.some(item => item.terminal === callerId)))
    ?? candidates.find(space => space.active) ?? candidates[0] ?? null;
}
function projectSpace(project, sessions) {
  const { spaces } = native('herdr-app', ['ls']);
  const addresses = new Set(spaces.filter(space => !space.machine).flatMap(space =>
    space.tabs.flatMap(tab => tab.terminals.map(item => item.terminal))));
  const terminals = [...addresses].map(id => native('hc', ['get', id]));
  return resolveSpace(project, spaces, terminals, loadProjects(), process.env.HC_TERMINAL_ID,
    sessions.map(session => session.herdr?.terminal));
}
function browserPlacement(terminal) {
  for (const space of native('herdr-app', ['ls']).spaces) {
    for (const tab of space.tabs) {
      if (tab.terminals.some(item => item.terminal === terminal)) return { terminal, tab: tab.id, space: space.id };
    }
  }
  return null;
}
async function placeBrowser(session, space) {
  let placement = browserPlacement(session.herdr.terminal);
  if (placement?.space !== space) {
    if (placement) {
      native('herdr-app', ['do', 'terminal.park', JSON.stringify({ terminal: session.herdr.terminal })]);
      const deadline = Date.now() + 10000;
      while (browserPlacement(session.herdr.terminal)
        || native('hc', ['get', session.herdr.terminal]).labels['herdr.space']) {
        if (Date.now() > deadline) throw new Error('Browser host could not leave its previous space.');
        await delay(100);
      }
    }
    const tab = `tb${randomUUID().replaceAll('-', '')}`;
    native('hc', ['label', session.herdr.terminal, `herdr.space=${space}`, `herdr.tab=${tab}`]);
    const deadline = Date.now() + 10000;
    while (true) {
      placement = browserPlacement(session.herdr.terminal);
      if (placement?.space === space && placement.tab === tab) break;
      if (Date.now() > deadline) throw new Error('Browser host could not attach to its project space.');
      await delay(100);
    }
    native('herdr-app', ['do', 'tab.rename', JSON.stringify({ id: tab, name: `Browser: ${session.project.label}` })]);
  }
  session.herdr = placement;
  write(manifest(session.id), { ...sessionById(session.id), herdr: placement });
}
export function contextEnv(session) {
  const root = session.storage;
  const env = { ...process.env,
    DO_NOT_TRACK: '1', TERMINAL_BROWSER_NO_TELEMETRY: '1',
    HERDR_BROWSER_CONFIG_DIR: session.configDir,
    TERMINAL_BROWSER_CONFIG_DIR: `${root}/config`, TERMINAL_BROWSER_APPDATA: `${root}/profiles`,
    XDG_DATA_HOME: `${root}/data`, XDG_STATE_HOME: `${root}/state`, XDG_CACHE_HOME: `${root}/cache`,
    XDG_RUNTIME_DIR: session.runtime, TERM: 'xterm-256color', TERM_PROGRAM: 'herdr-app',
  };
  delete env.GHOSTTY_RESOURCES_DIR;
  return env;
}
function prepare(session) {
  for (const folder of ['config', 'profiles', 'data', 'state/terminal-browser', 'cache']) fs.mkdirSync(`${session.storage}/${folder}`, { recursive: true, mode: 0o700 });
  const settings = `${session.storage}/config/settings.json`;
  if (!fs.existsSync(settings)) fs.copyFileSync(fs.existsSync(path.join(configDir, 'settings.json')) ? path.join(configDir, 'settings.json') : path.join(base, 'settings.json'), settings);
  const version = fs.readFileSync(`${base}/app/VERSION`, 'utf8').trim();
  fs.writeFileSync(`${session.storage}/state/terminal-browser/setup-version`, `${version} ${base}/app\n`);
  fs.writeFileSync(`${session.storage}/state/terminal-browser/skills-choice`, 'no\n');
}
const manifest = id => `${sessions}/${id}.json`;
function sessionById(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
  return read(manifest(id));
}
function allSessions() {
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  return fs.readdirSync(sessions).filter(name => name.endsWith('.json')).map(name => read(`${sessions}/${name}`));
}
function browsers(session) {
  return JSON.parse(run(vendor, ['ls', '--all', '--json'], { env: contextEnv(session) })).browsers;
}
function control(socket, request) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const connection = net.connect(socket);
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Browser control timed out')), 10000);
    function finish(error, value) { clearTimeout(timer); connection.destroy(); error ? reject(error) : resolve(value); }
    connection.setEncoding('utf8');
    connection.on('error', error => finish(error));
    connection.on('connect', () => connection.write(`${JSON.stringify({ id, ...request })}\n`));
    connection.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.id !== id || !response.ok) throw new Error(response.error ?? 'Invalid browser response');
        finish(null, response.data);
      } catch (error) { finish(error); }
    });
  });
}
function focus(session) {
  native('herdr-app', ['do', 'tab.select', JSON.stringify({ id: session.herdr.tab })]);
}
function output(session, tab) {
  return { project: session.project.root, mode: session.mode, session: session.id, herdr: session.herdr, browser: session.browser.key, tab, cdpPort: session.browser.cdpPort };
}
async function lock(project, operation) {
  const file = `${base}/projects/${project.id}/launch.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 25000;
  while (true) {
    try { fs.writeFileSync(file, JSON.stringify(identity(process.pid)), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = optional(file);
      if (holder && !alive(holder)) { fs.rmSync(file); continue; }
      if (Date.now() > deadline) throw new Error('Another browser launch is still in progress.');
      await delay(200);
    }
  }
  try { return await operation(); } finally { fs.rmSync(file, { force: true }); }
}
export function ensureRuntimeBase(directory = runtimeBase) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Browser runtime directory must be a private directory owned by the current user.');
  }
}
export function checkEnvironment(platform = process.platform, arch = process.arch, env = process.env) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Herdr Browser requires macOS on Apple Silicon.');
  if (env.CODEX_SANDBOX) throw new Error('Herdr Browser cannot run in the Codex command sandbox; use the normal escalated command permission flow.');
}
async function open(project, privateMode, url) {
  return lock(project, async () => {
    const sessions = allSessions();
    const space = projectSpace(project, sessions);
    const previous = sessions.filter(item => item.project.id === project.id && item.mode === 'project');
    if (!privateMode) for (const session of previous) {
      if (alive(session.owner)) {
        if (!session.browser) throw new Error('The project browser is still starting.');
        const created = space ? null : native('herdr-app', ['do', 'space.new', JSON.stringify({
          name: project.label, folder: project.root, tab: 'Browser setup', machine: '',
        })]);
        try {
          await placeBrowser(session, space?.id ?? created.space);
          const opened = await control(session.browser.socket, { cmd: 'open-tab', url, cwd: project.root });
          focus(session);
          return output(session, opened.openedTab);
        } finally {
          if (created) native('herdr-app', ['do', 'tab.close', JSON.stringify({ id: created.tab, confirmed: true })]);
        }
      }
      await waitRemoved(session.id);
    }
    ensureRuntimeBase();
    const runtime = fs.mkdtempSync(`${runtimeBase}/${privateMode ? 'p' : 'w'}.`);
    const nativeEnv = Object.fromEntries(['HC_SOCKET', 'HC_SESSION', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'HERDR_APP_HOME'].map(key => [key, process.env[key] ?? null]));
    const session = { id: randomUUID(), project, nativeEnv, configDir, mode: privateMode ? 'private' : 'project', runtime,
      storage: privateMode ? `${runtime}/store` : `${base}/projects/${project.id}`,
      launcher: identity(process.pid), owner: null, browser: null, herdr: null };
    prepare(session);
    write(manifest(session.id), session);
    const name = `${privateMode ? 'Private' : 'Browser'}: ${project.label}`;
    const created = native('herdr-app', ['do', space ? 'tab.new' : 'space.new', JSON.stringify({
      ...(space ? { name, space: space.id } : { name: project.label, tab: name, machine: '' }), folder: project.root,
      argv: [process.execPath, self, 'host', session.id, url],
    })]);
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const current = optional(manifest(session.id));
      if (!current) throw new Error(`Browser closed during startup (${created.terminal}).`);
      if (current.error) throw new Error(current.error);
      if (current.browser) return output(current, current.firstTab);
      await delay(250);
    }
    throw new Error(`Browser startup timed out. Inspect Herdr terminal ${created.terminal}.`);
  });
}
export async function withStartupCleanup(child, exit, operation, timeout = 2000) {
  try { return await operation(); }
  catch (error) {
    const wait = () => new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeout);
      exit.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!await wait()) {
        child.kill('SIGKILL');
        if (!await wait()) throw new Error(`${error.message}; browser child did not exit after SIGKILL.`, { cause: error });
      }
    }
    throw error;
  }
}
async function host(id, url) {
  const session = sessionById(id);
  if (session.owner) throw new Error('This browser session already has a host.');
  const terminalId = process.env.HC_TERMINAL_ID;
  if (!terminalId) throw new Error('Browser host must run inside a native Herdr terminal.');
  const terminal = native('hc', ['get', terminalId]);
  session.herdr = { terminal: terminalId, tab: terminal.labels['herdr.tab'], space: terminal.labels['herdr.space'] };
  session.owner = identity(process.pid);
  session.job = `local.herdr-browser.cleanup.${id}`;
  write(manifest(id), session);
  run('/bin/launchctl', ['submit', '-l', session.job, '--', process.execPath, self, 'watch', id]);
  const watcherDeadline = Date.now() + 10000;
  while (!session.watcher) {
    Object.assign(session, sessionById(id));
    if (Date.now() > watcherDeadline) throw new Error('Browser cleanup service did not start.');
    await delay(100);
  }
  const child = spawn(vendor, ['open', url, '--no-merge'], { env: contextEnv(session), stdio: 'inherit' });
  let ended = false, spawnError = null;
  const exit = new Promise(resolve => {
    child.on('error', error => { ended = true; spawnError = error; resolve({ error }); });
    child.on('exit', (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  await withStartupCleanup(child, exit, async () => {
    const deadline = Date.now() + 22000;
    while (!ended && Date.now() < deadline) {
      const found = browsers(session);
      if (found.length > 1) throw new Error('Multiple browser processes are using one project profile.');
      if (found[0]?.tabs.length) {
        const browser = found[0];
        session.browser = { key: browser.key, pid: browser.pid, birth: birth(browser.pid), socket: browser.socket, cdpPort: browser.cdpPort };
        session.firstTab = browser.tabs[0].id;
        write(manifest(id), session);
        break;
      }
      await delay(250);
    }
    if (spawnError) throw spawnError;
    if (!session.browser) throw new Error('Browser did not become ready.');
  });
  const result = await exit;
  if (result.error) throw result.error;
  if (result.code && !result.signal) throw new Error(`Browser exited ${result.code}`);
}
async function waitRemoved(id) {
  const deadline = Date.now() + 12000;
  while (fs.existsSync(manifest(id))) {
    const current = optional(manifest(id));
    if (current?.cleanupError) throw new Error(current.cleanupError);
    if (Date.now() > deadline) throw new Error('Previous browser cleanup has not finished.');
    await delay(200);
  }
}
async function watch(id) {
  let session = sessionById(id);
  session.watcher = identity(process.pid);
  delete session.cleanupError;
  write(manifest(id), session);
  while (alive(session.owner)) { await delay(500); session = sessionById(id); }
  const records = browsers(session).filter(item => within(session.runtime, item.socket));
  const processes = records.map(item => identity(item.pid));
  if (session.browser && alive(session.browser) && !processes.some(item => item.pid === session.browser.pid)) processes.push(session.browser);
  for (const processRecord of processes) if (alive(processRecord)) process.kill(processRecord.pid, 'SIGTERM');
  for (let tries = 0; tries < 20 && processes.some(alive); tries++) await delay(250);
  for (const processRecord of processes) if (alive(processRecord)) process.kill(processRecord.pid, 'SIGKILL');
  for (let tries = 0; tries < 20 && processes.some(alive); tries++) await delay(250);
  if (processes.some(alive)) throw new Error('Browser process did not exit; private data retained until cleanup can complete.');
  if (!session.runtime.startsWith(`${runtimeBase}/`) || !/^[wp]\.[A-Za-z0-9]+$/.test(path.basename(session.runtime))) throw new Error('Invalid cleanup path');
  fs.rmSync(session.runtime, { recursive: true, force: true });
  fs.rmSync(manifest(id));
  if (session.job) run('/bin/launchctl', ['remove', session.job]);
}
async function reap() {
  for (const session of allSessions()) {
    if (!alive(session.owner) && !alive(session.launcher) && !alive(session.watcher)) await watch(session.id);
  }
}
function parse(args) {
  let directory = process.cwd(), explicit = false, privateMode = false;
  const remaining = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { remaining.push(...args.slice(i)); break; }
    if (args[i] === '--project') { directory = args[++i]; if (!directory) throw new Error('--project requires a folder'); explicit = true; }
    else if (args[i] === '--private') privateMode = true;
    else remaining.push(args[i]);
  }
  return { directory, explicit, privateMode, args: remaining };
}
async function main(argv) {
  const [command, ...raw] = argv;
  if (command && !['help', '--help'].includes(command)) checkEnvironment();
  if (command === 'host') return host(...raw);
  if (command === 'watch') {
    try { return await watch(raw[0]); }
    catch (error) {
      const session = optional(manifest(raw[0]));
      if (session) write(manifest(raw[0]), { ...session, cleanupError: error.message });
      throw error;
    }
  }
  if (!command || ['help', '--help'].includes(command)) {
    console.log('herdr-browser open [url] [--private] [--project /folder]\nherdr-browser ls [--json] [--project /folder]\nherdr-browser action --browser ID --tab ID -- snapshot|...\nherdr-browser action --browser ID --tab ID done\nherdr-browser close --browser ID --tab ID\nherdr-browser bind --browser ID --terminal ID\nProject profiles persist; private sessions are deleted when their Browser host closes.');
    return;
  }
  const options = parse(raw);
  if (options.privateMode && !['open', 'menu'].includes(command)) throw new Error('--private applies only when opening a browser.');
  await reap();
  const project = projectFor(options.directory, options.explicit);
  if (command === 'open' || command === 'menu') {
    if (options.args.length > 1 || options.args[0]?.startsWith('--')) throw new Error('Usage: herdr-browser open [url] [--private] [--project /folder]');
    const result = await open(project, options.privateMode, options.args[0] ?? defaultPage);
    console.log(JSON.stringify(result, null, 2));
    if (command === 'menu' && process.env.HC_TERMINAL_ID) {
      const terminal = native('hc', ['get', process.env.HC_TERMINAL_ID]);
      if (terminal.labels['herdr.tab'] !== result.herdr.tab) native('herdr-app', ['do', 'tab.close', JSON.stringify({ id: terminal.labels['herdr.tab'], confirmed: true })]);
    }
    return;
  }
  const available = allSessions().filter(item => item.project.id === project.id && alive(item.owner) && item.browser);
  if (command === 'ls') {
    if (options.args.some(arg => !['--json', '--all'].includes(arg))) throw new Error('Usage: herdr-browser ls [--json] [--project /folder]');
    console.log(JSON.stringify({ project: project.root, browsers: available.flatMap(session => browsers(session).map(browser => ({ ...browser, mode: session.mode, session: session.id, herdr: session.herdr }))) }, null, 2));
    return;
  }
  if (command === 'bind') {
    const args = options.args;
    if (args.length !== 4 || args[0] !== '--browser' || args[2] !== '--terminal') throw new Error('Usage: herdr-browser bind --browser ID --terminal ID');
    const session = available.find(item => item.browser.key === args[1]);
    if (!session) throw new Error('Browser is not in the current project.');
    const { candidatesFor, chooseAgent } = await import('./native-agent.cjs');
    const target = chooseAgent({ agent: args[3] }, await candidatesFor(session));
    await lock(project, async () => write(manifest(session.id), { ...sessionById(session.id), agent: target.address }));
    console.log(JSON.stringify({ browser: session.browser.key, agent: target.address, project: project.root }));
    return;
  }
  if (!['action', 'close'].includes(command)) throw new Error(`Unsupported command ${command}; use herdr-browser --help.`);
  const key = options.args[options.args.indexOf('--browser') + 1];
  const tab = Number(options.args[options.args.indexOf('--tab') + 1]);
  if (!options.args.includes('--browser') || !options.args.includes('--tab') || !Number.isInteger(tab) || tab < 1) throw new Error('Both --browser and --tab are required.');
  const session = available.find(item => item.browser.key === key);
  if (!session) throw new Error('Browser is not in the current project. Use the correct project folder or an explicit --project override.');
  if (command === 'action') {
    await lock(project, async () => {
      const result = spawnSync(vendor, [command, ...options.args], { env: contextEnv(session), stdio: 'inherit' });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    });
  } else {
    const state = await control(session.browser.socket, { cmd: 'targets' });
    if (!state.tabs.some(item => item.id === tab)) throw new Error(`No tab ${tab} in browser ${key}`);
    if (state.tabs.length === 1) {
      if (session.mode === 'project') await control(session.browser.socket, { cmd: 'flush-browsing-data' });
      native('herdr-app', ['do', 'tab.close', JSON.stringify({ id: session.herdr.tab, confirmed: true })]);
      await waitRemoved(session.id);
    } else await control(session.browser.socket, { cmd: 'close-tab', tab });
    console.log(JSON.stringify({ closed: tab, mode: session.mode, sessionEnded: state.tabs.length === 1 }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main(process.argv.slice(2)).catch(error => {
    if (process.argv[2] === 'host') {
      const session = sessionById(process.argv[3]);
      write(manifest(session.id), { ...session, error: error.message });
    }
    console.error(`herdr-browser: ${error.message}`);
    process.exitCode = 1;
  });
}
