// desktop-client/eslint.config.mjs — 桌面端（ES 模块 / Vite / Tauri）ESLint 扁平配置
// 目标：极简规则，只拦真正的问题，不把现有代码判成一片红。
// 运行（需先 `npm i -D eslint`）：
//   cd desktop-client && npx eslint "src/**/*.js" "tests/**/*.mjs"
// 或使用已添加的脚本：npm run lint

export default [
  {
    files: ['src/**/*.js', 'vite.config.js', 'tests/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // 浏览器 / DOM 全局（src 运行在 WebView 里）
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        Uint8Array: 'readonly',
        ArrayBuffer: 'readonly',
        DataView: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        // 构建期注入（vite define）：desktop / web
        __CLIENT_KIND__: 'readonly',
        // Node 全局（tests / 构建脚本 / Tauri 侧）
        process: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      'no-undef': 'warn',
      'no-redeclare': 'warn',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'prefer-const': 'off'
    }
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'dist-web/**', 'src-tauri/target/**']
  }
];
