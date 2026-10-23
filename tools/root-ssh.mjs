// One-time setup for a rooted TV with Homebrew Channel's SSH server on: logs in as root
// (with Homebrew Channel's default password the first time), installs this computer's key,
// then points the ares "tv" device at root SSH so sync, deploy and auto-update use it.
// Once a key is installed, Homebrew Channel stops accepting the password.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'ssh2';
import { bin, deviceName, readConfig, requireTvHost, writeConfig } from './config.mjs';

const config = readConfig();
const host = requireTvHost(config);
const KEY = path.join(os.homedir(), '.ssh', 'tv_root');
const DEFAULT_PASSWORD = 'alpine';

if (!existsSync(KEY)) {
  console.error(`No key at ${KEY}. Create one with: ssh-keygen -t rsa -b 4096 -N "" -f ${KEY}`);
  process.exit(1);
}
const publicKey = readFileSync(KEY + '.pub', 'utf8').trim();

function session(auth) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn)).on('error', reject);
    conn.connect({ host, port: 22, username: 'root', readyTimeout: 15000, ...auth });
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => { out += d; }).stderr.on('data', (d) => { out += d; });
      stream.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim() || `exit ${code}`))));
    });
  });
}

let conn;
try {
  conn = await session({ privateKey: readFileSync(KEY) });
  console.log('The key already works.');
} catch {
  try {
    conn = await session({ password: DEFAULT_PASSWORD });
  } catch (err) {
    console.error(`Couldn't log in to root@${host}:22 (${err.message}). Is SSH Server on in Homebrew Channel's settings?`);
    process.exit(1);
  }
  const quoted = `'${publicKey.replace(/'/g, `'\\''`)}'`;
  await exec(conn, 'mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh && ' +
    `(grep -qxF ${quoted} /home/root/.ssh/authorized_keys 2>/dev/null || echo ${quoted} >> /home/root/.ssh/authorized_keys) && ` +
    'chmod 600 /home/root/.ssh/authorized_keys');
  conn.end();
  conn = await session({ privateKey: readFileSync(KEY) });
  console.log('Installed this computer\'s key; the default password no longer works.');
}
console.log(`Logged in as ${await exec(conn, 'id -un')} on ${await exec(conn, 'cat /etc/hostname 2>/dev/null || hostname')}.`);
conn.end();

const device = deviceName(config);
const res = spawnSync(bin('ares-setup-device'), ['-m', device, '-i', `host=${host}`, '-i', 'port=22', '-i', 'username=root',
  '-i', 'privatekey=tv_root', '-i', 'passphrase='], { encoding: 'utf8' });
if (res.status !== 0) {
  console.error(`Couldn't update the "${device}" device: ${(res.stderr || res.stdout).trim()}`);
  process.exit(1);
}
config.tv.root = true;
writeConfig(config);
console.log(`The "${device}" device now uses root@${host}:22, and deploy installs over root SSH. Next: npm run sync && npm run deploy`);
