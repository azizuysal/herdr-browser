import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = fs.readdirSync(root, { recursive: true }).filter(file =>
  !file.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules') && /\.(mjs|cjs|js|json)$/.test(file));
for (const file of files) {
  const absolute = path.join(root, file);
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(absolute, 'utf8'));
  else {
    const result = spawnSync(process.execPath, ['--check', absolute], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log(`Checked ${files.length} JavaScript and JSON files.`);
