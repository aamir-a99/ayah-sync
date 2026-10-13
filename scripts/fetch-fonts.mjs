/**
 * Downloads the Arabic (woff2) subset of the Quran display fonts from Google
 * Fonts into public/fonts/ so they can be bundled and served locally (no remote
 * font loading at runtime). Run once: `npm run fetch-fonts`.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'fonts');
await mkdir(OUT, { recursive: true });

// A modern Chrome UA makes the css2 API return woff2 (not ttf).
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FONTS = [
  { family: 'Amiri Quran', out: 'uthmani.woff2', subset: 'arabic' }, // Uthmani script
  { family: 'Noto Naskh Arabic', out: 'indopak.woff2', subset: 'arabic' }, // IndoPak text (naskh)
  // Latin face for translations and UI, as on quran.com (variable weight 400–700).
  { family: 'Figtree', axes: ':wght@400..700', out: 'figtree.woff2', subset: 'latin' },
];

async function fetchSubsetWoff2({ family, axes = '', subset }) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}${axes}&display=swap`;
  const css = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  // The CSS has one @font-face per subset, each preceded by a /* subset */ line.
  // Grab the src url from the block labelled with the subset we want.
  const blocks = css.split('/*').map((b) => '/*' + b);
  const block = blocks.find((b) => b.startsWith(`/* ${subset} */`));
  const src = (block || css).match(/url\((https:[^)]+\.woff2)\)/);
  if (!src) throw new Error(`no woff2 url for ${family}`);
  const buf = Buffer.from(await (await fetch(src[1])).arrayBuffer());
  return buf;
}

for (const f of FONTS) {
  try {
    const buf = await fetchSubsetWoff2(f);
    await writeFile(join(OUT, f.out), buf);
    console.log(`fonts/${f.out}  (${(buf.length / 1024).toFixed(0)} KB)  ← ${f.family}`);
  } catch (e) {
    console.error(`FAILED ${f.family}:`, e.message);
    process.exitCode = 1;
  }
}
