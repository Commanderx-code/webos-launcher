// Signs in to Plex with a PIN in the browser, picks your server and saves its LAN address
// and token in config.json for `npm run sync` to pass to the launcher.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { readConfig, writeConfig } from './config.mjs';

const PRODUCT = 'Minimal Launcher';
const config = readConfig();
const clientId = (config.plex && config.plex.clientId) || randomUUID();
const headers = {
  Accept: 'application/json',
  'X-Plex-Product': PRODUCT,
  'X-Plex-Client-Identifier': clientId,
};

async function plexTv(path, options = {}) {
  const res = await fetch(`https://plex.tv/api/v2${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!res.ok) throw new Error(`plex.tv answered ${res.status} for ${path}`);
  return res.json();
}

async function reachable(base) {
  try {
    const res = await fetch(`${base}/identity`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

const pin = await plexTv('/pins?strong=true', { method: 'POST' });
const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(pin.code)}` +
  `&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`;
console.log(`Sign in to Plex here:\n\n  ${authUrl}\n`);
spawn('xdg-open', [authUrl], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();

let token = null;
const deadline = Date.now() + 5 * 60 * 1000;
while (!token && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  token = (await plexTv(`/pins/${pin.id}`)).authToken;
}
if (!token) {
  console.error('Timed out waiting for the sign-in. Run it again.');
  process.exit(1);
}

const servers = (await plexTv('/resources?includeHttps=1', { headers: { 'X-Plex-Token': token } }))
  .filter((r) => (r.provides || '').split(',').includes('server'));
if (!servers.length) {
  console.error('No Plex servers on this account.');
  process.exit(1);
}

let server = servers[0];
if (servers.length > 1) {
  servers.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}${s.owned ? '' : ' (shared with you)'}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = Number(await rl.question('Which server? '));
  rl.close();
  server = servers[answer - 1] || server;
}

// The TV loads the server over the LAN, so prefer a plain local address over a relay.
const local = (server.connections || []).filter((c) => c.local && !c.relay);
const candidates = [
  ...local.map((c) => `http://${c.address}:${c.port}`),
  ...local.map((c) => c.uri),
  ...(server.connections || []).filter((c) => !c.relay && !c.local).map((c) => c.uri),
];
let base = null;
for (const url of candidates) {
  if (await reachable(url)) {
    base = url;
    break;
  }
}
if (!base) {
  base = candidates[0];
  console.warn(`Couldn't reach ${server.name} from this computer; saved ${base} anyway. Edit config.json if it's wrong.`);
}

config.plex = { ...(config.plex || {}), clientId, server: base, token: server.accessToken || token, name: server.name };
writeConfig(config);
console.log(`Saved ${server.name} at ${base}. Next: npm run sync`);
