// Resets the 50-hour Developer Mode timer, as the "Extend" button in LG's Developer Mode app does.
// When the timer runs out the TV deletes sideloaded apps, the launcher included.
import { spawnSync } from 'node:child_process';
import { bin, deviceName, readConfig, writeConfig } from './config.mjs';

const config = readConfig();
const device = deviceName(config);
const saved = config.tv && config.tv.devModeToken;

// The session token stays the same until Developer Mode is turned off and on again, so a copy
// saved from the last read lets this run while the TV is in standby.
const res = spawnSync(bin('ares-novacom'), ['-d', device, '--run', 'cat /var/luna/preferences/devmode_enabled'], {
  encoding: 'utf8',
  timeout: 20000,
});
let token = res.status === 0 ? (res.stdout || '').trim() : '';
if (token) {
  if (token !== saved) {
    config.tv = { ...(config.tv || {}), devModeToken: token };
    writeConfig(config);
  }
} else if (saved) {
  console.log(`Couldn't reach "${device}"; using the saved session token.`);
  token = saved;
} else {
  console.error(`Couldn't read the Developer Mode session from "${device}". Turn the TV on and run this once.`);
  console.error((res.stderr || '').trim());
  process.exit(1);
}

const base = 'https://developer.lge.com/secure';
const reset = await fetch(`${base}/ResetDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`);
if (!reset.ok) {
  console.error(`LG answered ${reset.status}; extend it from the Developer Mode app on the TV instead.`);
  process.exit(1);
}
const check = await fetch(`${base}/CheckDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`);
console.log(`Extended. LG says: ${(await check.text()).trim()}`);
