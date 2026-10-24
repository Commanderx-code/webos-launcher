// Pairs with the TV over LG's network API (the one phone remotes use), reads the installed
// apps and inputs, downloads their icons and writes app/data/ for the launcher to load.
// Stock TVs don't let a sideloaded app list other apps itself, so this does it from here.
import LGTV from 'lgtv2';
import http from 'node:http';
import https from 'node:https';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, ROOT, readAppInfo, readConfig, requireTvHost, writeConfig, writePrivate } from './config.mjs';
import { expandHome, prepareScreensaver } from './media.mjs';
import { isRooted, readRemote, writeRemote } from './tv-root.mjs';
import { fetchWatchlist } from './watchlist.mjs';
import { spawnSync } from 'node:child_process';

const ICON_DIR = path.join(DATA_DIR, 'icons');
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v'];

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    // The TV serves icons with a certificate from LG's private CA.
    const req = client.get(url, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

function connect(host) {
  return new Promise((resolve, reject) => {
    const lgtv = new LGTV({ host, reconnect: false });
    lgtv.on('prompt', () => console.log('Accept the connection request on the TV with the remote…'));
    lgtv.on('error', reject);
    lgtv.on('connect', () => resolve(lgtv));
  });
}

// Turns the ZIP code in config.json into coordinates for the weather service. The answer is
// saved in config.json, so a later sync never loses the weather to a failed lookup.
async function locate(config) {
  const weather = config.weather;
  if (!weather || !weather.zip) return null;
  const units = weather.units || 'fahrenheit';
  const saved = weather.located;
  if (saved && saved.zip === weather.zip) return { latitude: saved.latitude, longitude: saved.longitude, place: saved.place, units };
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json' +
    `&countryCode=${encodeURIComponent(weather.country || 'US')}&name=${encodeURIComponent(weather.zip)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const place = ((await res.json()).results || [])[0];
    if (!place) throw new Error(`no place found for ${weather.zip}`);
    weather.located = { zip: weather.zip, latitude: place.latitude, longitude: place.longitude, place: place.name };
    writeConfig(config);
    return { latitude: place.latitude, longitude: place.longitude, place: place.name, units };
  } catch (err) {
    console.warn(`Weather left out: ${err.message}`);
    return null;
  }
}

function wallpaperFrom(config) {
  for (const f of readdirSync(DATA_DIR)) if (f.startsWith('wallpaper.')) rmSync(path.join(DATA_DIR, f));
  if (!config.wallpaper) return null;
  const src = path.resolve(ROOT, config.wallpaper.replace(/^~(?=\/)/, process.env.HOME));
  if (!existsSync(src)) {
    console.warn(`Wallpaper ${src} not found; leaving the Wallpaper theme out.`);
    return null;
  }
  const ext = path.extname(src).toLowerCase();
  copyFileSync(src, path.join(DATA_DIR, `wallpaper${ext}`));
  return { src: `data/wallpaper${ext}`, video: VIDEO_EXTS.includes(ext) };
}

export async function runSync() {
  const config = readConfig();
  const host = requireTvHost(config);
  const selfId = readAppInfo().id;
  const lgtv = await connect(host);

  try {
    const { launchPoints = [] } = await lgtv.request('ssap://com.webos.applicationManager/listLaunchPoints');
    let devices = [];
    try {
      ({ devices = [] } = await lgtv.request('ssap://tv/getExternalInputList'));
    } catch (err) {
      console.warn(`Couldn't read the input list (${err.message}); the launcher will show HDMI 1–4.`);
    }

    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(ICON_DIR, { recursive: true, force: true });
    mkdirSync(ICON_DIR, { recursive: true });

    async function saveIcon(url, name) {
      if (!url) return null;
      const absolute = /^https?:/.test(url) ? url : `http://${host}:3000${url.startsWith('/') ? '' : '/'}${url}`;
      const ext = (path.extname(new URL(absolute).pathname) || '.png').toLowerCase();
      const file = name.replace(/[^a-z0-9._-]/gi, '_') + ext;
      try {
        writeFileSync(path.join(ICON_DIR, file), await download(absolute));
        return `data/icons/${file}`;
      } catch (err) {
        console.warn(`  no icon for ${name}: ${err.message}`);
        return null;
      }
    }

    // Apps left out of the launcher altogether, by ID or title.
    const matches = (list, lp) => list.some((e) => [lp.id, String(lp.title)].some((v) => v.toLowerCase() === e.toLowerCase()));
    const apps = [];
    for (const lp of launchPoints) {
      if (lp.id === selfId || /^com\.webos\.app\.hdmi/.test(lp.id)) continue;
      if (matches(config.exclude || [], lp)) continue;
      const key = lp.launchPointId || lp.id;
      apps.push({
        key,
        id: lp.id,
        title: lp.title,
        icon: await saveIcon(lp.largeIcon || lp.icon, key),
        // webOS 5's home bar colors each app card with iconColor; bgColor is usually empty.
        bgColor: lp.iconColor || lp.bgColor || null,
        params: lp.params || null,
      });
    }

    // The starting Favorites row; changes made on the TV with the green button take over after that.
    const favorites = (config.favorites || [])
      .map((name) => apps.find((a) => [a.id, a.title].some((v) => v.toLowerCase() === name.toLowerCase())))
      .filter(Boolean)
      .map((a) => a.key);

    // Inputs with nothing plugged in are left out unless config.json asks for all of them.
    // Names: config.json first, then what the device calls itself over HDMI-CEC, then the TV's label.
    const names = config.inputNames || {};
    const inputs = [];
    for (const d of devices) {
      if (d.connected === false && !config.showAllInputs) continue;
      const cec = (d.subList || []).map((s) => s.osdName).filter(Boolean)[0];
      inputs.push({ id: d.id, title: names[d.id] || cec || d.label || d.id, appId: d.appId });
    }

    // Your own tile looks from config.json "tiles", keyed by app name or ID, or input ID or name:
    // a new name, a background color, a picture for the icon (trimmed of plain margins), and removeBackground
    // to make the icon's plain border see-through, for icons that come on a solid square.
    for (const [name, look] of Object.entries(config.tiles || {})) {
      const lower = name.toLowerCase();
      const targets = [
        ...apps.filter((a) => [a.id, a.key, a.title].some((v) => String(v).toLowerCase() === lower)),
        ...inputs.filter((i) => [i.id, i.title].some((v) => String(v).toLowerCase() === lower)),
      ];
      if (!targets.length) {
        console.warn(`tiles: nothing on the TV is called "${name}".`);
        continue;
      }
      let icon = null;
      const current = targets[0].icon && path.join(DATA_DIR, targets[0].icon.replace(/^data\//, ''));
      if (look.icon || (look.removeBackground && current)) {
        const src = look.icon ? expandHome(look.icon) : current;
        const file = `tile-${name.replace(/[^a-z0-9._-]/gi, '_')}.png`;
        // Flood-fill from each corner, so only the border goes, not white inside the logo.
        const knockout = look.removeBackground
          ? ['-alpha', 'set', '-fuzz', '12%', '-fill', 'none', '-draw', 'color 0,0 floodfill', '-draw', 'color %[fx:w-1],0 floodfill',
            '-draw', 'color 0,%[fx:h-1] floodfill', '-draw', 'color %[fx:w-1],%[fx:h-1] floodfill']
          : [];
        // No date stamps in the PNG, so an unchanged tile hashes the same and doesn't trigger a reinstall.
        const res = spawnSync('magick', [src + '[0]', ...knockout, '-trim', '+repage', '-resize', '400x400>',
          '-define', 'png:exclude-chunks=date,time', path.join(ICON_DIR, file)], { encoding: 'utf8' });
        if (res.status === 0) icon = `data/icons/${file}`;
        else console.warn(`tiles: couldn't use ${src}: ${(res.stderr || res.error || '').toString().trim()}`);
      }
      for (const t of targets) {
        if (look.title) t.title = look.title;
        if (look.bgColor) t.bgColor = look.bgColor;
        if (icon) t.icon = icon;
      }
    }

    let plex = null;
    if (config.plex && config.plex.server && config.plex.token) {
      const found = launchPoints.find((lp) => /^plex$/i.test(lp.title));
      plex = {
        server: config.plex.server,
        token: config.plex.token,
        appId: config.plex.appId || (found && found.id) || 'cdp-30',
      };
      if (!found && !config.plex.appId) console.warn('Plex isn\'t installed on the TV; its tile will be missing.');
      // The server's ID, for apps that open a given title on it (PlxNative). Saved once found.
      if (!config.plex.machineId) {
        try {
          const res = await fetch(`${config.plex.server}/identity`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
          config.plex.machineId = (await res.json()).MediaContainer.machineIdentifier;
          writeConfig(config);
        } catch (err) {
          console.warn(`Couldn't read the Plex server's ID: ${err.message}`);
        }
      }
      if (config.plex.machineId) plex.machineId = config.plex.machineId;
    }

    // The layout the launcher backs up on a rooted TV, kept here too and packaged for a fresh
    // install. It's left out of the install fingerprint, so a layout change alone doesn't reinstall.
    const rooted = isRooted(config);
    if (rooted) {
      const text = readRemote('/home/root/.config/minimal-launcher/layout.json', config);
      let layout = null;
      try {
        layout = text && JSON.parse(text);
      } catch {
        console.warn('The layout backup on the TV is unreadable; keeping the previous copy.');
      }
      if (layout) {
        mkdirSync(path.join(ROOT, 'backup'), { recursive: true });
        writeFileSync(path.join(ROOT, 'backup', 'layout.json'), JSON.stringify(layout, null, 2) + '\n');
      }
    }
    // The Plex Watchlist goes straight to the TV, so a change to it doesn't need a reinstall.
    if (rooted && plex) {
      try {
        const watchlist = await fetchWatchlist({ server: plex.server, token: plex.token });
        if (!writeRemote('/home/root/.config/minimal-launcher/watchlist.json', JSON.stringify({ items: watchlist }), config)) {
          console.warn("Couldn't write the Watchlist to the TV.");
        }
      } catch (err) {
        console.warn(`Watchlist left as it was: ${err.message}`);
      }
    }

    const backup = path.join(ROOT, 'backup', 'layout.json');
    writeFileSync(path.join(DATA_DIR, 'layout.js'), '// Written by `npm run sync` from the TV\'s layout backup.\n' +
      `window.LAUNCHER_LAYOUT = ${existsSync(backup) ? readFileSync(backup, 'utf8').trim() : 'null'};\n`);

    const data = {
      generatedAt: new Date().toISOString(),
      apps,
      favorites,
      inputs,
      plex,
      weather: await locate(config),
      wallpaper: wallpaperFrom(config),
      theme: config.theme || null,
      rooted,
      exclude: config.exclude || [],
      screensaverMinutes: config.screensaverMinutes == null ? 5 : config.screensaverMinutes,
      // Your own pictures and videos for the screensaver; without them it shows Plex artwork.
      screensaver: prepareScreensaver(config.screensaverFolder),
    };
    writePrivate(
      path.join(DATA_DIR, 'data.js'),
      '// Written by `npm run sync`. Rerun it instead of editing.\n' +
        `window.LAUNCHER_DATA = ${JSON.stringify(data, null, 2)};\n`,
    );
    return data;
  } finally {
    await lgtv.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const data = await runSync();
    const extras = [data.plex && 'Plex', data.weather && `weather for ${data.weather.place}`].filter(Boolean);
    console.log(`Saved ${data.apps.length} apps and ${data.inputs.length} inputs${extras.length ? `, with ${extras.join(' and ')}` : ''}.`);
    console.log('Next: npm run deploy');
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    console.error('Check that the TV is on and LG Connect Apps is enabled (webOS 5: Settings → All Settings → Connection → Mobile Connection Management).');
    process.exitCode = 1;
  }
}
