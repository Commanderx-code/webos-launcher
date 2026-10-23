// Packages the app, installs it on the TV and opens it. --no-launch installs without opening it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, DATA_DIR, ROOT, bin, deviceName, readAppInfo, readConfig, saveInstalledSignature } from './config.mjs';
import { installIpk, isRooted, launchApp } from './tv-root.mjs';

export async function deploy({ launch = true } = {}) {
  const config = readConfig();
  const device = deviceName(config);
  const { id, version } = readAppInfo();
  const dist = path.join(ROOT, 'dist');

  if (!existsSync(path.join(DATA_DIR, 'data.js'))) {
    console.warn('No app list yet (npm run sync); the launcher will only show inputs.');
  }

  const run = (cmd, args) => {
    const res = spawnSync(cmd, args, { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`${path.basename(cmd)} failed`);
  };

  mkdirSync(dist, { recursive: true });
  run(bin('ares-package'), ['-o', dist, APP_DIR]);
  const ipk = path.join(dist, `${id}_${version}_all.ipk`);
  if (isRooted(config)) {
    // Rooted TV: root SSH instead of Developer Mode (see tv-root.mjs).
    await installIpk(ipk, config);
    console.log('Installed.');
    saveInstalledSignature();
    if (launch) launchApp(id, config);
  } else {
    run(bin('ares-install'), ['-d', device, ipk]);
    saveInstalledSignature();
    if (launch) run(bin('ares-launch'), ['-d', device, id]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deploy({ launch: !process.argv.includes('--no-launch') });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
