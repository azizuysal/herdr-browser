import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { patchBrowser } from './patch-browser.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(fs.readFileSync(path.join(repository, 'runtime-lock.json'), 'utf8'));
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function parseOptions(args, home = os.homedir()) {
  const options = {
    prefix: path.join(home, '.local/share/herdr-browser'),
    binDir: path.join(home, '.local/bin'),
    appHome: process.env.HERDR_APP_HOME || path.join(home, '.config/herdr-app'),
    configDir: process.env.HERDR_BROWSER_CONFIG_DIR || path.join(home, '.config/herdr-browser'),
    cacheDir: path.join(home, '.cache/herdr-browser-installer'),
    withLayout: false,
  };
  const names = { '--prefix': 'prefix', '--bin-dir': 'binDir', '--app-home': 'appHome', '--config-dir': 'configDir', '--cache-dir': 'cacheDir', '--runtime-archive': 'runtimeArchive', '--source-archive': 'sourceArchive' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--with-layout') options.withLayout = true;
    else if (args[i] === '--help') options.help = true;
    else if (names[args[i]]) {
      const key = names[args[i]], value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${args[i - 1]}`);
      options[key] = path.resolve(value);
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}

export function installationPlan(options) {
  const destinations = {
    runtime: options.prefix,
    launcher: path.join(options.binDir, 'herdr-browser'),
    mod: path.join(options.appHome, 'mods/herdr-browser'),
    ...(options.withLayout ? { layout: path.join(options.appHome, 'layouts/browser-workspace.json') } : {}),
  };
  for (const file of Object.values(destinations)) {
    if (exists(file)) throw new Error(`Refusing to overwrite ${file}. Use separate install paths to test this version; keep existing profiles and sessions in place.`);
  }
  const settings = path.join(options.configDir, 'settings.json');
  if (exists(settings)) {
    const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
    if (config['render.presenter'] !== 'full' || config['render.transport'] !== 'inline') {
      throw new Error('Existing browser settings must use render.presenter=full and render.transport=inline. No files changed.');
    }
    for (const key of ['telemetry.usage', 'telemetry.crashReports', 'updates.check', 'search.suggestions']) {
      if (config[key] !== 'off') throw new Error(`Existing browser settings must set ${key}=off. No files changed.`);
    }
  }
  return destinations;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}).`);
}

export async function verifyArchive(file, expected) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error(`Checksum mismatch: ${path.basename(file)}. No archive was executed or extracted.`);
  return file;
}

export function copyContents(source, destination) {
  if (fs.readdirSync(destination).length) throw new Error(`Content already exists: ${destination}`);
  run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', '--qtn', source, destination]);
}

