// The launcher's helper on the TV (Node 8, run as root by tv/init.d/40-launcher-helper):
//  - remembers which apps were on screen, for the launcher's Recently Used row
//  - serves a remote control page for phones on the home network, behind a private link key
//  - runs the sleep timer the launcher's menu sets, whatever app is on screen
//  - turns the TV's night settings on and off for the launcher's Night mode
//  - searches the Plex server for the phone page, so the server's token stays on the TV
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const vm = require('vm');
const { spawn, execFile } = require('child_process');
const { URL, parse: parseUrl } = require('url');
const { Remote } = require('./ssap');

const CONF = '/home/root/.config/minimal-launcher';
const APP_DIR = '/media/developer/apps/usr/palm/applications/com.minimal.launcher';
const LAUNCHER = 'com.minimal.launcher';
const LG_HOME = 'com.webos.app.home';
const PLXNATIVE = 'com.beb.plxnative';
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

// ---------------------------------------------------------------- sleep timer

// The launcher's menu writes {"at": <ms since 1970>} here; deleting the file cancels.
const SLEEP_FILE = '/run/minimal-launcher/sleep.json';
// A deadline missed by more than this was missed while the TV slept: drop it rather than turn
// the TV off the moment it wakes.
const SLEEP_STALE_MS = 2 * 60 * 1000;
let sleepWarned = 0;

// luna-send only answers with a terminal attached; script(1) gives it one. The address and the
// message go through the environment, so nothing in them is ever read as shell syntax. A call
// that hangs is stopped after LUNA_TIMEOUT_MS.
const LUNA_TIMEOUT_MS = 15000;

function lunaCall(uri, payload) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { LUNA_URI: uri, LUNA_PAYLOAD: JSON.stringify(payload || {}) });
    execFile('script', ['-q', '-c', 'luna-send -n 1 "$LUNA_URI" "$LUNA_PAYLOAD"', '/dev/null'], { env: env, timeout: LUNA_TIMEOUT_MS }, (err, out) => {
      const m = /\{[\s\S]*\}/.exec(out || '');
      let reply = null;
      try {
        reply = m && JSON.parse(m[0]);
      } catch (e) {
        // No reply, handled below.
      }
      if (!reply || reply.returnValue === false) return reject(new Error((reply && reply.errorText) || 'no answer from ' + uri));
      resolve(reply);
    });
  });
}

function lunaSend(uri, payload) {
  lunaCall(uri, payload).catch((err) => log(err.message));
}

function checkSleep() {
  const timer = readJSON(SLEEP_FILE, null);
  if (!timer || !timer.at) return;
  const left = timer.at - Date.now();
  if (left <= 0) {
    fs.unlink(SLEEP_FILE, () => {});
    if (left < -SLEEP_STALE_MS) return log('dropped a sleep timer that ran out while the TV was off');
    log('sleep timer: turning the TV off');
    remote.request('ssap://system/turnOff').catch((err) => log('sleep timer: ' + err.message));
  } else if (left <= 60000 && sleepWarned !== timer.at) {
    sleepWarned = timer.at;
    lunaSend('luna://com.webos.notification/createToast', { sourceId: 'com.minimal.launcher', message: 'Sleep timer: the TV turns off in 1 minute.' });
  }
}

// ---------------------------------------------------------------- night mode

// The launcher's Night mode setting, from its layout backup: the hour it starts ("22"), or
// "off". Until 7 AM the TV's Eye Comfort Mode (warmer colors) and energy saving (a dimmer
// screen) go on; both are TV-wide, not per input. What they were is kept in NIGHT_FILE while
// night mode is on, and put back in the morning. nightNow() and NIGHT_ENDS must match isNight()
// and NIGHT_ENDS in app/main.js.
const NIGHT_FILE = path.join(CONF, 'night.json');
const NIGHT_ENDS = 7;
const NIGHT_SETTINGS = { eyeComfortMode: 'on', energySaving: 'med' };
let nightBusy = false;

function nightNow() {
  const settings = readJSON(path.join(CONF, 'layout.json'), {}).settings || {};
  if (settings.night == null || settings.night === 'off') return false;
  const from = Number(settings.night);
  const hour = new Date().getHours();
  return from > NIGHT_ENDS ? hour >= from || hour < NIGHT_ENDS : hour >= from && hour < NIGHT_ENDS;
}

