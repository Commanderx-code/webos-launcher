// Installing and launching on a rooted TV over root SSH (Homebrew Channel's dropbear).
// LG's ares-install can't be used there: dropbear refuses the second command it runs over
// the same connection. luna-send also only prints its replies when a terminal is attached,
// hence ssh -tt.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './config.mjs';

const KEY = path.join(os.homedir(), '.ssh', 'tv_root');

export function isRooted(config = readConfig()) {
  return !!(config.tv && config.tv.root);
}

function sshOptions() {
  return ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', '-i', KEY];
}

function target(config) {
  return `root@${config.tv.host}`;
}

// Copies an .ipk to the TV and installs it, resolving once the installer says "installed".
export function installIpk(file, config = readConfig()) {
  const remote = `/tmp/${path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const copy = spawnSync('scp', [...sshOptions(), '-q', file, `${target(config)}:${remote}`], { encoding: 'utf8' });
  if (copy.status !== 0) return Promise.reject(new Error(`couldn't copy ${path.basename(file)}: ${(copy.stderr || '').trim()}`));

  const request = JSON.stringify({ id: 'com.ares.defaultName', ipkUrl: remote, subscribe: true });
  const command = `luna-send -i -w 180000 'luna://com.webos.appInstallService/dev/install' '${request}'; rm -f ${remote}`;
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-tt', ...sshOptions(), target(config), command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      child.kill();
      if (err) reject(err);
      else resolve();
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const states = buffer.match(/"state":"[^"]*"/g) || [];
      const last = states.length ? states[states.length - 1] : '';
      if (last === '"state":"installed"') finish();
      else if (/fail|error/i.test(last) || /"returnValue":false/.test(buffer)) finish(new Error(`install failed: ${buffer.trim().split('\n').pop()}`));
    });
    child.on('close', () => finish(new Error(`the installer stopped without finishing: ${buffer.trim().split('\n').pop() || 'no reply'}`)));
  });
}

// Reads a file on the TV; null if it isn't there or the TV can't be reached.
export function readRemote(file, config = readConfig()) {
  const res = spawnSync('ssh', [...sshOptions(), target(config), `cat '${file}'`], { encoding: 'utf8', timeout: 20000 });
  return res.status === 0 ? res.stdout : null;
}

// Writes a file on the TV, replacing it in one step.
export function writeRemote(file, text, config = readConfig()) {
  const res = spawnSync('ssh', [...sshOptions(), target(config), `cat > '${file}.tmp' && mv '${file}.tmp' '${file}'`],
    { input: text, encoding: 'utf8', timeout: 20000 });
  return res.status === 0;
}

export function launchApp(id, config = readConfig()) {
  const res = spawnSync('ssh', ['-tt', ...sshOptions(), target(config),
    `luna-send -n 1 'luna://com.webos.applicationManager/launch' '${JSON.stringify({ id })}'`], { encoding: 'utf8' });
  if (res.status !== 0 || !/"returnValue":true/.test(res.stdout)) throw new Error(`couldn't open ${id}: ${(res.stdout || res.stderr).trim()}`);
}
