// Installs any .ipk on the TV: over root SSH on a rooted TV, otherwise through Developer Mode.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { bin, deviceName, readConfig } from './config.mjs';
import { installIpk, isRooted } from './tv-root.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run install-ipk -- <file.ipk> [more.ipk …]');
  process.exit(1);
}
const config = readConfig();
for (const file of files) {
  try {
    if (isRooted(config)) await installIpk(path.resolve(file), config);
    else if (spawnSync(bin('ares-install'), ['-d', deviceName(config), file], { stdio: 'inherit' }).status !== 0) throw new Error('ares-install failed');
    console.log(`Installed ${path.basename(file)}.`);
  } catch (err) {
    console.error(`${path.basename(file)}: ${err.message}`);
    process.exitCode = 1;
  }
}
