import path from 'path';
import { defineConfig } from 'vite';

/**
 * Builds the standalone TipTap editing canvas that the Flutter app hosts in a
 * WebView. Output is a self-contained set of static assets (no network, no
 * auth) shipped inside the APK at mobile/assets/editor/ and served locally via
 * InAppLocalhostServer.
 *
 * Run with: npm run build:editor
 */
export default defineConfig({
  root: path.resolve(__dirname, 'editor-host'),
  // Relative asset URLs so index.html works from a local file/localhost mount.
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'mobile/assets/editor'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: path.resolve(__dirname, 'editor-host/index.html'),
    },
  },
});
