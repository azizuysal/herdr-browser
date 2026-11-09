// Run against a separate installation only: HERDR_BROWSER_TEST_INSTALL=/absolute/install/runtime mise exec -- node tests/live-isolation.mjs
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveProject } from '../runtime/herdr-browser.mjs';
import path from 'node:path';
import os from 'node:os';
const exec = promisify(execFile);
const base = process.env.HERDR_BROWSER_TEST_INSTALL;
assert.ok(base && path.isAbsolute(base), 'Set HERDR_BROWSER_TEST_INSTALL to a separate installed runtime');
assert.notEqual(fs.realpathSync(base), path.join(os.homedir(), '.local/share/herdr-browser'), 'Use a separate test installation');
const launcher = process.execPath;
const launcherArgs = [path.join(base, 'herdr-browser.mjs')];
const nativeBin = name => fs.existsSync(path.join(os.homedir(), '.local/bin', name)) ? path.join(os.homedir(), '.local/bin', name) : name;
const app = async (...args) => JSON.parse((await exec(nativeBin('herdr-app'), args)).stdout);
const original = await app('status');
const root = fs.mkdtempSync('/private/tmp/browser-isolation-');
const alpha = `${root}/alpha`, beta = `${root}/beta`;
for (const folder of [alpha, beta]) fs.mkdirSync(folder);
const server = http.createServer((req, res) => { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<!doctype html><title>Local isolation test</title><h1>Local browser test</h1><button onclick="document.body.dataset.clicked=\'yes\'">Test button</button>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const opened = new Map();
async function command(project, ...args) {
  const result = await exec(launcher, [...launcherArgs, args[0], '--project', project, ...args.slice(1)], {timeout:60000,maxBuffer:1024*1024});
  return result.stdout.trim();
}
async function open(project, privateMode=false) {
  const result = JSON.parse(await command(project, 'open', url, ...(privateMode ? ['--private'] : [])));
  opened.set(`${result.browser}/${result.tab}`, {project, ...result});
  return result;
}
async function close(project, browser) {
  await command(project, 'close', '--browser', browser.browser, '--tab', String(browser.tab));
  opened.delete(`${browser.browser}/${browser.tab}`);
}
async function evaluate(project, browser, script) {
  const raw = await command(project, 'action', '--browser', browser.browser, '--tab', String(browser.tab), '--', 'eval', script, '--json');
  const result = JSON.parse(raw);
  assert.equal(result.success, true, raw);
  return result.data.result;
}
async function placement(browser) {
  for (const space of (await app('ls')).spaces) {
    const tab = space.tabs.find(item => item.terminals.some(terminal => terminal.terminal === browser.herdr.terminal));
    if (tab) return { space, tab };
  }
  return null;
}
async function moveForRegression(browser, space) {
  await app('do', 'terminal.park', JSON.stringify({terminal:browser.herdr.terminal}));
  const deadline = Date.now() + 10000;
  while (true) {
    const terminal = JSON.parse((await exec(nativeBin('hc'),['get',browser.herdr.terminal])).stdout);
    if (!await placement(browser) && !terminal.labels['herdr.space']) break;
    if (Date.now() > deadline) throw new Error('Test browser could not be parked');
    await delay(100);
  }
  await exec(nativeBin('hc'),['label',browser.herdr.terminal,`herdr.space=${space}`,`herdr.tab=${browser.herdr.tab}`]);
  while ((await placement(browser))?.space.id !== space) {
    if (Date.now() > deadline) throw new Error('Test browser could not be misplaced');
    await delay(100);
  }
}
const state = `({cookie:document.cookie,storage:localStorage.getItem('isolation-test')})`;
try {
  const a = await open(alpha);
  assert.equal((await placement(a)).space.folder,alpha);
  assert.notEqual(a.herdr.space,original.space);
  await app('do','tab.new',JSON.stringify({name:'Routing test anchor',space:a.herdr.space,folder:alpha,argv:['/bin/cat']}));
  await evaluate(alpha,a,`document.cookie='isolation-test=alpha; Path=/; Max-Age=86400; SameSite=Lax';localStorage.setItem('isolation-test','alpha');true`);
  const a2 = await open(alpha);
  assert.equal(a.browser,a2.browser);
  assert.notEqual(a.tab,a2.tab);
  assert.deepEqual(await evaluate(alpha,a2,state),{cookie:'isolation-test=alpha',storage:'alpha'});
  console.log('PASS: same project reuses the browser and cookies across separate page tabs');
  const b = await open(beta);
  assert.equal((await placement(b)).space.folder,beta);
  assert.notEqual(b.herdr.space,a.herdr.space);
  assert.deepEqual(await evaluate(beta,b,state),{cookie:'',storage:null});
  await evaluate(beta,b,`document.cookie='isolation-test=beta; Path=/; Max-Age=86400';localStorage.setItem('isolation-test','beta');true`);
  await assert.rejects(command(alpha,'action','--browser',b.browser,'--tab',String(b.tab),'--','eval','document.cookie'), /not in the current project/);
  console.log('PASS: another project starts clean and cross-project controls are rejected');
  await moveForRegression(a,b.herdr.space);
  const repaired = await open(alpha);
  assert.equal(repaired.browser,a.browser);
  assert.equal(repaired.herdr.space,a.herdr.space);
  assert.equal((await placement(repaired)).space.id,a.herdr.space);
  assert.equal((await placement(repaired)).tab.name,'Browser: alpha');
  assert.deepEqual(await evaluate(alpha,repaired,state),{cookie:'isolation-test=alpha',storage:'alpha'});
  assert.deepEqual(await evaluate(alpha,a2,state),{cookie:'isolation-test=alpha',storage:'alpha'});
  assert.equal((await placement(b)).space.id,b.herdr.space);
  if (process.env.HERDR_BROWSER_TEST_SHOT_DIR) await exec(nativeBin('herdr-app'),['shot',`${process.env.HERDR_BROWSER_TEST_SHOT_DIR}/project.png`]);
  await close(alpha,repaired);
  console.log('PASS: project spaces are independent of caller/focus, and misplaced hosts move back with their pages and cookies intact');
  const p = await open(alpha,true);
  assert.equal(p.herdr.space,a.herdr.space);
  assert.equal((await placement(p)).space.id,a.herdr.space);
  if (process.env.HERDR_BROWSER_TEST_SHOT_DIR) await exec(nativeBin('herdr-app'),['shot',`${process.env.HERDR_BROWSER_TEST_SHOT_DIR}/private.png`]);
  const privateManifest = JSON.parse(fs.readFileSync(`${base}/sessions/${p.session}.json`));
  assert.deepEqual(await evaluate(alpha,p,state),{cookie:'',storage:null});
  await evaluate(alpha,p,`document.cookie='isolation-test=private; Path=/; Max-Age=86400';localStorage.setItem('isolation-test','private');true`);
  assert.deepEqual(await evaluate(alpha,a,state),{cookie:'isolation-test=alpha',storage:'alpha'});
  await close(alpha,p);
  assert.equal(fs.existsSync(privateManifest.runtime),false);
  assert.equal(fs.existsSync(`${base}/sessions/${p.session}.json`),false);
  console.log('PASS: private starts clean, leaves regular state alone and deletes its browser-data directory on close');
  const p2 = await open(alpha,true);
  assert.deepEqual(await evaluate(alpha,p2,state),{cookie:'',storage:null});
  const p2Manifest = JSON.parse(fs.readFileSync(`${base}/sessions/${p2.session}.json`));
  await exec(nativeBin('herdr-app'),['do','tab.close',JSON.stringify({id:p2.herdr.tab,confirmed:true})]);
  opened.delete(`${p2.browser}/${p2.tab}`);
  for(let tries=0;tries<60 && fs.existsSync(p2Manifest.runtime);tries++) await delay(200);
  assert.equal(fs.existsSync(p2Manifest.runtime),false);
  console.log('PASS: closing the private Herdr host directly also deletes its browser data');
  await close(alpha,a2);
  assert.deepEqual(await evaluate(alpha,a,state),{cookie:'isolation-test=alpha',storage:'alpha'});
  await close(alpha,a);
  const reopened = await open(alpha);
  assert.deepEqual(await evaluate(alpha,reopened,state),{cookie:'isolation-test=alpha',storage:'alpha'});
  assert.deepEqual(await evaluate(beta,b,state),{cookie:'isolation-test=beta',storage:'beta'});
  console.log('PASS: regular sign-in state persists after reopening, and closing one project does not stop the other');
  await evaluate(alpha,reopened,`document.cookie='isolation-test=updated; Path=/; Max-Age=86400';true`);
  await exec(nativeBin('herdr-app'),['do','tab.close',JSON.stringify({id:reopened.herdr.tab,confirmed:true})]);
  opened.delete(`${reopened.browser}/${reopened.tab}`);
  const afterDirectClose = await open(alpha);
  assert.deepEqual(await evaluate(alpha,afterDirectClose,state),{cookie:'isolation-test=updated',storage:'alpha'});
  console.log('PASS: recent cookies also persist when the regular Herdr host is closed directly');
  await close(alpha,afterDirectClose);
  await close(beta,b);
} finally {
  for (const item of opened.values()) {
    try { await close(item.project,item); } catch(error) { console.error(`Cleanup failed: ${error.message}`); }
  }
  for (const space of (await app('ls')).spaces.filter(space => [alpha,beta].includes(space.folder))) {
    await app('do','space.close',JSON.stringify({id:space.id,confirmed:true}));
  }
  if (original.tab) await app('do','tab.select',JSON.stringify({id:original.tab}));
  server.close();
  for(const project of [alpha,beta]) {
    const profile = resolveProject(project,[],true);
    fs.rmSync(`${base}/projects/${profile.id}`,{recursive:true,force:true});
  }
  fs.rmSync(root,{recursive:true,force:true});
}
