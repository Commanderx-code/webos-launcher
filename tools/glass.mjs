// One-color icons for the glass icon styles: each app's logo as a silhouette in white, in its
// brand color and in ice blue. They're colored here rather than with a CSS mask, which the TV
// won't apply to a file:// picture.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const SIMPLE_ICONS = path.join(ROOT, 'node_modules', 'simple-icons', 'icons');
const OWN_ICONS = path.join(ROOT, 'tools', 'glass-icons');

// By app ID. slug: a Simple Icons logo (clean vector, better than tracing the TV's icon);
// svg: a drawing in tools/glass-icons; light: keep only the icon's light parts.
// Colors are the brand's, lightened where the real one is too dark to read on glass.
// Apps not listed get their TV icon traced, in white.
const GLASS = {
  netflix: { slug: 'netflix', color: '#E50914' },
  'youtube.leanback.v4': { slug: 'youtube', color: '#FF1F1F' },
  'youtube.leanback.ytv.v1': { slug: 'youtubetv', color: '#FF1F1F' },
  'cdp-30': { slug: 'plex', color: '#EBAF00' },
  'com.beb.plxnative': { slug: 'plex', color: '#EBAF00' },
  hulu: { color: '#1CE783' },
  'com.wbd.stream': { color: '#6E8BFF' },
  amazon: { slug: 'primevideo', color: '#1FA8F7' },
  'com.disney.disneyplus-prod': { color: '#6FB8FF' },
  'com.espn.espnplus-prod': { color: '#FF3B3B' },
  'com.cbs-all-access.webapp.prod': { slug: 'paramountplus', color: '#4D94FF' },
  'com.discovery.dplus': { color: '#4D8BFF' },
  'spotify-beehive': { slug: 'spotify', color: '#1ED760' },
  'com.starz.app.starz-lgtv': { slug: 'starz' },
  'fox.one-v1.0': { slug: 'fox' },
  'com.webos.app.discovery': { slug: 'lg', color: '#FF4D7A' },
  'com.webos.app.browser': { color: '#6CC4FF' },
  'org.webosbrew.hbchannel': { color: '#FF4D8C' },
  'org.webosbrew.safeupdate': { color: '#FF9A3C' },
  'org.webosbrew.inputhook': { svg: 'remote.svg' },
  'ooo.lew.lifesgoodwithoutspying': { light: true, color: '#7FE0C8' },
  'com.amazoff.patcher': { color: '#FF9900' },
  'pl.krzywro.webos-bluetooth-disabler': { slug: 'bluetooth', color: '#5AA0FF' },
};

const ICE = '#A8DCFF';
const OUT = ['-resize', '360x360>', '-define', 'png:exclude-chunks=date,time'];

function magick(args) {
  const res = spawnSync('magick', args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error((res.stderr || res.error || '').toString().trim());
  return res.stdout;
}

function fromSvg(file, out) {
  magick(['-background', 'none', '-density', '1200', file, '-fill', 'white', '-colorize', '100', '-trim', '+repage', ...OUT, out]);
}

// An icon on a solid square loses every pixel near the square's color (so holes in the logo
// open up too); what's left turns white.
function trace(src, out, light) {
  if (light) {
    magick([src + '[0]', '(', '+clone', '-alpha', 'off', '-colorspace', 'gray', '-level', '35%,60%', ')',
      '(', '-clone', '0', '-alpha', 'extract', ')', '(', '-clone', '1,2', '-compose', 'multiply', '-composite', ')',
      '-delete', '0-2', '-background', 'white', '-alpha', 'shape', '-trim', '+repage', ...OUT, out]);
    return;
  }
  const corner = magick([src + '[0]', '-alpha', 'on', '-format', '%[fx:p{2,2}.a] %[pixel:p{2,2}]', 'info:']).split(' ');
  const knockout = Number(corner[0]) > 0.5 ? ['-fuzz', '22%', '-transparent', corner[1]] : [];
  magick([src + '[0]', '-alpha', 'on', ...knockout, '-trim', '+repage', '-fill', 'white', '-colorize', '100', ...OUT, out]);
}

// Adds glass: { white, brand, ice } (three pictures) to an app or input. look is its config.json
// "tiles" entry, where glassIcon (a picture to trace, or an .svg) and glassColor override the
// built-in choice.
export function addGlass(target, iconDir, dataDir, look = {}) {
  const known = GLASS[target.id] || {};
  const name = String(target.key || target.id).replace(/[^a-z0-9._-]/gi, '_') + '.png';
  const out = path.join(iconDir, 'mono-' + name);
  const current = target.icon && path.join(dataDir, target.icon.replace(/^data\//, ''));
  try {
    const own = look.glassIcon;
    const simple = known.slug && path.join(SIMPLE_ICONS, known.slug + '.svg');
    if (own && own.endsWith('.svg')) fromSvg(own, out);
    else if (own) trace(own, out, false);
    else if (known.svg) fromSvg(path.join(OWN_ICONS, known.svg), out);
    else if (simple && existsSync(simple)) fromSvg(simple, out);
    else if (current) trace(current, out, known.light);
    else return;
    const tint = (color, file) => magick([out, '-fill', color, '-colorize', '100', ...OUT, path.join(iconDir, file)]);
    tint(look.glassColor || known.color || '#FFFFFF', 'glass-brand-' + name);
    tint('#FFFFFF', 'glass-white-' + name);
    tint(ICE, 'glass-ice-' + name);
    rmSync(out);
  } catch (err) {
    console.warn(`  no glass icon for ${target.title}: ${err.message}`);
    return;
  }
  target.glass = { white: `data/icons/glass-white-${name}`, brand: `data/icons/glass-brand-${name}`, ice: `data/icons/glass-ice-${name}` };
}
