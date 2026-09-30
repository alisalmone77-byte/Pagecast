import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Talk to the API in dev without CORS or a second origin.
    proxy: {
      '/api': {
        target: process.env.PAGECAST_API ?? 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
