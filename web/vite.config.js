import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787', // wrangler dev 默认端口
        changeOrigin: true,
      },
    },
  },
});
