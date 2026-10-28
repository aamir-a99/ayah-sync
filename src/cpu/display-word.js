import { normalizeArabic } from './match.js';

// Scripts differ in word spacing and standalone pause signs. Map by text,
// not by assuming an Uthmani word index is also an IndoPak word index.
export function displayWordIndex(source, display, word) {
  if (source === display) return word;
  const tokenize = (text) => text.trim().split(/\s+/).flatMap((w, index) =>
    normalizeArabic(w).split(' ').filter(Boolean).map((text) => ({ text, index })));
  const a = tokenize(source), b = tokenize(display);
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1].text === b[j - 1].text ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  let i = a.length, j = b.length;
  while (i && j) {
    if (a[i - 1].text === b[j - 1].text) {
      if (a[i - 1].index === word) return b[j - 1].index;
      i--; j--;
    } else if (rows[i - 1][j] > rows[i][j - 1]) i--;
    else j--;
  }
  return -1;
}
