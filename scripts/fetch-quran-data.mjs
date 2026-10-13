/**
 * Downloads the full Quran (Uthmani Arabic + one English translation) from the
 * free, key-less Al-Quran Cloud API and writes compact JSON into src/data/ for
 * offline, on-device matching. Run once: `npm run fetch-data`.
 *
 * Output files:
 *   src/data/quran-uthmani.json  → { "1:1": "بِسْمِ ٱللَّهِ...", ... }  (6236 ayahs)
 *   src/data/quran-en.json       → { "1:1": "In the name of Allah...", ... }
 *   src/data/surahs.json         → [{ number, name, englishName, englishNameTranslation, ayahs }]
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');

const ARABIC_EDITION = 'quran-uthmani';
const EN_EDITION = 'en.sahih'; // Saheeh International

async function getEdition(edition) {
  const url = `https://api.alquran.cloud/v1/quran/${edition}`;
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${edition}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 200) throw new Error(`${edition}: API code ${json.code}`);
  return json.data; // { surahs: [ { number, name, englishName, englishNameTranslation, ayahs:[{numberInSurah,text}] } ] }
}

// Al-Quran Cloud prepends the basmala to ayah 1 of every surah (except 1 and 9).
// It is not part of those ayahs, so strip it — otherwise ayah 1 shows four
// words nobody recited and every word index in it is off by four.
function stripBasmala(surah, ayah, text, isArabic) {
  if (!isArabic || ayah !== 1 || surah === 1 || surah === 9) return text;
  const words = text.split(/\s+/);
  return words.length > 4 && words[0].replace(/[^ء-ي]/g, '') === 'بسم'
    ? words.slice(4).join(' ')
    : text;
}

function toAyahMap(data, isArabic = false) {
  const map = {};
  for (const surah of data.surahs) {
    for (const ayah of surah.ayahs) {
      map[`${surah.number}:${ayah.numberInSurah}`] = stripBasmala(
        surah.number, ayah.numberInSurah, ayah.text, isArabic);
    }
  }
  return map;
}

function toSurahMeta(data) {
  return data.surahs.map((s) => ({
    number: s.number,
    name: s.name, // Arabic
    englishName: s.englishName, // transliteration, e.g. "Al-Faatiha"
    englishNameTranslation: s.englishNameTranslation, // e.g. "The Opening"
    ayahs: s.ayahs.length,
    revelationType: s.revelationType,
  }));
}

async function main() {
  const [arabic, english] = await Promise.all([
    getEdition(ARABIC_EDITION),
    getEdition(EN_EDITION),
  ]);

  const arabicMap = toAyahMap(arabic, true);
  const englishMap = toAyahMap(english);
  const surahs = toSurahMeta(arabic);

  await writeFile(join(DATA_DIR, 'quran-uthmani.json'), JSON.stringify(arabicMap));
  await writeFile(join(DATA_DIR, 'quran-en.json'), JSON.stringify(englishMap));
  await writeFile(join(DATA_DIR, 'surahs.json'), JSON.stringify(surahs));

  console.log(
    `Wrote ${Object.keys(arabicMap).length} ayahs (Arabic + English) and ${surahs.length} surahs to src/data/`,
  );
}

main().catch((err) => {
  console.error('Failed to fetch Quran data:', err);
  process.exit(1);
});