function checkNight() {
  const saved = readJSON(NIGHT_FILE, null);
  const want = nightNow();
  if (nightBusy || want === !!saved) return;
  nightBusy = true;
  const settings = 'luna://com.webos.settingsservice/';
  const step = want
    ? lunaCall(settings + 'getSystemSettings', { category: 'picture', keys: Object.keys(NIGHT_SETTINGS) }).then((r) => {
      writeJSON(NIGHT_FILE, { before: r.settings });
      // If the change doesn't take, forget the saved values so the next check tries again.
      return lunaCall(settings + 'setSystemSettings', { category: 'picture', settings: NIGHT_SETTINGS }).catch((err) => {
        fs.unlinkSync(NIGHT_FILE);
        throw err;
      });
    })
    : lunaCall(settings + 'setSystemSettings', { category: 'picture', settings: saved.before || {} }).then(() => fs.unlinkSync(NIGHT_FILE));
  step.then(() => log('night mode ' + (want ? 'on' : 'off')), (err) => log('night mode: ' + err.message))
    .then(() => { nightBusy = false; });
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

// An icon's address on the page, versioned by a hash of the file so a phone fetches a changed
// icon instead of the one in its cache. Hashes are kept until the file's size or date changes.
const iconHashes = new Map();

function iconUrl(icon) {
  if (!icon) return null;
  const name = icon.replace(/^data\/icons\//, '').replace(/^data\//, '');
  const file = path.join(APP_DIR, 'data', 'icons', name);
  let version = '';
  try {
    const st = fs.statSync(file);
    const stamp = st.size + ':' + st.mtimeMs;
    const known = iconHashes.get(file);
    if (known && known.stamp === stamp) version = known.hash;
    else {
      version = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
      iconHashes.set(file, { stamp: stamp, hash: version });
    }
  } catch (e) {
    // Missing file: the page shows the 404 as no icon.
  }
  return '/icons/' + name + '?v=' + version;
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
    icon: iconUrl(a.icon),
    bgColor: a.bgColor,
    favorite: favorites.indexOf(a.key) !== -1,
  }));
  const inputs = (data.inputs || []).map((i) => ({ id: i.appId, title: i.title, icon: iconUrl(i.icon), bgColor: i.bgColor }));
  const known = apps.map((a) => a.id).concat(inputs.map((i) => i.id));
  const recent = readJSON(RECENT_FILE, { apps: [] }).apps.map((a) => a.id).filter((id) => known.indexOf(id) !== -1).slice(0, 6);
  const youtube = data.apps.some((a) => a.id === 'youtube.leanback.v4');
  const plex = !!(data.plex && data.plex.server && data.plex.token);
  return { apps: apps, inputs: inputs, recent: recent, foreground: foreground, youtube: youtube, plex: plex };
}

// ---------------------------------------------------------------- Plex search

function plexServer() {
  const plex = launcherData().plex;
  return plex && plex.server && plex.token ? plex : null;
}

