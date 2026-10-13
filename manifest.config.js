import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Ayah Sync',
  version: pkg.version,
  description:
    'Follows Quran recitation videos word by word and shows the translation. Needs the Ayah Sync helper running on your computer.',
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
  // The offscreen document streams captured audio to the local recognition
  // server over a WebSocket; allow only that connection.
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:8790 ws://localhost:8790",
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
