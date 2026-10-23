// Pairs with the TV over LG's network API (the one phone remotes use), reads the installed
// apps and inputs, downloads their icons and writes app/data/ for the launcher to load.
// Stock TVs don't let a sideloaded app list other apps itself, so this does it from here.
import LGTV from 'lgtv2';
import http from 'node:http';
import https from 'node:https';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, readAppInfo, readConfig, requireTvHost, writePrivate } from './config.mjs';

const config = readConfig();
const host = requireTvHost(config);
const selfId = readAppInfo().id;
const ICON_DIR = path.join(DATA_DIR, 'icons');

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

const lgtv = new LGTV({ host, reconnect: false });

lgtv.on('prompt', () => console.log('Accept the connection request on the TV with the remote…'));
lgtv.on('error', (err) => {
  console.error(`Couldn't connect to the TV at ${host}: ${err.message}`);
  console.error('Check that the TV is on and LG Connect Apps is enabled (webOS 5: Settings → All Settings → Connection → Mobile Connection Management).');
  process.exit(1);
});

lgtv.on('connect', async () => {
  try {
    const { launchPoints = [] } = await lgtv.request('ssap://com.webos.applicationManager/listLaunchPoints');
    let devices = [];
    try {
      ({ devices = [] } = await lgtv.request('ssap://tv/getExternalInputList'));
    } catch (err) {
      console.warn(`Couldn't read the input list (${err.message}); the launcher will show HDMI 1–4.`);
    }

    rmSync(ICON_DIR, { recursive: true, force: true });
    mkdirSync(ICON_DIR, { recursive: true });

    const apps = [];
    for (const lp of launchPoints) {
      if (lp.id === selfId || /^com\.webos\.app\.hdmi/.test(lp.id)) continue;
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

    const inputs = [];
    for (const d of devices) {
      inputs.push({ id: d.id, title: d.label || d.id, appId: d.appId });
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
    }

    // An optional picture of your own for the Wallpaper theme.
    let wallpaper = null;
    for (const f of readdirSync(DATA_DIR)) if (f.startsWith('wallpaper.')) rmSync(path.join(DATA_DIR, f));
    if (config.wallpaper) {
      const src = path.resolve(ROOT, config.wallpaper.replace(/^~(?=\/)/, process.env.HOME));
      if (existsSync(src)) {
        wallpaper = `data/wallpaper${path.extname(src).toLowerCase()}`;
        copyFileSync(src, path.join(DATA_DIR, path.basename(wallpaper)));
      } else {
        console.warn(`Wallpaper ${src} not found; leaving the Wallpaper theme out.`);
      }
    }

    const data = { generatedAt: new Date().toISOString(), apps, inputs, plex, wallpaper };
    writePrivate(
      path.join(DATA_DIR, 'data.js'),
      '// Written by `npm run sync`. Rerun it instead of editing.\n' +
        `window.LAUNCHER_DATA = ${JSON.stringify(data, null, 2)};\n`,
    );

    console.log(`Saved ${apps.length} apps and ${inputs.length} inputs${plex ? ', with Plex Continue Watching' : ''}.`);
    console.log('Next: npm run deploy');
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await lgtv.disconnect();
  }
});
