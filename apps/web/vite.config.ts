import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.PAPER_SERVER ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER, changeOrigin: false },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  worker: { format: 'es' },
});
