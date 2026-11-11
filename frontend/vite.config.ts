import { defineConfig } from 'vite';

// In development, run the backend (`npm run dev` in backend/, port 3000) and
// Vite proxies the API and WebSocket to it.
const backend = process.env['BACKEND_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  root: '.',
  server: {
    proxy: {
      '/api':    backend,
      '/health': backend,
      '/ws':     { target: backend, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      // Keep three.js in its own chunk — large but cacheable separately
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
