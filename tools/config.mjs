import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(ROOT, 'app');
export const DATA_DIR = path.join(APP_DIR, 'data');
const CONFIG = path.join(ROOT, 'config.json');

export function readConfig() {
  if (!existsSync(CONFIG)) return {};
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

// For files holding the Plex token: the mode option only applies when the file is created,
// so tighten one that already existed too.
export function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function writeConfig(config) {
  writePrivate(CONFIG, JSON.stringify(config, null, 2) + '\n');
}

export function readAppInfo() {
  return JSON.parse(readFileSync(path.join(APP_DIR, 'appinfo.json'), 'utf8'));
}

export function requireTvHost(config) {
  const host = config.tv && config.tv.host;
  if (!host) {
    console.error('Set "tv.host" in config.json to your TV\'s IP address (copy config.example.json to start).');
    process.exit(1);
  }
  return host;
}

export function deviceName(config) {
  return (config.tv && config.tv.device) || 'tv';
}

export function bin(name) {
  const file = path.join(ROOT, 'node_modules', '.bin', name);
  if (!existsSync(file)) {
    console.error(`${name} is missing. Run "npm install" first.`);
    process.exit(1);
  }
  return file;
}

const INSTALLED = path.join(ROOT, 'dist', 'installed.json');

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .sort();
}

// A fingerprint of everything that goes into the package, minus the sync's timestamp, so an
// unchanged sync matches the last install.
export function dataSignature() {
  const hash = createHash('sha256');
  for (const file of filesUnder(APP_DIR)) {
    if (file === path.join(DATA_DIR, 'layout.js')) continue;
    let content = readFileSync(file);
    if (file === path.join(DATA_DIR, 'data.js')) content = content.toString().replace(/"generatedAt": "[^"]*",?/, '');
    hash.update(path.relative(APP_DIR, file)).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

export function readInstalledSignature() {
  return existsSync(INSTALLED) ? JSON.parse(readFileSync(INSTALLED, 'utf8')).signature : null;
}

export function saveInstalledSignature() {
  mkdirSync(path.dirname(INSTALLED), { recursive: true });
  writeFileSync(INSTALLED, JSON.stringify({ signature: dataSignature(), installedAt: new Date().toISOString() }, null, 2) + '\n');
}
