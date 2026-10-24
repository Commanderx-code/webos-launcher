// Converts pictures and videos to 1920x1080 for the TV: JPEG for pictures, silent H.264 for
// videos. Converted files are cached in media/cache by source path, size and date, so the
// hourly sync only converts what's new or changed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.mjs';

const CACHE = path.join(ROOT, 'media', 'cache');
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
export const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv'];

export function expandHome(p) {
  return path.resolve(ROOT, p.replace(/^~(?=\/|$)/, process.env.HOME));
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.error) throw new Error(`${cmd} is missing: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} failed: ${(res.stderr || '').trim().split('\n').pop()}`);
}

// Returns the cached 1080p version of a file, converting it first if needed.
export function convert(src) {
  const ext = path.extname(src).toLowerCase();
  const video = VIDEO_EXTS.includes(ext);
  const st = statSync(src);
  const key = createHash('sha1').update(`${src}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16);
  const out = path.join(CACHE, key + (video ? '.mp4' : '.jpg'));
  if (existsSync(out)) return { file: out, video };

  mkdirSync(CACHE, { recursive: true });
  const tmp = out + '.part' + (video ? '.mp4' : '.jpg');
  console.log(`  converting ${path.basename(src)}…`);
  if (video) {
    run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-an',
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,format=yuv420p',
      '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'medium', '-crf', '23',
      '-movflags', '+faststart', tmp]);
  } else {
    run('magick', [src + '[0]', '-auto-orient', '-resize', '1920x1080^', '-gravity', 'center',
      '-extent', '1920x1080', '-strip', '-quality', '85', tmp]);
  }
  copyFileSync(tmp, out);
  rmSync(tmp);
  return { file: out, video };
}

// A name for a file without one in config.json: "Dark-lords-castle.jpeg" becomes "Dark lords castle".
function nameFrom(file) {
  const base = path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// A video that's already H.264 at 1080p or less goes to the TV as it is, since converting it
// again would only lose quality. Everything else is converted.
function forTv(src) {
  if (VIDEO_EXTS.includes(path.extname(src).toLowerCase())) {
    const res = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,height',
      '-of', 'csv=p=0', src], { encoding: 'utf8' });
    const [codec, height] = (res.stdout || '').trim().split(',');
    if (codec === 'h264' && Number(height) <= 1080) return { file: src, video: true };
  }
  return convert(src);
}

// Copies the wallpapers into app/data/wallpapers. Each is { name, file } in config.json and
// becomes a theme of its own.
export function prepareWallpapers(list) {
  const dest = path.join(DATA_DIR, 'wallpapers');
  rmSync(dest, { recursive: true, force: true });
  const out = [];
  list.forEach((w) => {
    const src = expandHome(w.file);
    const name = w.name || nameFrom(src);
    const slug = name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wallpaper';
    if (!existsSync(src)) {
      console.warn(`Wallpaper ${src} not found; leaving ${name} out.`);
      return;
    }
    try {
      const { file, video } = forTv(src);
      const id = out.some((o) => o.id === 'wall-' + slug) ? 'wall-' + slug + '-' + out.length : 'wall-' + slug;
      mkdirSync(dest, { recursive: true });
      copyFileSync(file, path.join(dest, id + path.extname(file)));
      out.push({ id, name, src: `data/wallpapers/${id}${path.extname(file)}`, video });
    } catch (err) {
      console.warn(`  skipped wallpaper ${name}: ${err.message}`);
    }
  });
  return out.length ? out : null;
}

// Copies the folder's pictures and videos into app/data/saver for the screensaver. names maps
// a file name to the name shown in the sidebar's screensaver picker.
export function prepareScreensaver(folder, names = {}) {
  const dest = path.join(DATA_DIR, 'saver');
  rmSync(dest, { recursive: true, force: true });
  if (!folder) return null;
  const dir = expandHome(folder);
  if (!existsSync(dir)) {
    console.warn(`Screensaver folder ${dir} not found; using Plex artwork instead.`);
    return null;
  }
  const files = readdirSync(dir)
    .filter((f) => [...IMAGE_EXTS, ...VIDEO_EXTS].includes(path.extname(f).toLowerCase()))
    .sort();
  mkdirSync(dest, { recursive: true });
  const slides = [];
  files.forEach((f, i) => {
    try {
      const { file, video } = convert(path.join(dir, f));
      const name = `${String(i + 1).padStart(2, '0')}${path.extname(file)}`;
      copyFileSync(file, path.join(dest, name));
      slides.push({ id: f, name: names[f] || nameFrom(f), src: `data/saver/${name}`, video });
    } catch (err) {
      console.warn(`  skipped ${f}: ${err.message}`);
    }
  });
  return slides.length ? slides : null;
}
