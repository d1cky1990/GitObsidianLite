// deploy.mjs 的测试。
//
// 这里钉的不是「脚本能不能部署」——那件事只有真跑一次才知道——而是**说话的方式**：
// 哪一步停下、停的时候点名的是不是那一项、网络类与配置类是不是两句话。
// 票面上的三条验收判据（失败停在开头并点得准 / 网络类与配置类说不同的话 /
// 幂等）里，前两条全靠这些纯函数撑住；第三条靠流程本身没有「上次跑过就失败」的分支。
//
// 夹具纪律：假值一律短、假、中性命（`tok1` 这种），别写成一串像令牌的东西——
// 本仓库的提交前检查会扫这些文件，而它认的是形状，不是善意。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDevVars,
  isPlaceholder,
  missingConfigKeys,
  unknownConfigKeys,
  pushPlan,
  dropPlaceholderPassword,
  deployVarArgs,
  parseWorkersUrl,
  giteeFailureMessage,
  classifyRuntime,
  CONFIG_REL,
  SAMPLE_NOTE,
  SAMPLE_NOTE_PATH,
} from './deploy.mjs';

/* ---------------- 读配置 ---------------- */

test('parseDevVars：等号两边有没有空格都认', () => {
  const parsed = parseDevVars(['GITEE_OWNER=d1cky1990', 'GITEE_REPO = note1'].join('\n'));
  assert.deepEqual(parsed, { GITEE_OWNER: 'd1cky1990', GITEE_REPO: 'note1' });
});

test('parseDevVars：注释行与空行跳过，行尾注释不算值', () => {
  const parsed = parseDevVars(['# 这一行是注释', '', 'GITEE_REPO = note1   # 我的笔记库'].join('\n'));
  assert.deepEqual(parsed, { GITEE_REPO: 'note1' });
});

test('parseDevVars：引号里的 # 是值的一部分，不能被当注释切掉', () => {
  // 密码里带 # 很常见；按「见到 # 就切」会把密码悄悄截短，
  // 而症状是「部署成功、输密码一直不对」——最难查的那种
  const parsed = parseDevVars('APP_PASSWORD = "a#b#c"');
  assert.equal(parsed.APP_PASSWORD, 'a#b#c');
});

test('isPlaceholder：模板里的占位值等于没填', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder('你的私人令牌'), true);
  assert.equal(isPlaceholder('<token>'), true);
  assert.equal(isPlaceholder('d1cky1990'), false);
});

test('missingConfigKeys：缺哪项点哪项，占位值也算缺', () => {
  const full = { GITEE_TOKEN: 'tok1', GITEE_OWNER: 'd1cky1990', GITEE_REPO: 'note1' };
  assert.deepEqual(missingConfigKeys(full), []);

  assert.deepEqual(missingConfigKeys({ GITEE_TOKEN: 'tok1', GITEE_REPO: 'note1' }), ['GITEE_OWNER']);
  assert.deepEqual(
    missingConfigKeys({ GITEE_TOKEN: '你的私人令牌', GITEE_OWNER: 'd1cky1990', GITEE_REPO: 'note1' }),
    ['GITEE_TOKEN'],
    '还是模板里的占位值，等于没填'
  );
});

/* ---------------- 只推该推的那几项 ---------------- */

test('pushPlan：机密走 secret，其余走 var；访问密码只在设了的时候推', () => {
  assert.deepEqual(pushPlan({ GITEE_TOKEN: 'tok1', GITEE_OWNER: 'o', GITEE_REPO: 'r' }), {
    secrets: ['GITEE_TOKEN'],
    vars: ['GITEE_OWNER', 'GITEE_REPO'],
  });
  assert.deepEqual(pushPlan({ GITEE_TOKEN: 'tok1', GITEE_OWNER: 'o', GITEE_REPO: 'r', APP_PASSWORD: 'pw1' }), {
    secrets: ['GITEE_TOKEN', 'APP_PASSWORD'],
    vars: ['GITEE_OWNER', 'GITEE_REPO'],
  });
});

