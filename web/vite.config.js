import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// 关于面板要显示「构建那次的提交短号」（#63）。取不到（没装 git / 不在仓库里 /
// 命令失败）一律给空串，settings.js 的 readBuildCommit() 会只显示版本号——
// **绝不让构建因为拿不到提交号而失败**。
function buildCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (_) {
    return '';
  }
}

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(buildCommit()),
  },
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
