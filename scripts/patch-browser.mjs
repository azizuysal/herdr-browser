import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const changes = [
  ['      configured.add(target);\n      target.registerPreloadScript', `      configured.add(target);
      target.cookies.on("changed", () => {
        void target.cookies.flushStore().catch((error) => {
          process.stderr.write("herdr-browser: cookie persistence failed: " + error.message + "\\n");
          process.exitCode = 1;
        });
      });
      target.registerPreloadScript`],
  ['      case "clear-browsing-data": {', `      case "flush-browsing-data": {
        await this.host.flushBrowsingData();
        return { flushed: true };
      }
      case "clear-browsing-data": {`],
  ['      clearBrowsingData: (kinds) => this.clearBrowsingData(kinds)', `      flushBrowsingData: async () => {
        const session = browsingSession(this.partition);
        await session.cookies.flushStore();
        session.flushStorageData();
      },
      clearBrowsingData: (kinds) => this.clearBrowsingData(kinds)`],
  ['  async send(content3, screenshot) {\n    if (this.ctx.embedded) {', '  async send(content3, screenshot) {\n    if (process.env.HC_TERMINAL_ID) {\n      return require("../../../native-agent.cjs").send(content3, screenshot?.file() ?? null, process.env.HC_TERMINAL_ID);\n    }\n    if (this.ctx.embedded) {'],
  ['    var mount = function(found) {\n      var dockHost = makeHost("__pixel-devtools-dock",', '    var mount = function(found) {\n      window.DevToolsAPI.setUseSoftMenu(true);\n      var dockHost = makeHost("__pixel-devtools-dock",'],
];

export function patchBrowser(source) {
  let updated = source;
  for (const [before, after] of changes) {
    if (updated.includes(after)) {
      if (updated.split(after).length !== 2) throw new Error('Duplicate browser patch.');
      continue;
    }
    if (updated.split(before).length !== 2) throw new Error('Unsupported browser source; no files changed.');
    updated = updated.replace(before, after);
  }
  return updated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/patch-browser.mjs <browser/dist/main.js>');
  const source = fs.readFileSync(file, 'utf8');
  const updated = patchBrowser(source);
  if (source !== updated) fs.writeFileSync(file, updated);
}