// Resolves with { type, body } for a path on the Plex server.
function plexFetch(plex, pathAndQuery, accept) {
  return new Promise((resolve, reject) => {
    const sep = pathAndQuery.indexOf('?') === -1 ? '?' : '&';
    const opts = parseUrl(plex.server.replace(/\/+$/, '') + pathAndQuery + sep + 'X-Plex-Token=' + encodeURIComponent(plex.token));
    opts.headers = { Accept: accept };
    opts.timeout = 10000;
    const dropped = () => reject(new Error("Plex server didn't answer"));
    const req = (opts.protocol === 'https:' ? https : http).get(opts, (res) => {
      const chunks = [];
      res.on('aborted', dropped);
      res.on('error', dropped);
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Plex answered ' + res.statusCode));
        resolve({ type: res.headers['content-type'], body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.abort());
    req.on('abort', dropped);
    req.on('error', () => reject(new Error("Can't reach the Plex server")));
  });
}

// Movies, shows and episodes matching q, for the phone: titles and the posters' paths.
function plexSearch(q) {
  const plex = plexServer();
  if (!plex) return Promise.reject(new Error('no Plex server is set up'));
  return plexFetch(plex, '/hubs/search?query=' + encodeURIComponent(q) + '&limit=8', 'application/json').then((res) => {
    const out = [];
    (JSON.parse(res.body).MediaContainer.Hub || []).forEach((hub) => {
      if (['movie', 'show', 'episode'].indexOf(hub.type) === -1) return;
      (hub.Metadata || []).forEach((m) => {
        const episode = m.type === 'episode';
        out.push({
          ratingKey: String(m.ratingKey),
          title: episode ? m.grandparentTitle : m.title,
          subtitle: episode ? 'S' + m.parentIndex + ' · E' + m.index + '  ' + m.title
            : (m.type === 'show' ? 'Show' : 'Movie') + (m.year ? ' · ' + m.year : ''),
          thumb: (episode ? m.grandparentThumb || m.thumb : m.thumb) || null,
        });
      });
    });
    return out.slice(0, 24);
  });
}

const PLEX_THUMB = /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

function plexThumb(thumbPath) {
  const plex = plexServer();
  if (!plex || !PLEX_THUMB.test(thumbPath)) return Promise.reject(new Error('not a poster'));
  return plexFetch(plex, '/photo/:/transcode?width=160&height=240&minSize=1&upscale=1&url=' + encodeURIComponent(thumbPath), 'image/jpeg');
}

// PlxNative opens a title when launched with {"plex": {...}}. Before webOS 7.4 it only reads
// that on a cold start, so it's closed first.
function openInPlex(ratingKey) {
  const plex = plexServer() || {};
  if (plex.appId !== PLXNATIVE) return launch(plex.appId || PLXNATIVE);
  const params = { plex: { ratingKey: ratingKey, action: 'open' } };
  if (plex.machineId) params.plex.server = plex.machineId;
  return lunaCall('luna://com.webos.applicationManager/closeByAppId', { id: PLXNATIVE }).catch(() => null)
    .then(() => new Promise((resolve) => setTimeout(resolve, 700)))
    .then(() => remote.request('ssap://system.launcher/launch', { id: PLXNATIVE, params: params }));
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

// Typing from the phone goes into whatever text box is open on the TV, through its keyboard.
const TEXT_MAX = 200;

function act(body) {
  if (typeof body.type === 'string' && body.type.length <= TEXT_MAX) {
    return remote.request('ssap://com.webos.service.ime/insertText', { text: body.type, replace: false });
  }
  if (Number.isInteger(body.erase) && body.erase > 0 && body.erase <= TEXT_MAX) {
    return remote.request('ssap://com.webos.service.ime/deleteCharacters', { count: body.erase });
  }
  if (typeof body.searchYouTube === 'string' && body.searchYouTube.trim() && body.searchYouTube.length <= TEXT_MAX) {
    // The YouTube app takes a search the way it takes one from voice.
    return remote.request('ssap://system.launcher/launch', {
      id: 'youtube.leanback.v4',
      params: { contentTarget: { intent: 'SearchContent', intentParam: body.searchYouTube.trim() } },
    });
  }
  if (typeof body.plexOpen === 'string' && /^\d+$/.test(body.plexOpen)) return openInPlex(body.plexOpen);
  const s = state();
  if (body.launch) {
    if (s.apps.concat(s.inputs).every((a) => a.id !== body.launch)) return Promise.reject(new Error('unknown app'));
    return launch(body.launch);
  }
  switch (body.button) {
    case 'LAUNCHER': return launch(LAUNCHER);
    case 'LGHOME': return launch(LG_HOME);
    case 'MUTE': return new Promise((resolve) => execFile('/home/root/minimal-launcher/bin/commercial-mute', ['150'], () => resolve()));
    case 'POWER': {
      // Started on its own and not waited for: going into standby can stall its last call.
      const child = spawn('/home/root/minimal-launcher/bin/power-off', [], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => log('power-off: ' + err.message));
      child.unref();
      return Promise.resolve();
    }
    case 'TEXTENTER': return remote.request('ssap://com.webos.service.ime/sendEnterKey');
    default:
      if (BUTTONS.indexOf(body.button) === -1) return Promise.reject(new Error('unknown button'));
      return remote.button(body.button);
  }
}

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://tv');
  // Opening the private link once saves the key in a cookie for this phone. SameSite=Lax, not
  // Strict: a link tapped in another app is a cross-site navigation, and a Strict cookie isn't
  // sent on the redirect that follows it. Lax still keeps it off other sites' requests, and
  // /api/act also needs a JSON body, which another site can't send without asking.
  if (url.searchParams.has('k')) {
    if (!sameKey(url.searchParams.get('k'))) return send(res, 403, 'text/plain', 'Wrong link.');
    return send(res, 302, 'text/plain', '', {
      Location: '/',
      'Set-Cookie': 'k=' + KEY + '; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax',
    });
  }
  if (!sameKey(cookieKey(req))) return send(res, 403, 'text/plain', 'Open the private link from the launcher setup on this phone first.');

  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(state()));
  if (req.method === 'GET' && url.pathname === '/api/plex-search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return send(res, 200, 'application/json', '[]');
    return plexSearch(q).then(
      (items) => send(res, 200, 'application/json', JSON.stringify(items)),
      (err) => send(res, 502, 'application/json', JSON.stringify({ error: err.message })));
  }
  if (req.method === 'GET' && url.pathname === '/api/plex-thumb') {
    return plexThumb(url.searchParams.get('path') || '').then(
      (img) => send(res, 200, /^image\//.test(img.type || '') ? img.type : 'image/jpeg', img.body, { 'Cache-Control': 'max-age=86400' }),
      () => send(res, 404, 'text/plain', 'Not found.'));
  }
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
setInterval(checkSleep, 15000);
setInterval(checkNight, 60000);
checkNight();
