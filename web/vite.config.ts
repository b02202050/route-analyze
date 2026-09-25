import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 專案放在 WSL 的 /mnt/c（Windows 磁碟，例如 OneDrive）時收不到檔案變更事件，改用輪詢
const usePolling = process.cwd().startsWith('/mnt/') || process.env.VITE_POLLING === '1';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      '/api': process.env.API_URL ?? 'http://localhost:8787',
    },
  },
});
