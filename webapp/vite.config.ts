// webapp/vite.config.ts (WP8) — `npm run build:webapp` → dist/webapp, served by Hono at /app/* (01 §12 "Hosting").
// No inline scripts end up in index.html (the CSP is script-src 'self' https://telegram.org); assets are hashed and
// served immutable. In development, `vite --config webapp/vite.config.ts` proxies /api to the local server.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../dist/webapp',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
    // Everything in files: an inlined data: script would be blocked by the CSP.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { '/api': `http://127.0.0.1:${process.env['PORT'] ?? '8080'}` },
  },
});
