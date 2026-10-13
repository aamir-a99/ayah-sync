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
  userDataDir: process.env.QLT_PROFILE || mkdtempSync(join(tmpdir(), 'qlt-probe-')),
  args: ['--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1200,800'],
  defaultViewport: null,
  ...(process.env.QLT_EXT ? { enableExtensions: process.env.QLT_EXT.split(';'), pipe: true } : {}),
});
if (process.env.QLT_SETTLE) await new Promise((r) => setTimeout(r, Number(process.env.QLT_SETTLE)));
// Optionally add a custom Adblock Plus filter first (QLT_ABP_FILTER), to test
// whether an exception rule keeps the window open.
if (process.env.QLT_ABP_FILTER) {
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://cfhdojbkjhnklbpkdaibdccddilifddb/options.html', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 3000));
  console.log('filter add:', JSON.stringify(await opt.evaluate((text) => chrome.runtime.sendMessage(text.startsWith('{') ? JSON.parse(text) : { type: 'filters.add', text }), process.env.QLT_ABP_FILTER)));
  await new Promise((r) => setTimeout(r, 2000));
}
let sw = null;
if (process.env.QLT_SW_HOOK) {
  // Record every tab an extension closes, and why (stack), from inside its worker.
  const t = browser.targets().find((x) => x.type() === 'service_worker' && x.url().includes(process.env.QLT_SW_HOOK));
  sw = await t.worker();
  await sw.evaluate(() => {
    globalThis.__rm = [];
    for (const ns of ['tabs', 'windows', 'scripting']) {
      for (const k of Object.keys(chrome[ns])) {
        const o = chrome[ns][k];
        if (typeof o !== 'function' || /^(get|query)/.test(k)) continue;
        try {
          chrome[ns][k] = function (...a) {
            globalThis.__rm.push(ns + '.' + k + ' ' + JSON.stringify(a).slice(0, 300) + ' @ ' + new Error().stack.split(String.fromCharCode(10)).slice(2, 6).join(' | '));
            return o.apply(chrome[ns], a);
          };
        } catch {}
      }
    }
    chrome.runtime.onMessage.addListener((m, sender) => { globalThis.__rm.push('msg tab=' + sender.tab?.id + ' url=' + sender.url + ' ' + JSON.stringify(m).slice(0, 200)); });
    chrome.tabs.onCreated.addListener((t) => globalThis.__rm.push('created ' + t.id + ' ' + (t.pendingUrl || t.url)));
    chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => globalThis.__rm.push('navTarget ' + JSON.stringify(d)));
    chrome.tabs.onRemoved.addListener((id) => globalThis.__rm.push('removed ' + id));
  });
}
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, Number(process.env.QLT_WAIT || 6000)));
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
console.log('extension workers:', browser.targets().filter((t) => t.type() === 'service_worker' || t.type() === 'background_page').map((t) => t.url().slice(19, 51)).join(' '));
console.log(url, JSON.stringify(await page.evaluate(() => ({ log: __log, open: !!documentPictureInPicture.window, bridge: !!window.__qltPipBridge }))));
if (sw) console.log((await sw.evaluate(() => globalThis.__rm)).join('\n'));
await browser.close();
