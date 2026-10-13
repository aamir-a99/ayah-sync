/**
 * Downloads the extra translation languages from the key-less Al-Quran Cloud
 * API into public/tr/<lang>.json as { "surah:ayah": "text" }. English ships
 * with the Quran data itself (src/data/quran-en.json).
 *
 * Run once: `npm run fetch-translations`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tr');
await mkdir(OUT, { recursive: true });

// Keep in step with LANGS in src/popup/popup.js.
const EDITIONS = {
  ur: 'ur.jalandhry', // Urdu — Fateh Muhammad Jalandhry
  id: 'id.indonesian', // Indonesian — Bahasa Indonesia (Kemenag)
  bn: 'bn.bengali', // Bengali — Muhiuddin Khan
  tr: 'tr.diyanet', // Turkish — Diyanet İşleri
  fr: 'fr.hamidullah', // French — Muhammad Hamidullah
};

for (const [lang, edition] of Object.entries(EDITIONS)) {
  const res = await fetch(`https://api.alquran.cloud/v1/quran/${edition}`);
  const json = await res.json();
  if (!res.ok || json.code !== 200) {
    console.error(`FAILED ${edition}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const map = {};
  for (const s of json.data.surahs) {
    for (const a of s.ayahs) map[`${s.number}:${a.numberInSurah}`] = a.text.trim();
  }
  const body = JSON.stringify(map);
  await writeFile(join(OUT, `${lang}.json`), body);
  console.log(`tr/${lang}.json  ${Object.keys(map).length} ayahs  ${(body.length / 1024).toFixed(0)} KB  ← ${edition}`);
}
