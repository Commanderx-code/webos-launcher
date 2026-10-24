// The launcher's helper on the TV (Node 8, run as root by tv/init.d/40-launcher-helper):
//  - remembers which apps were on screen, for the launcher's Recently Used row
//  - serves a remote control page for phones on the home network, behind a private link key
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { spawn, execFile } = require('child_process');
const { URL } = require('url');
const { Remote } = require('./ssap');

const CONF = '/home/root/.config/minimal-launcher';
const APP_DIR = '/media/developer/apps/usr/palm/applications/com.minimal.launcher';
const LAUNCHER = 'com.minimal.launcher';
const LG_HOME = 'com.webos.app.home';
const PORT = 8765;
const RECENT_FILE = path.join(CONF, 'recent.json');
const KEY_FILE = path.join(CONF, 'remote.key');
const RECENT_MAX = 12;
// Not apps you'd want back: the launcher itself, LG's home bar and overlays.
const NOT_RECENT = [LAUNCHER, LG_HOME, 'com.webos.app.fullhome', 'com.webos.app.volume', 'com.webos.app.livemenu'];
// Buttons the page may press through the TV's network remote.
const BUTTONS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'PLAY', 'PAUSE', 'REWIND', 'FASTFORWARD',
  'VOLUMEUP', 'VOLUMEDOWN', 'CHANNELUP', 'CHANNELDOWN', 'INFO'];

function log(msg) {
  console.log(new Date().toISOString() + ' ' + msg);
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value));
  fs.renameSync(file + '.tmp', file);
}

// ---------------------------------------------------------------- recently used apps

function remember(appId) {
  if (!appId || NOT_RECENT.indexOf(appId) !== -1) return;
  const recent = readJSON(RECENT_FILE, { apps: [] }).apps.filter((a) => a.id !== appId);
  recent.unshift({ id: appId, at: new Date().toISOString() });
  writeJSON(RECENT_FILE, { apps: recent.slice(0, RECENT_MAX) });
}

let foreground = '';

// luna-send only answers with a terminal attached; script(1) gives it one.
function track() {
  const child = spawn('script', ['-q', '-c',
    'luna-send -i luna://com.webos.applicationManager/getForegroundAppInfo \'{"subscribe":true}\'', '/dev/null'],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const m = /"appId":\s*"([^"]*)"/.exec(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (m && m[1] !== foreground) {
        foreground = m[1];
        remember(foreground);
      }
    }
  });
  child.on('exit', () => setTimeout(track, 5000));
}

// ---------------------------------------------------------------- the TV's network remote

const remote = new Remote({
  host: '127.0.0.1',
  port: 3000,
  pairing: require('./pairing.json'),
  clientKey: fs.readFileSync(path.join(CONF, 'ssap-key'), 'utf8').trim(),
});

function launch(id) {
  return remote.request('ssap://system.launcher/launch', { id: id });
}

// ---------------------------------------------------------------- what the page shows

// The launcher's synced data (window.LAUNCHER_DATA = {...}). The packager minifies it, so it's
// run as JavaScript in an empty sandbox rather than parsed as JSON.
function launcherData() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'data', 'data.js'), 'utf8'), sandbox, { timeout: 1000 });
    return sandbox.window.LAUNCHER_DATA || { apps: [], inputs: [] };
  } catch (e) {
    log('could not read the launcher data: ' + e.message);
    return { apps: [], inputs: [] };
  }
}

function state() {
  const data = launcherData();
  const layout = readJSON(path.join(CONF, 'layout.json'), {});
  const favorites = layout.favorites || data.favorites || [];
  const order = layout.order || [];
  const hidden = layout.hidden || [];
  const rank = (a) => {
    const f = favorites.indexOf(a.key);
    if (f !== -1) return f;
    const o = order.indexOf(a.key);
    return 1000 + (o === -1 ? 999 : o);
  };
  const apps = data.apps.filter((a) => hidden.indexOf(a.key) === -1).sort((a, b) => rank(a) - rank(b)).map((a) => ({
    id: a.id,
    title: a.title,
    icon: a.icon ? '/' + a.icon.replace(/^data\//, '') : null,
    bgColor: a.bgColor,
    favorite: favorites.indexOf(a.key) !== -1,
  }));
  const inputs = (data.inputs || []).map((i) => ({ id: i.appId, title: i.title }));
  const known = apps.map((a) => a.id).concat(inputs.map((i) => i.id));
  const recent = readJSON(RECENT_FILE, { apps: [] }).apps.map((a) => a.id).filter((id) => known.indexOf(id) !== -1).slice(0, 6);
  return { apps: apps, inputs: inputs, recent: recent, foreground: foreground };
}

// ---------------------------------------------------------------- the page

function remoteKey() {
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch (e) {
    const key = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
    return key;
  }
}
const KEY = remoteKey();

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
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2048) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function act(body) {
  const s = state();
  if (body.launch) {
    if (s.apps.concat(s.inputs).every((a) => a.id !== body.launch)) return Promise.reject(new Error('unknown app'));
    return launch(body.launch);
  }
  switch (body.button) {
    case 'LAUNCHER': return launch(LAUNCHER);
    case 'LGHOME': return launch(LG_HOME);
    case 'MUTE': return new Promise((resolve) => execFile('/home/root/minimal-launcher/bin/commercial-mute', ['150'], () => resolve()));
    case 'POWER': return remote.request('ssap://system/turnOff');
    default:
      if (BUTTONS.indexOf(body.button) === -1) return Promise.reject(new Error('unknown button'));
      return remote.button(body.button);
  }
}

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://tv');
  // Opening the private link once saves the key in a cookie for this phone.
  if (url.searchParams.has('k')) {
    if (!sameKey(url.searchParams.get('k'))) return send(res, 403, 'text/plain', 'Wrong link.');
    return send(res, 302, 'text/plain', '', {
      Location: '/',
      'Set-Cookie': 'k=' + KEY + '; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict',
    });
  }
  if (!sameKey(cookieKey(req))) return send(res, 403, 'text/plain', 'Open the private link from the launcher setup on this phone first.');

  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(state()));
  const icon = /^\/icons\/([\w.-]+\.(png|jpg))$/.exec(url.pathname);
  if (req.method === 'GET' && icon) {
    return fs.readFile(path.join(APP_DIR, 'data', 'icons', icon[1]), (err, data) => {
      if (err) return send(res, 404, 'text/plain', 'Not found.');
      send(res, 200, icon[2] === 'png' ? 'image/png' : 'image/jpeg', data, { 'Cache-Control': 'max-age=86400' });
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/act' && /^application\/json/.test(req.headers['content-type'] || '')) {
    return readBody(req).then(act).then(
      () => send(res, 200, 'application/json', '{"ok":true}'),
      (err) => send(res, 400, 'application/json', JSON.stringify({ ok: false, error: err.message })));
  }
  send(res, 404, 'text/plain', 'Not found.');
}).listen(PORT, () => log('remote page on port ' + PORT));

track();
log('tracking apps on screen');