test('配置文件里多出来的键不会被推上去', () => {
  // 这条是票面点名的那条：环境变量只能挑着推，绝不整份倒。
  // 那份文件会被整份读进应用进程，误放的部署令牌如果被一起推上去，
  // 就等于把它交给了另一个平台。
  const parsed = {
    GITEE_TOKEN: 'tok1',
    GITEE_OWNER: 'o',
    GITEE_REPO: 'r',
    DEPLOY_TOKEN: 'fake-value',
  };
  const plan = pushPlan(parsed);
  assert.deepEqual([...plan.secrets, ...plan.vars], ['GITEE_TOKEN', 'GITEE_OWNER', 'GITEE_REPO']);
  assert.deepEqual(unknownConfigKeys(parsed), ['DEPLOY_TOKEN']);
});

test('访问密码还是占位话时按「没设」处理', () => {
  // 不处理的话，它会作为一个真的密码推上去，而末尾确认拿同一个字符串比对也过得去——
  // 「密码没填」这件事从头到尾不会露头
  const kept = dropPlaceholderPassword({ GITEE_TOKEN: 'tok1', GITEE_OWNER: 'o', GITEE_REPO: 'r' });
  assert.equal('APP_PASSWORD' in kept, false);

  const dropped = dropPlaceholderPassword({ GITEE_OWNER: 'o', APP_PASSWORD: '你的访问密码' });
  assert.equal('APP_PASSWORD' in dropped, false);
  assert.deepEqual(pushPlan(dropped).secrets, ['GITEE_TOKEN']);

  const real = dropPlaceholderPassword({ GITEE_OWNER: 'o', APP_PASSWORD: 'pw1' });
  assert.equal(real.APP_PASSWORD, 'pw1');
});

test('deployVarArgs：两个 --var，且命令行里不出现令牌', () => {
  const args = deployVarArgs({ GITEE_TOKEN: 'tok1', GITEE_OWNER: 'd1cky1990', GITEE_REPO: 'note1' });
  assert.deepEqual(args, ['--var', 'GITEE_OWNER:d1cky1990', '--var', 'GITEE_REPO:note1']);
  assert.equal(args.join(' ').includes('tok1'), false, '机密不走命令行——那会进进程列表和 shell 历史');
});

/* ---------------- 认地址 ---------------- */

test('parseWorkersUrl：从 wrangler 的输出里认出线上地址', () => {
  const out = [
    'Total Upload: 128.44 KiB / gzip: 42.10 KiB',
    'Uploaded obsidian-sync-server (2.51 sec)',
    'Deployed obsidian-sync-server triggers (0.42 sec)',
    '  https://obsidian-sync-server.d1cky.workers.dev',
    'Current Deployment ID: 8f3c1a2b',
  ].join('\n');
  assert.equal(parseWorkersUrl(out), 'https://obsidian-sync-server.d1cky.workers.dev');
});

test('parseWorkersUrl：认不出来就交白卷，不猜', () => {
  assert.equal(parseWorkersUrl('Uploaded something'), null);
  // 别把控制台里别的链接当成应用地址
  assert.equal(parseWorkersUrl('https://dash.cloudflare.com/abc'), null);
});

/* ---------------- 失败怎么说 ---------------- */