async function archive(spec, supplied, cacheDir, filename) {
  if (supplied) return verifyArchive(supplied, spec.sha256);
  const file = path.join(cacheDir, filename);
  if (!exists(file)) {
    console.log(`Downloading ${filename}`);
    const response = await fetch(spec.url);
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const temporary = `${file}.${process.pid}.download`;
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await verifyArchive(temporary, spec.sha256);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return verifyArchive(file, spec.sha256);
}

async function install(options) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This release supports macOS on Apple Silicon only.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const destinations = installationPlan(options);
  run('rustup', ['run', lock.rust, 'cargo', '--version']);
  run('xcrun', ['--find', 'clang']);
  fs.mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
  const binaryArchive = await archive(lock.archive, options.runtimeArchive, options.cacheDir, `terminal-browser-${lock.version}-${lock.platform}.tar.gz`);
  const sourceArchive = await archive(lock.source, options.sourceArchive, options.cacheDir, `terminal-browser-${lock.version}-source.tar.gz`);
  const stage = fs.mkdtempSync(path.join(options.cacheDir, 'install-'));
  const installed = [];
  try {
    const stagedRuntime = path.join(stage, 'runtime');
    fs.cpSync(path.join(repository, 'runtime'), stagedRuntime, { recursive: true });
    const app = path.join(stagedRuntime, 'app');
    fs.mkdirSync(app);
    run('tar', ['-xzf', binaryArchive, '-C', app, '--strip-components', '1']);
    if (fs.readFileSync(path.join(app, 'VERSION'), 'utf8').trim() !== `v${lock.version}`) throw new Error('Unexpected runtime version.');
    const browserJs = path.join(app, 'browser/dist/main.js');
    fs.writeFileSync(browserJs, patchBrowser(fs.readFileSync(browserJs, 'utf8')));
    run(process.execPath, ['--check', browserJs]);

    const source = path.join(stage, 'source');
    fs.mkdirSync(source);
    run('tar', ['-xzf', sourceArchive, '-C', source, '--strip-components', '1']);
    run('patch', ['-p1', '-i', path.join(repository, 'patches/native-grid.diff')], { cwd: source });
    const engine = path.join(source, 'pixel/engine');
    console.log('Testing and building the native pointer-alignment patch.');
    run('rustup', ['run', lock.rust, 'cargo', 'test', '--locked', '-p', 'pixel-core', 'terminal::present::full::tests'], { cwd: engine });
    run('rustup', ['run', lock.rust, 'cargo', 'build', '--locked', '-p', 'pixel-node'], { cwd: engine });
    fs.copyFileSync(path.join(engine, 'target/debug/libpixel_node.dylib'), path.join(app, 'browser/node_modules/@zenbu-labs/pixel-native-darwin-arm64/pixel.node'));
    fs.cpSync(path.join(repository, 'licenses'), path.join(stagedRuntime, 'licenses'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'runtime-lock.json'), path.join(stagedRuntime, 'runtime-lock.json'));

    installationPlan(options);
    for (const file of Object.values(destinations)) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.mkdirSync(destinations.runtime, { mode: 0o700 });
    installed.push(destinations.runtime);
    copyContents(stagedRuntime, destinations.runtime);
    run('codesign', ['--verify', '--deep', '--strict', path.join(destinations.runtime, 'app/electron/terminal-browser.app')]);
    run(path.join(destinations.runtime, 'app/bin/terminal-browser'), ['--version'], {
      timeout: 20000, killSignal: 'SIGKILL',
      env: { ...process.env, DO_NOT_TRACK: '1', TERMINAL_BROWSER_NO_TELEMETRY: '1' },
    });
    const launcher = `#!/bin/sh\nexport HERDR_BROWSER_CONFIG_DIR=${shellQuote(options.configDir)}\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(options.prefix, 'herdr-browser.mjs'))} "$@"\n`;
    fs.writeFileSync(destinations.launcher, launcher, { flag: 'wx', mode: 0o755 });
    installed.push(destinations.launcher);
    fs.mkdirSync(destinations.mod, { mode: 0o700 });
    installed.push(destinations.mod);
    copyContents(path.join(repository, 'browser-mod/mods/herdr-browser'), destinations.mod);
    fs.writeFileSync(path.join(destinations.mod, 'installation.js'), `export const executable = ${JSON.stringify(destinations.launcher)};\n`);
    if (destinations.layout) {
      fs.copyFileSync(path.join(repository, 'browser-workspace/layouts/browser-workspace.json'), destinations.layout, fs.constants.COPYFILE_EXCL);
      installed.push(destinations.layout);
    }
    fs.mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
    const settings = path.join(options.configDir, 'settings.json');
    if (!exists(settings)) {
      fs.copyFileSync(path.join(repository, 'runtime/settings.json'), settings, fs.constants.COPYFILE_EXCL);
      installed.push(settings);
    }
    console.log(`Installed browser: ${destinations.launcher}`);
    console.log(`Installed mod: ${destinations.mod}`);
    if (destinations.layout) console.log('Installed optional layout: browser-workspace. Select it from Herdr when ready.');
  } catch (error) {
    for (const file of installed.reverse()) fs.rmSync(file, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('Usage: ./install.sh [--with-layout] [--prefix DIR] [--bin-dir DIR] [--app-home DIR] [--config-dir DIR] [--cache-dir DIR] [--runtime-archive FILE] [--source-archive FILE]\nRequires macOS Apple Silicon, Node.js 22+, Rust 1.97.1 via rustup, Xcode command-line tools and Herdr. Existing installations are never overwritten.');
    else await install(options);
  } catch (error) { console.error(`herdr-browser install: ${error.message}`); process.exitCode = 1; }
}
