import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发时把接口代理到后台 API，Cookie 同源
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
