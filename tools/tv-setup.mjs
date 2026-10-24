// Installs the TV side onto a rooted TV:
//   tv/init.d/*      startup hooks (the Homebrew Channel runs /var/lib/webosbrew/init.d at boot),
//                    started now too
//   tv/bin/*         scripts the hooks and remote buttons run, in /home/root/minimal-launcher/bin
//   tv/lginputhook/  LG Input Hook's remote button mappings
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

function scp(files, dest) {
  if (spawnSync('scp', [...ssh, '-q', ...files, `${target}:${dest}`], { stdio: 'inherit' }).status !== 0) process.exit(1);
}

const bins = readdirSync(path.join(ROOT, 'tv', 'bin')).map((f) => path.join(ROOT, 'tv', 'bin', f));
spawnSync('ssh', [...ssh, target, 'mkdir -p /home/root/minimal-launcher/bin /home/root/.config/lginputhook'], { stdio: 'inherit' });
scp(bins, '/home/root/minimal-launcher/bin/');
spawnSync('ssh', [...ssh, target, 'chmod 755 /home/root/minimal-launcher/bin/*'], { stdio: 'inherit' });
// Input Hook reloads its keybinds when the file changes.
scp([path.join(ROOT, 'tv', 'lginputhook', 'keybinds.json')], '/home/root/.config/lginputhook/keybinds.json');
console.log(`installed ${bins.length} script(s) and the remote button mappings`);

scp(hooks.map((h) => path.join(dir, h)), '/var/lib/webosbrew/init.d/');

// Stop a running copy of each hook that has a "stop" command, then start them as the boot would.
const run = hooks.map((h) => {
  const file = `/var/lib/webosbrew/init.d/${h}`;
  return `chmod 755 ${file}; grep -q '^  stop)' ${file} && ${file} stop; ${file}; echo "started ${h}"`;
}).join('; ');
const res = spawnSync('ssh', [...ssh, target, run], { stdio: 'inherit' });
process.exit(res.status || 0);
