// Sets up the phone remote's relay (relay/) on an always-on computer with Docker, reached over
// SSH with your own key: "relay.host" in config.json (user@host works too), into "relay.dir"
// there (default ~/tv-remote). It copies the relay with the TV's address, the MAC address for
// waking it ("tv.mac", or read from the TV) and the private link key, then starts it with
// Docker Compose. With the relay, the phone remote also loads while the TV is off, and its
// power button turns the TV on.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readConfig } from './config.mjs';
import { isRooted } from './tv-root.mjs';

const config = readConfig();
const relay = config.relay || {};
if (!relay.host) {
  console.error('Set "relay.host" in config.json to an always-on computer with Docker (user@host works too).');
  process.exit(1);
}
if (!isRooted(config)) {
  console.error('The TV isn\'t set up as rooted (npm run root-ssh).');
  process.exit(1);
}
const dir = relay.dir || 'tv-remote';
const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
const tvSsh = ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', '-i', path.join(os.homedir(), '.ssh', 'tv_root')];
const relaySsh = ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10'];

function fromTv(command) {
  const res = spawnSync('ssh', [...tvSsh, `root@${config.tv.host}`, command], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

function onRelay(command, input = '') {
  return spawnSync('ssh', [...relaySsh, relay.host, command], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const key = fromTv('cat /home/root/.config/minimal-launcher/remote.key');
if (!key) fail('Couldn\'t read the phone remote\'s key from the TV. Is the TV on, and has npm run tv-setup run?');
const mac = (config.tv.mac || fromTv('cat /sys/class/net/eth0/address')).toLowerCase();
if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) fail('Couldn\'t read the TV\'s MAC address; set "tv.mac" in config.json.');

// The container runs as the SSH user, so the files it keeps stay that user's. Compose gets the
// folder's full path (see compose.yaml).
const ids = onRelay(`mkdir -p ${quoted}/data && chmod 700 ${quoted}/data && cd ${quoted} && id -u && id -g && pwd -P`);
if (ids.status !== 0) fail(`Couldn't reach ${relay.host} over SSH.`);
const [uid, gid, fullDir] = ids.stdout.trim().split('\n');

function copy(file, dest) {
  if (spawnSync('scp', [...relaySsh, '-q', file, `${relay.host}:${dest}`], { stdio: 'inherit' }).status !== 0) process.exit(1);
}
copy(path.join(ROOT, 'relay', 'relay.mjs'), `${dir}/relay.mjs`);
copy(path.join(ROOT, 'relay', 'compose.yaml'), `${dir}/compose.yaml`);
// A first copy of the remote page, for when the TV is off before the relay has loaded it.
copy(path.join(ROOT, 'tv', 'helper', 'page.html'), `${dir}/data/page.html`);
const env = `TV_HOST=${config.tv.host}\nTV_MAC=${mac}\nUID=${uid}\nGID=${gid}\nRELAY_DIR=${fullDir}\n`;
if (onRelay(`umask 077 && cat > ${quoted}/.env`, env).status !== 0) process.exit(1);
if (onRelay(`umask 077 && cat > ${quoted}/data/remote.key`, key + '\n').status !== 0) process.exit(1);
console.log(`copied the relay to ${relay.host}:${dir}`);

const host = relay.host.replace(/^.*@/, '');
const start = onRelay(`cd ${quoted} && docker compose up -d --force-recreate 2>&1`);
if (start.status === 0) {
  console.log('started the relay');
} else {
  console.log(`\nCouldn't start it from here:\n${start.stdout.trim()}\n`);
  console.log(`Deploy the "tv-remote" project in your Docker manager (Arcane, Dockge), or on ${host} run:\n  cd ${dir} && sudo docker compose up -d --force-recreate`);
}
console.log(`\nPhone remote through the relay: http://${host}:8765/?k=${key}\n(Open it once on each phone; keep it private.)`);
