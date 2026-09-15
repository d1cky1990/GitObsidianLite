// 启用仓库自带的 git hooks。
//
// 为什么需要这一步：`core.hooksPath` 是**本地**配置，存在 .git/config 里，
// 不进版本库。所以 hook 文件可以跟进仓库，但「指向它」这个动作必须每人各做一次。
// 这是 git 的机制，不是本项目的取舍——但它决定了这层防护只能靠文档传达，
// 装没装得自己确认（跑 `node scripts/check-secrets.mjs --status` 即可）。
//
// 用法：node scripts/install-hooks.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WANT = '.githooks';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

export function status(root) {
  const current = (() => {
    try { return git(['config', '--get', 'core.hooksPath'], { cwd: root }); } catch { return ''; }
  })();
  const installed = current === WANT || path.resolve(root, current || '.') === path.join(root, WANT);
  return { installed, current };
}

function main() {
  const root = git(['rev-parse', '--show-toplevel']);
  const dir = path.join(root, WANT);
  if (!fs.existsSync(path.join(dir, 'pre-commit'))) {
    console.error(`找不到 ${WANT}/pre-commit——请在仓库根运行。`);
    return 1;
  }

  const before = status(root);
  if (before.current && !before.installed) {
    // 覆盖别人的设置前先说一声：这可能是对方刻意配的（husky、pre-commit 框架等）。
    console.error(`注意：core.hooksPath 原本指向 ${before.current}，将被改为 ${WANT}。`);
    console.error('如果那是别的工具（husky 等）装的，改完要把它那套 hook 挪进 .githooks/。');
  }

  git(['config', 'core.hooksPath', WANT], { cwd: root });

  // Windows 上 git 不看文件的执行位，但 *nix 上要看。设置它没有代价。
  try { fs.chmodSync(path.join(dir, 'pre-commit'), 0o755); } catch { /* 平台不支持则忽略 */ }

  if (before.installed) console.log(`✓ 已启用（core.hooksPath 本来就指向 ${WANT}）`);
  else console.log(`✓ 已启用：core.hooksPath = ${WANT}`);

  console.log('\n现在 git commit 会先跑 scripts/check-secrets.mjs。自检一次：');
  console.log('  node scripts/check-secrets.mjs --all');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
