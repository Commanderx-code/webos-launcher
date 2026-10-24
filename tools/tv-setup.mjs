// Installs the TV side onto a rooted TV:
//   tv/init.d/*      startup hooks (the Homebrew Channel runs /var/lib/webosbrew/init.d at boot),
//                    started now too
//   tv/bin/*         scripts the hooks and remote buttons run, in /home/root/minimal-launcher/bin
//   tv/lginputhook/  LG Input Hook's remote button mappings
//   tv/helper/       the helper (recently used apps, phone remote page), with the TV's network
//                    remote pairing and this computer's approved client key, kept root-only
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
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

// The helper talks to the TV's network remote as an already-approved client.
const keyFile = path.join(os.homedir(), '.lgtv2', `keyfile-${config.tv.host}`);
if (!existsSync(keyFile)) {
  console.error(`No approved client key at ${keyFile}; run npm run sync once first.`);
  process.exit(1);
}
spawnSync('ssh', [...ssh, target, 'mkdir -p /home/root/minimal-launcher/helper && mkdir -p -m 700 /home/root/.config/minimal-launcher'], { stdio: 'inherit' });
const helperDir = path.join(ROOT, 'tv', 'helper');
scp([...readdirSync(helperDir).map((f) => path.join(helperDir, f)), path.join(ROOT, 'node_modules', 'lgtv2', 'pairing.json')],
  '/home/root/minimal-launcher/helper/');
scp([keyFile], '/home/root/.config/minimal-launcher/ssap-key');
spawnSync('ssh', [...ssh, target, 'chmod 600 /home/root/.config/minimal-launcher/ssap-key'], { stdio: 'inherit' });
console.log('installed the helper');

scp(hooks.map((h) => path.join(dir, h)), '/var/lib/webosbrew/init.d/');

// Stop a running copy of each hook that has a "stop" command, then start them as the boot would.
const run = hooks.map((h) => {
  const file = `/var/lib/webosbrew/init.d/${h}`;
  return `chmod 755 ${file}; grep -q '^  stop)' ${file} && ${file} stop; ${file}; echo "started ${h}"`;
}).join('; ');
const res = spawnSync('ssh', [...ssh, target, run], { stdio: 'inherit' });

// The phone remote's private link (the helper makes the key on its first start).
spawnSync('sleep', ['2']);
const key = spawnSync('ssh', [...ssh, target, 'cat /home/root/.config/minimal-launcher/remote.key'], { encoding: 'utf8' }).stdout.trim();
if (key) console.log(`\nPhone remote: http://${config.tv.host}:8765/?k=${key}\n(Open it once on each phone; keep it private.)`);
process.exit(res.status || 0);
