import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.PAPER_SERVER ?? 'http://127.0.0.1:4317';
/** Monorepo root: workspace packages (packages/*) and the demo fixture (fixtures/canto-demo, `?mock=1`). */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../fixtures/canto-demo', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [REPO_ROOT, FIXTURE] },
    proxy: {
      '/api': { target: SERVER, changeOrigin: false },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  worker: { format: 'es' },
});
