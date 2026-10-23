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

// Copies the folder's pictures and videos into app/data/saver for the screensaver.
export function prepareScreensaver(folder) {
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
      slides.push({ src: `data/saver/${name}`, video });
    } catch (err) {
      console.warn(`  skipped ${f}: ${err.message}`);
    }
  });
  return slides.length ? slides : null;
}
