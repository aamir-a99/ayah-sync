import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Ayah Sync',
  version: pkg.version,
  description:
    'Follows Quran recitation videos with translations using browser CPU recognition or the local GPU helper.',
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Ayah Sync',
  },
  background: {
    service_worker: 'src/background/service-worker.js',
    type: 'module',
  },
  permissions: ['tabCapture', 'activeTab', 'offscreen', 'storage', 'scripting'],
  host_permissions: ['http://127.0.0.1:8790/*'],
  // Shared-memory WASM threads require both policies. Capture tokens must be
  // issued by the popup (not the service worker); see CAPTURE_TOKEN routing.
  cross_origin_opener_policy: { value: 'same-origin' },
  cross_origin_embedder_policy: { value: 'require-corp' },
  // Browser recognition is bundled; downloads use the loopback Python helper.
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'; connect-src 'self' http://127.0.0.1:8790 ws://127.0.0.1:8790 ws://localhost:8790",
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content.js'],
      run_at: 'document_idle',
    },
    {
      // Opens the "keep on top" window; that API only exists in the page's world.
      matches: ['<all_urls>'],
      js: ['src/content/pip-bridge.js'],
      run_at: 'document_idle',
      world: 'MAIN',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['assets/*', 'worklet/*', 'fonts/*'],
      matches: ['<all_urls>'],
    },
  ],
});
