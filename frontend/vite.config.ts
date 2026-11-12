import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the NestJS API runs on :4400; Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://127.0.0.1:4400' },
  },
});
