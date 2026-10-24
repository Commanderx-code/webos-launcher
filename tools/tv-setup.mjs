// Installs the TV-side startup hooks in tv/init.d onto a rooted TV and starts them, so they
// also run at every boot (the Homebrew Channel runs /var/lib/webosbrew/init.d).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readConfig } from './config.mjs';
import { isRooted } from './tv-root.mjs';

const config = readConfig();
if (!isRooted(config)) {
  console.error('The TV isn\'t set up as rooted (npm run root-ssh).');
  process.exit(1);
}
const ssh = ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-i', path.join(os.homedir(), '.ssh', 'tv_root')];
const target = `root@${config.tv.host}`;
const dir = path.join(ROOT, 'tv', 'init.d');
const hooks = readdirSync(dir).sort();

const copy = spawnSync('scp', [...ssh, '-q', ...hooks.map((h) => path.join(dir, h)), `${target}:/var/lib/webosbrew/init.d/`], { stdio: 'inherit' });
if (copy.status !== 0) process.exit(1);

// Stop a running copy of each hook that has a "stop" command, then start them as the boot would.
const run = hooks.map((h) => {
  const file = `/var/lib/webosbrew/init.d/${h}`;
  return `chmod 755 ${file}; grep -q '^  stop)' ${file} && ${file} stop; ${file}; echo "started ${h}"`;
}).join('; ');
const res = spawnSync('ssh', [...ssh, target, run], { stdio: 'inherit' });
process.exit(res.status || 0);
