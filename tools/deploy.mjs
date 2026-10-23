// Packages the app, installs it on the TV and opens it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { APP_DIR, DATA_DIR, ROOT, bin, deviceName, readAppInfo, readConfig } from './config.mjs';

const config = readConfig();
const device = deviceName(config);
const { id, version } = readAppInfo();
const dist = path.join(ROOT, 'dist');

if (!existsSync(path.join(DATA_DIR, 'data.js'))) {
  console.warn('No app list yet (npm run sync); the launcher will only show inputs.');
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status || 1);
}

mkdirSync(dist, { recursive: true });
run(bin('ares-package'), ['-o', dist, APP_DIR]);
run(bin('ares-install'), ['-d', device, path.join(dist, `${id}_${version}_all.ipk`)]);
run(bin('ares-launch'), ['-d', device, id]);
