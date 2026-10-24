// Run on a timer: if the TV is on, updates the sideloaded apps that have new versions, and if
// its apps, inputs or the settings in config.json changed since the last install, reinstalls
// the launcher without opening it.
import LGTV from 'lgtv2';
import { deploy } from './deploy.mjs';
import { runSync } from './sync.mjs';
import { updateApps } from './app-updates.mjs';
import { dataSignature, readAppInfo, readConfig, readInstalledSignature } from './config.mjs';

function foregroundApp(host) {
  return new Promise((resolve) => {
    const lgtv = new LGTV({ host, reconnect: false });
    lgtv.on('error', () => resolve(null));
    lgtv.on('connect', async () => {
      try {
        resolve((await lgtv.request('ssap://com.webos.applicationManager/getForegroundAppInfo')).appId || null);
      } catch {
        resolve(null);
      }
      await lgtv.disconnect();
    });
  });
}

try {
  await runSync();
} catch (err) {
  // Usually the TV is off or in standby; the next run tries again.
  console.log(`TV not reachable (${err.message}); nothing to do.`);
  process.exit(0);
}

const host = readConfig().tv.host;
const foreground = await foregroundApp(host);

try {
  await updateApps(readConfig(), { foreground });
} catch (err) {
  console.warn(`App updates skipped: ${err.message}`);
}

if (dataSignature() === readInstalledSignature()) {
  console.log('No changes since the last install.');
  process.exit(0);
}

// Reinstalling closes the launcher, so wait while someone is using it.
if (foreground === readAppInfo().id) {
  console.log('Changes found, but the launcher is on screen; trying again next run.');
  process.exit(0);
}

console.log('Changes found; reinstalling the launcher.');
try {
  await deploy({ launch: false });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
