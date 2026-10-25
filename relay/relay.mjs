// The phone remote's relay, for an always-on computer on the home network (run it with Docker:
// see compose.yaml, and npm run relay-setup). The remote page lives on the TV, so it's gone
// while the TV is off. The relay passes the page and its buttons through to the TV, and when
// the TV doesn't answer, the power button wakes it with a Wake-on-LAN packet.
//
// Settings, from the environment:
//   TV_HOST    the TV's address
//   TV_MAC     the MAC address of its wired network port, for waking it
//   BROADCAST  where wake-up packets go (default: the TV's /24 network, e.g. 192.168.1.255)
//   PORT       the port to serve on (default 8765, like the TV)
//   DATA       a folder holding remote.key (the TV's private link key); the relay keeps a copy
//              of the remote page there for when the TV is off
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function setting(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) {
    console.error(`Set ${name}.`);
    process.exit(1);
  }
  return value;
}

const TV_HOST = setting('TV_HOST');
const TV_PORT = 8765;
const MAC = Buffer.from(setting('TV_MAC').replace(/[^0-9a-f]/gi, ''), 'hex');
if (MAC.length !== 6) {
  console.error('TV_MAC should look like 64:95:6c:00:00:00.');
  process.exit(1);
}
const BROADCAST = setting('BROADCAST', TV_HOST.replace(/\.\d+$/, '.255'));
const PORT = Number(setting('PORT', '8765'));
const DATA = setting('DATA', '/data');
const KEY = fs.readFileSync(path.join(DATA, 'remote.key'), 'utf8').trim();
const PAGE_COPY = path.join(DATA, 'page.html');
// A sleeping TV doesn't refuse a connection, it just never answers; this long, and it's off.
const CONNECT_MS = 2500;
// Long enough for the TV's slowest answer, a Plex search.
const ANSWER_MS = 15000;

function log(msg) {
  console.log(new Date().toISOString() + ' ' + msg);
}

function sameKey(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieKey(req) {
  const m = /(?:^|;\s*)k=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return m && m[1];
}

function send(res, status, type, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2048) return req.destroy();
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Asks the TV's helper, with its key. Rejects when the TV doesn't answer.
function askTv(req, body) {
  return new Promise((resolve, reject) => {
    const headers = { Cookie: 'k=' + KEY };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    const tvReq = http.request({ host: TV_HOST, port: TV_PORT, method: req.method, path: req.url, headers, timeout: ANSWER_MS }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('aborted', () => reject(new Error('the answer was cut off')));
    });
    tvReq.on('socket', (socket) => {
      const timer = setTimeout(() => tvReq.destroy(new Error('no answer')), CONNECT_MS);
      socket.once('connect', () => clearTimeout(timer));
    });
    tvReq.on('timeout', () => tvReq.destroy(new Error('too slow')));
    tvReq.on('error', reject);
    tvReq.end(body);
  });
}

// A magic packet: six 0xff bytes, then the MAC sixteen times. It goes to the broadcast address,
// because a sleeping TV doesn't answer for its own, and three times, because UDP can drop one.
function wake() {
  const packet = Buffer.concat([Buffer.alloc(6, 0xff)].concat(new Array(16).fill(MAC)));
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      let sent = 0;
      const next = () => socket.send(packet, 9, BROADCAST, (err) => {
        if (err) return reject(err);
        if (++sent === 3) return resolve();
        setTimeout(next, 100);
      });
      next();
    });
  }).finally(() => socket.close());
}

function isPower(body) {
  try {
    return JSON.parse(body.toString() || '{}').button === 'POWER';
  } catch (e) {
    return false;
  }
}

function pass(res, answer) {
  const headers = {};
  for (const name of ['content-type', 'cache-control', 'x-content-type-options']) {
    if (answer.headers[name]) headers[name] = answer.headers[name];
  }
  res.writeHead(answer.status, headers);
  res.end(answer.body);
}

// The power button turns the TV off when it's on. When it's off, its network is asleep or soon
// will be, and the TV can't turn itself on from there, so wake it.
function power(req, res, body) {
  return askTv({ method: 'GET', url: '/api/state', headers: {} })
    .then((answer) => answer.status === 200 && JSON.parse(answer.body).power !== 'off')
    .catch(() => false)
    .then((on) => {
      if (on) return askTv(req, body).then((answer) => pass(res, answer), () => tvOff(req, res));
      return wake().then(
        () => { log('woke the TV'); send(res, 200, 'application/json', '{"ok":true}'); },
        (err) => { log('wake: ' + err.message); send(res, 500, 'application/json', JSON.stringify({ ok: false, error: err.message })); });
    });
}

// What the phone gets when the TV doesn't answer.
function tvOff(req, res) {
  const url = new URL(req.url, 'http://relay');
  if (req.method === 'GET' && url.pathname === '/') {
    return fs.readFile(PAGE_COPY, (err, page) => {
      if (err) return send(res, 503, 'text/plain', 'The TV is off, and the relay has no copy of the remote page yet.');
      send(res, 200, 'text/html; charset=utf-8', page);
    });
  }
  // The page shows "TV is off" when its state doesn't load.
  send(res, 503, 'application/json', JSON.stringify({ ok: false, error: 'The TV is off' }));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://relay');
  // The same private link as the TV's own page, and the same cookie.
  if (url.searchParams.has('k')) {
    if (!sameKey(url.searchParams.get('k'))) return send(res, 403, 'text/plain', 'Wrong link.');
    return send(res, 302, 'text/plain', '', {
      Location: '/',
      'Set-Cookie': 'k=' + KEY + '; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax',
    });
  }
  if (!sameKey(cookieKey(req))) return send(res, 403, 'text/plain', 'Open the private link from the launcher setup on this phone first.');

  readBody(req).then((body) => {
    if (req.method === 'POST' && url.pathname === '/api/act' && isPower(body)) return power(req, res, body);
    return askTv(req, body).then(
      (answer) => {
        if (req.method === 'GET' && url.pathname === '/' && answer.status === 200) {
          fs.writeFile(PAGE_COPY, answer.body, (err) => { if (err) log('saving the page: ' + err.message); });
        }
        pass(res, answer);
      },
      () => tvOff(req, res));
  }).catch((err) => send(res, 400, 'text/plain', err.message));
}).listen(PORT, () => log(`relaying to ${TV_HOST}:${TV_PORT} on port ${PORT}`));
