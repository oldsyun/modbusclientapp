import { defineConfig } from 'vite';

// Tauri 前端构建配置：固定端口（tauri.conf.json 的 devUrl 指向 5173）
export default defineConfig({
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    target: 'chrome110',
    outDir: 'dist',
    emptyOutDir: true
    // 无框架无依赖，产物只有 index.html + 少量 js/css，体积天然最小
  }
});
