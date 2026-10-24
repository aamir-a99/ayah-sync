# Ayah Sync

Follow any Quran recitation video word by word, with the translation underneath.

Open a recitation on YouTube, click **Sync**, and a small card shows the ayah
being recited — each Arabic word lighting up as the reciter says it — with its
meaning in your language. Pause, rewind or jump between ayahs and it stays in
step.

<!-- Add a short screen recording or screenshot here: docs/demo.gif -->

- Works on real recordings, including masjid prayers, not only studio audio
- Word-by-word highlight that follows the video, even after pausing or seeking
- Previous / repeat / next ayah, and a ribbon you can click to jump to any ayah
- Uthmani or IndoPak script
- Translations: English, Urdu, Indonesian, Bengali, Turkish, French
- A floating card that can stay on top of other tabs and apps

**Status: early.** It is not on the Chrome Web Store. You load the extension by
hand and run a small helper program on your own computer. See
[Known limits](#known-limits).

## What you need

- Windows 10/11 (macOS and Linux should work but are untested)
- Google Chrome
- An NVIDIA graphics card. Without one it still runs, but a sync takes many
  minutes instead of about one
- [Python 3.10+](https://www.python.org/downloads/) — tick **Add python.exe to
  PATH** in the installer
- FFmpeg — in a terminal: `winget install Gyan.FFmpeg`
- About 6 GB of free disk space for the speech models

## Install (once)

1. **Download.** Get `ayah-sync.zip` from the
   [Releases](../../releases) page and unzip it, for example to `C:\AyahSync`.
2. **Start the helper.** Open the `server` folder and double-click `run.bat`.
   The first run installs what it needs and downloads the speech models, which
   can take a while. It is ready when the window says
   `Listening on ws://127.0.0.1:8790`.
3. **Add the extension to Chrome.**
   - Go to `chrome://extensions`
   - Turn on **Developer mode** (top right)
   - Click **Load unpacked** and choose the `extension` folder
4. **Pin it.** Click the puzzle-piece icon in Chrome's toolbar and pin
   **Ayah Sync**.

### On a Mac (untested)

Nobody has tried this on a Mac yet, and it will be slow: the helper can only use
NVIDIA graphics cards, so on a Mac it runs on the processor. Reports welcome.

1. Install [Homebrew](https://brew.sh), then in Terminal: `brew install python ffmpeg`
2. Unzip `ayah-sync.zip`, open Terminal in the `server` folder and run
   `bash run.sh`. Wait for `Listening on ws://127.0.0.1:8790`.
3. Add the extension to Chrome exactly as in step 3 above.

## Use

1. Double-click `server\run.bat` (Mac: `bash run.sh`) and leave its window open.
2. Open a recitation video on YouTube.
3. Click the Ayah Sync icon, then **Sync verses to this video**.
4. The first sync of a video takes roughly a minute. After that the card follows
   the recitation, and that video opens instantly next time.

The card's buttons, left to right: previous ayah, repeat ayah, next ayah,
pause/play, keep on top, close. Script, text size, translation language and
colours are in the extension's popup.

For a **live stream** there is no finished video to sync, so use
*It's a live stream — listen instead*. Live mode estimates the current word
rather than timing it exactly.

## If something goes wrong

| What you see | What to do |
|---|---|
| "The helper is not running" | Start `server\run.bat` and wait for `Listening on …` |
| "Python was not found" | Install Python and tick **Add python.exe to PATH** |
| "FFmpeg was not found" | Run `winget install Gyan.FFmpeg`, then reopen `run.bat` |
| Sync takes many minutes | No NVIDIA card was detected, so it is running on the processor |
| "No Quran recitation was recognised" | The clip may be too short or mostly speech |
| The video won't download | Some sites need a login; try the video's own page, or use live mode |

## Privacy

- Everything runs on your computer. There is no server of ours, no account, no
  ads and no tracking.
- The extension does not record keystrokes, read your browsing history, or read
  the content of pages. On each page it only looks for a video player and the
  page's background colour.
- When you sync, the video's address is passed to the helper on your own
  machine, which downloads the audio into `server/cache`.
- Chrome's install prompt says the extension can "read and change all your data
  on all websites". That permission is what lets the card appear on any site;
  the code is here for you to check what it actually does.

## How it works

1. The helper downloads the video's audio and transcribes it with
   [Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo).
2. The rough transcript is matched against the full text of the Quran to find
   which passages were recited.
3. A [forced-alignment model](https://huggingface.co/jonatasgrosman/wav2vec2-large-xlsr-53-arabic)
   times every word of the known text against the audio — the technique
   quran.com uses for its own word-by-word recitations.
4. The extension reads the video's current time and highlights the matching
   word.

Checked against quran.com's published word timings on three recitations,
79–90% of words land within 0.2 s and at least 97% within 1 s.

## Known limits

- Needs the local helper and, realistically, an NVIDIA graphics card.
- **Keep on top + Adblock Plus:** on YouTube, Adblock Plus closes the floating
  window the moment it opens. Pause Adblock Plus on YouTube (or turn it off) to
  use keep on top. The card inside the page is not affected.
- When a reciter repeats part of an ayah, the highlight drifts for a few seconds.
  On a recitation with heavy repetition only 42% of words landed within 0.2 s.
- IndoPak pause marks are not shown.
- Instagram and TikTok are hit and miss.
- The helper downloads audio with yt-dlp. That is for personal use; check the
  terms of the site you are using.

## For developers

```bash
npm install
npm run build          # extension -> dist/
```

Load `dist/` as an unpacked extension. The helper lives in `server/`; see
[server/README.md](server/README.md). `harness/` runs the built extension in an
ordinary browser tab for testing.

### Browser CPU option (experimental)

Select **Recognition → Browser CPU**, then **Sync verses to this video**. A
bundled quantized `tarteel-ai/whisper-tiny-ar-quran` model runs locally through
WASM, showing verses/translations and learning approximate seek markers as audio
plays. The timeline is always enabled; unheard sections remain unsynced. Markers
last for the tab's browser session. Recognition may be delayed or fail on slow
or busy devices. The existing helper mode remains the default.

CPU mode also requests the existing helper sync in the background. If running,
the Python helper uses yt-dlp/FFmpeg and its configured recognition/alignment
models to produce a full word-timed timeline. The card switches to it when ready.
Without the helper, or if downloading fails, live CPU learning continues.
Optional approximate word highlighting defaults to on and stays inactive until
the helper has fetched audio. Both modes use the same sync progress/ready UI;
background progress does not hide recognized verses on the card.
Only process media you are permitted to download.

To include the CPU model in a build, export it once before `npm run build`:

```bash
python -m pip install 'optimum-onnx[onnxruntime]' 'transformers<5'
python scripts/export-browser-model.py
```

The export downloads the model weights; runtime inference uses bundled files
and does not upload audio. Generated model files are not committed.
Run `npm run test:local` for unit tests. After exporting and building,
`BROWSER_PATH=/path/to/chrome npm run test:capture` tests tab capture, recognition
and timeline navigation; it downloads a short test recording if needed.
On Linux, `bash scripts/run-browser-local.sh` opens an isolated Brave/Chrome
profile with the extension loaded, GPU disabled and no CPU throttling.

## Credits

- Browser speech model: [Tarteel Whisper Tiny Arabic Quran](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran)
  (Apache-2.0), exported to quantized ONNX and run with Transformers.js.
- Quran text and translations: [Al-Quran Cloud](https://alquran.cloud) and
  [quran.com](https://quran.com). Translators: Saheeh International (English),
  Fateh Muhammad Jalandhry (Urdu), Indonesian Ministry of Religious Affairs,
  Muhiuddin Khan (Bengali), Diyanet İşleri (Turkish), Muhammad Hamidullah
  (French). These texts belong to their publishers and are not covered by this
  project's licence.
- Fonts: Amiri Quran, Noto Naskh Arabic and Figtree (SIL Open Font License).

## Support

Ayah Sync is free and always will be. If it helps you, you can support the work at
[ko-fi.com/alivzxc](https://ko-fi.com/alivzxc).

## Licence

The code is released under the [MIT licence](LICENSE).
