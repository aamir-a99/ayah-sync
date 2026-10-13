// Does a Document Picture-in-Picture window survive on YouTube in a clean
// Chrome profile (no other extensions)? Run: node harness/pip-probe.mjs [url]
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] || 'https://www.youtube.com/watch?v=jEUu_bfiJHQ';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'qlt-probe-')),
  args: ['--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1200,800'],
  defaultViewport: null,
  ...(process.env.QLT_EXT ? { enableExtensions: [process.env.QLT_EXT], pipe: true } : {}),
});
const page = (await browser.pages())[0];
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
await page.evaluate(() => {
  window.__log = [];
  const b = document.createElement('button');
  b.id = 'qltProbe';
  b.textContent = 'PROBE';
  b.style.cssText = 'position:fixed;top:120px;left:40px;z-index:2147483647;font-size:30px;padding:20px';
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const t0 = performance.now();
      const w = await documentPictureInPicture.requestWindow({ width: 300, height: 200 });
      __log.push('opened');
      w.addEventListener('pagehide', () => __log.push('closed after ' + Math.round(performance.now() - t0) + 'ms'));
    } catch (err) { __log.push('err ' + err); }
  });
  document.documentElement.appendChild(b);
});
await page.click('#qltProbe');
await new Promise((r) => setTimeout(r, 4000));
console.log(url, JSON.stringify(await page.evaluate(() => ({ log: __log, open: !!documentPictureInPicture.window, bridge: !!window.__qltPipBridge }))));
await browser.close();
