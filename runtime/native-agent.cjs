const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const base = __dirname;
function nativeCommand(name) {
  const local = path.join(homedir(), '.local/bin', name);
  return fs.existsSync(local) ? local : name;
}
function nativeEnvironment(session, inherited = process.env) {
  if (!session.nativeEnv) throw new Error('Reopen this browser to connect it to native Herdr.');
  const env = { ...inherited };
  for (const key of ['HC_SOCKET', 'HC_SESSION', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'HERDR_APP_HOME']) {
    const value = session.nativeEnv[key];
    if (value == null) delete env[key];
    else env[key] = value;
  }
  return env;
}
const native = async (name, args, session) => JSON.parse((await exec(nativeCommand(name), args, { env: nativeEnvironment(session), timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout);

function chooseAgent(session, candidates) {
  if (session.agent) {
    const target = candidates.find(item => item.address === session.agent);
    if (!target) throw new Error('The selected agent is no longer running in this project. Bind a live project agent with herdr-browser bind.');
    return target;
  }
  if (candidates.length !== 1) throw new Error(candidates.length
    ? 'Several agents are running in this project. Choose one with herdr-browser bind --browser ID --terminal ID.'
    : 'No live agent in this project. Start Codex or Claude in its Herdr space.');
  return candidates[0];
}

async function candidatesFor(session) {
  const { resolveProject, loadProjects } = await import('./herdr-browser.mjs');
  const projects = loadProjects(session.configDir);
  const layout = await native('herdr-app', ['ls'], session);
  const addresses = layout.spaces.filter(space => !space.machine).flatMap(space =>
    space.tabs.flatMap(tab => tab.terminals.filter(item => item.app && item.status).map(item => item.terminal)));
  const terminals = await Promise.all([...new Set(addresses)].map(id => native('hc', ['get', id], session)));
  return terminals.filter(item => {
    if (item.state !== 'live' || !item.reported || !['codex', 'claude', 'claude-code'].includes(item.status?.app)
      || !item.foreground || ['sh', 'zsh', 'bash', 'fish', 'nu'].includes(item.foreground.name)) return false;
    const directory = item.foreground.cwd;
    return directory && fs.existsSync(directory) && resolveProject(directory, projects, true).id === session.project.id;
  });
}

function frame(channel, kind, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header[4] = kind;
  header.writeUInt32LE(data.length, 5);
  return Buffer.concat([header, data]);
}

function pasteText(terminal, text, env = process.env) {
  const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  if (!clean.trim() || Buffer.byteLength(clean) > 128 * 1024) throw new Error('Selection must contain text and be smaller than 128 KiB.');
  if (!terminal.foreground?.pid || !terminal.cols || !terminal.rows) throw new Error('Agent terminal is unavailable.');
  return new Promise((resolve, reject) => {
    const child = spawn(nativeCommand('hc'), ['connect'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0), framed = false, channel = null, finished = false, stderr = '';
    const timer = setTimeout(() => finish(new Error('Agent paste timed out; check its input before retrying.')), 10000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      error ? reject(error) : resolve();
    }
    const rpc = (id, method, params) => child.stdin.write(frame(0, 0, JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    function response(message) {
      if (message.error) throw new Error(message.error.message);
      if (message.id === 1) {
        if (!message.result?.framed) throw new Error('Herdr core did not enable its terminal protocol.');
        framed = true;
        rpc(2, 'terminal.attach', { terminal: terminal.address, cols: terminal.cols, rows: terminal.rows, history: 0 });
      } else if (message.id === 2) {
        channel = message.result.channel;
        rpc(3, 'terminal.get', { terminal: terminal.address });
      } else if (message.id === 3) {
        const current = message.result;
        if (current.state !== 'live' || current.foreground?.pid !== terminal.foreground.pid || current.status?.state === 'blocked')
          throw new Error('Agent changed or needs attention; selection was not pasted.');
        child.stdin.write(frame(channel, 0, `\x1b[200~${clean}\x1b[201~`));
        child.stdin.write(frame(channel, 2));
      }
    }
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (!finished) {
          if (!framed) {
            const end = buffer.indexOf(10);
            if (end < 0) break;
            const message = JSON.parse(buffer.subarray(0, end).toString());
            buffer = buffer.subarray(end + 1);
            response(message);
          } else {
            if (buffer.length < 9) break;
            const length = buffer.readUInt32LE(5);
            if (length > 16 * 1024 * 1024) throw new Error('Invalid Herdr frame length.');
            if (buffer.length < 9 + length) break;
            const id = buffer.readUInt32LE(0), kind = buffer[4], payload = buffer.subarray(9, 9 + length);
            buffer = buffer.subarray(9 + length);
            if (id === 0 && kind === 0) response(JSON.parse(payload.toString()));
            else if (id === channel && kind === 2) {
              if (payload.length) throw new Error('Agent closed before the paste completed.');
              finish();
            }
          }
        }
      } catch (error) { finish(error); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('exit', code => { if (!finished) finish(new Error(stderr.trim() || `Herdr connection exited (${code}).`)); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { framed: true } })}\n`);
  });
}

async function send(content, screenshot, host) {
  const folder = path.join(base, 'sessions');
  const sessions = fs.readdirSync(folder).filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')));
  const session = sessions.find(item => item.herdr?.terminal === host);
  if (!session) throw new Error('Native browser session is unavailable. Reopen this browser from Herdr.');
  const target = chooseAgent(session, await candidatesFor(session));
  if (target.status?.state === 'blocked') throw new Error('The selected agent needs attention. Resolve its prompt before sharing.');
  await pasteText(target, screenshot ? `${content}\n${screenshot}\n` : content, nativeEnvironment(session));
  await native('herdr-app', ['do', 'agent.focus', JSON.stringify({ terminal: target.address })], session);
  return { target: { pane: target.address, tier: 'native-herdr', agent: true }, pasted: false };
}

module.exports = { chooseAgent, candidatesFor, nativeEnvironment, frame, pasteText, send };
