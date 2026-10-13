/**
 * Page-world half of the "keep on top" window.
 *
 * Chrome's Document Picture-in-Picture API has to be called from the page's own
 * script world, not from an extension's isolated one, so the content script
 * can't open the floating window itself. It signals this tiny bridge instead:
 *
 *   content script                       bridge (this file, page world)
 *   ──────────────                       ─────────────────────────────
 *   event  qlt-pip-toggle        ───▶    open (or close) the window and move
 *                                        the card's host element into it
 *   event  qlt-pip-opened/closed ◀───
 *   event  qlt-pip-key           ◀───    space / arrows pressed in the window
 *   postMessage {qltFonts}       ───▶    font files, so the window can show them
 *
 * Events are dispatched synchronously, so the click that asked for the window
 * still counts as the user gesture Chrome requires.
 */
(() => {
  const HOST_ID = '__qlt_card_host__';
  if (window.__qltPipBridge) return;
  window.__qltPipBridge = true;

  let win = null;
  let fonts = []; // [name, ArrayBuffer, descriptors]

  const tell = (name) => document.dispatchEvent(new Event(name));

  window.addEventListener('message', (e) => {
    if (e.source === window && Array.isArray(e.data?.qltFonts)) fonts = e.data.qltFonts;
  });

  document.addEventListener('qlt-pip-toggle', async () => {
    if (win) {
      win.close();
      return;
    }
    const host = document.getElementById(HOST_ID);
    if (!host || !window.documentPictureInPicture) {
      tell('qlt-pip-error');
      return;
    }
    let w;
    try {
      w = await window.documentPictureInPicture.requestWindow({
        width: Number(host.dataset.pipW) || 380,
        height: Number(host.dataset.pipH) || 300,
      });
    } catch (err) {
      console.warn('[qlt] could not open the floating window', err);
      tell('qlt-pip-error');
      return;
    }
    win = w;
    w.document.body.style.cssText = 'margin:0;background:#1b1a17;';
    for (const name of ['--qlt-g1', '--qlt-g2']) {
      try {
        w.CSS.registerProperty({ name, syntax: '<color>', inherits: true, initialValue: '#1b1a17' });
      } catch {}
    }
    for (const [name, buf, desc] of fonts) {
      try {
        const face = new w.FontFace(name, buf.slice(0), desc || {});
        face.load().then((f) => w.document.fonts.add(f)).catch(() => {});
      } catch {}
    }
    w.document.body.append(host);
    w.document.addEventListener('keydown', (e) => {
      const key = { Space: 'space', ArrowLeft: 'prev', ArrowRight: 'next' }[e.code];
      if (!key) return;
      e.preventDefault();
      host.dataset.pipKey = key;
      tell('qlt-pip-key');
    });
    w.addEventListener('pagehide', () => {
      win = null;
      // The content script marks the host when the card itself is being closed.
      if (!host.dataset.pipGone) document.documentElement.appendChild(host);
      tell('qlt-pip-closed');
    });
    tell('qlt-pip-opened');
  });
})();
