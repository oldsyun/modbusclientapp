import { defineConfig } from 'vite';

/**
 * 同一套源码出两种产物：
 *   · 桌面版：`npm run build`      → dist/      （Tauri 打包，kind=desktop）
 *   · 网页版：`npm run build:web`  → dist-web/  （纯静态，丢到任意静态服务器即可）
 *
 * 业务代码完全一致（MQTT over WebSocket 本来就在浏览器里跑），差别只有：
 *   1. web 用相对 base，能挂在任意子路径下；
 *   2. 注入编译期常量 __CLIENT_KIND__：现场端据此在准入弹窗 / 控制权选举里
 *      区分「桌面端(desktop) / 网页端(web) / 小程序(mini)」。
 */
export default defineConfig(({ mode }) => {
  const isWeb = mode === 'web';
  return {
    base: isWeb ? './' : '/',
    clearScreen: false,          // Tauri 前端固定端口（tauri.conf.json 的 devUrl 指向 5173）
    envPrefix: ['VITE_', 'TAURI_'],
    define: {
      __CLIENT_KIND__: JSON.stringify(isWeb ? 'web' : 'desktop')
    },
    server: {
      port: 5173,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] }
    },
    build: {
      target: 'chrome110',
      outDir: isWeb ? 'dist-web' : 'dist',
      emptyOutDir: true
      // 无框架无依赖，产物只有 index.html + 少量 js/css，体积天然最小
    }
  };
});
