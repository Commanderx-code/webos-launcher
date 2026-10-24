// Keeps the apps installed from the Homebrew Channel's official repository up to date (rooted
// TVs). Each newer version is downloaded, checked against the SHA-256 the repository publishes,
// and installed over root SSH. An app that's on screen is left for the next run.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, readConfig } from './config.mjs';
import { installIpk, isRooted, runRemoteNode } from './tv-root.mjs';

const REPO = 'https://repo.webosbrew.org/api/apps.json';
// Not ours to update: the launcher deploys itself, and the Homebrew Channel and its updater
// update themselves (the channel also has to re-elevate its own service afterwards).
const SKIP = ['com.minimal.launcher', 'org.webosbrew.hbchannel', 'org.webosbrew.safeupdate'];

// Whether version a is newer than b, comparing dotted numbers.
function newer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// The sideloaded apps on the TV and their versions, read there by its own Node.
function installedApps(config) {
  const out = runRemoteNode(`
    const fs = require('fs'), dir = '/media/developer/apps/usr/palm/applications';
    const apps = {};
    for (const id of fs.readdirSync(dir)) {
      try { apps[id] = JSON.parse(fs.readFileSync(dir + '/' + id + '/appinfo.json', 'utf8')).version; } catch (e) {}
    }
    console.log(JSON.stringify(apps));`, config);
  return JSON.parse(out);
}

export async function updateApps(config = readConfig(), { foreground = null } = {}) {
  if (!isRooted(config)) return [];
  const installed = installedApps(config);
  const repo = (await (await fetch(REPO, { signal: AbortSignal.timeout(20000) })).json()).packages;
  const updated = [];
  for (const [id, version] of Object.entries(installed)) {
    if (SKIP.includes(id)) continue;
    const entry = repo.find((p) => p.id === id);
    const m = entry && entry.manifest;
    if (!m || !m.ipkUrl || !m.ipkHash || !m.ipkHash.sha256 || !newer(m.version, version)) continue;
    if (id === foreground) {
      console.log(`${entry.title} ${m.version} is out, but it's on screen; next run.`);
      continue;
    }
    const res = await fetch(m.ipkUrl, { signal: AbortSignal.timeout(300000) });
    const ipk = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(ipk).digest('hex');
    if (!res.ok || sha !== m.ipkHash.sha256) {
      console.warn(`${entry.title} ${m.version}: the download doesn't match the repository's checksum; not installing.`);
      continue;
    }
    const file = path.join(ROOT, 'media', 'ipk', `${id}.ipk`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, ipk);
    await installIpk(file, config);
    console.log(`Updated ${entry.title} from ${version} to ${m.version}.`);
    updated.push(id);
  }
  return updated;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const updated = await updateApps();
    if (!updated.length) console.log('Every app is up to date.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