test('自检：令牌被拒 → 配置类，点名去 Gitee 重新生成', () => {
  const m = giteeFailureMessage({ what: 'token', status: 401, body: { message: '401 Unauthorized' } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /令牌/);
  assert.match(m.hint.join(' '), /私人令牌/);
  assert.match(m.hint.join(' '), new RegExp(CONFIG_REL.replace(/[.]/g, '\\.')), '要说去哪改');
});

test('自检：仓库 404 → 配置类，提醒名字大小写与建仓选项', () => {
  const m = giteeFailureMessage({ what: 'repo', status: 404, body: { message: 'Not Found' } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /仓库不存在/);
  assert.match(m.hint.join(' '), /大小写/);
  assert.match(m.hint.join(' '), /--create-repo/);
});

test('自检：默认分支 404 → 说的是「空仓库」，不是「仓库不存在」', () => {
  // 同一个 404 在两处意思不同，混着说会把人指到错的地方
  const m = giteeFailureMessage({ what: 'branch', status: 404, body: null });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /空仓库/);
});

test('自检：没有写权限 → 配置类', () => {
  const m = giteeFailureMessage({ what: 'write', status: 200, body: { permission: { push: false } } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /没有写权限/);
});

test('自检：网络类失败说「重跑一次」，不说去改配置', () => {
  const m = giteeFailureMessage({ what: 'token', network: '等了 15 秒没有回应' });
  assert.equal(m.kind, 'network');
  assert.match(m.message, /连不上 gitee\.com/);
  assert.match(m.hint.join(' '), /重跑一次/);
  assert.equal(/配置/.test(m.hint.join(' ')), false, '网络问题别让人去改配置');
});

test('自检：Gitee 自己 502 时不冒充「令牌不对」', () => {
  const m = giteeFailureMessage({ what: 'token', status: 502, body: '<html>bad gateway</html>' });
  assert.equal(m.kind, 'network');
  assert.match(m.message, /502/);
});

/* ---------------- 末尾那次确认 ---------------- */

test('确认：线上读到 sha 才算通', () => {
  const r = classifyRuntime({ status: 200, body: { branch: 'master', sha: 'abc1234def' } });
  assert.equal(r.ok, true);
  assert.equal(r.sha, 'abc1234def');
  assert.match(r.message, /最新版本/);
});

test('确认：地址打不开 ≠ 部署失败，也不等于应用连不上仓库', () => {
  const r = classifyRuntime({ network: 'fetch failed：ENOTFOUND' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unreachable');
});

test('确认：变量没到位（应用自己说未配置）', () => {
  const body = { error: '未配置 GITEE_TOKEN / GITEE_OWNER / GITEE_REPO（本地放 .dev.vars，线上配环境变量）' };
  const r = classifyRuntime({ status: 500, body });
  assert.equal(r.kind, 'missing-vars');
  assert.match(r.message, /变量没配齐/);
});

test('确认：变量在、但应用连不上仓库 → 上游类', () => {
  const r = classifyRuntime({ status: 502, body: { error: '上游回了 502，且不是接口的错误体（整页 HTML）' } });
  assert.equal(r.kind, 'upstream');
  assert.match(r.message, /连不上仓库/);
});

test('确认：访问密码对不上是单独一类', () => {
  const r = classifyRuntime({ status: 401, body: { error: '访问密码错误', auth: true } });
  assert.equal(r.kind, 'auth');
});

test('确认：404 说明这个地址上不是应用本身，而不是「应用连不上仓库」', () => {
  const r = classifyRuntime({ status: 404, body: 'Not Found' });
  assert.equal(r.kind, 'unreachable');
});

/* ---------------- 示例笔记 ---------------- */

test('示例笔记：放仓库根，把四个记号都演示一遍', () => {
  assert.equal(SAMPLE_NOTE_PATH.includes('/'), false, '要放仓库根，别埋进目录');
  assert.match(SAMPLE_NOTE_PATH, /\.md$/);
  assert.match(SAMPLE_NOTE, /^# /m, '标题');
  assert.match(SAMPLE_NOTE, /^- \[\s?x?\] /m, '勾选框');
  assert.match(SAMPLE_NOTE, /\[\[.+\]\]/, '双链');
  assert.match(SAMPLE_NOTE, /#示例/, '标签');
  assert.match(SAMPLE_NOTE, /^\|.*\|$/m, '表格');
});
