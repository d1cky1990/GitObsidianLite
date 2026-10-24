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
  legacyKeyReport,
  providerProblem,
  isNameTaken,
  PROVIDERS,
  pushPlan,
  dropPlaceholderPassword,
  deployVarArgs,
  parseWorkersUrl,
  providerFailureMessage,
  classifyRuntime,
  wranglerFailureStop,
  parseArgs,
  CONFIG_REL,
  SAMPLE_NOTE,
  SAMPLE_NOTE_PATH,
} from './deploy.mjs';

/* ---------------- 读配置 ---------------- */

test('parseDevVars：等号两边有没有空格都认', () => {
  const parsed = parseDevVars(['REPO_OWNER=d1cky1990', 'REPO_REPO = note1'].join('\n'));
  assert.deepEqual(parsed, { REPO_OWNER: 'd1cky1990', REPO_REPO: 'note1' });
});

test('parseDevVars：注释行与空行跳过，行尾注释不算值', () => {
  const parsed = parseDevVars(['# 这一行是注释', '', 'REPO_REPO = note1   # 我的笔记库'].join('\n'));
  assert.deepEqual(parsed, { REPO_REPO: 'note1' });
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
  const full = { REPO_PROVIDER: 'gitee', REPO_TOKEN: 'tok1', REPO_OWNER: 'd1cky1990', REPO_REPO: 'note1' };
  assert.deepEqual(missingConfigKeys(full), []);

  assert.deepEqual(
    missingConfigKeys({ REPO_PROVIDER: 'gitee', REPO_TOKEN: 'tok1', REPO_REPO: 'note1' }),
    ['REPO_OWNER']
  );
  assert.deepEqual(
    missingConfigKeys({ REPO_PROVIDER: 'gitee', REPO_TOKEN: '你的私人令牌', REPO_OWNER: 'd1cky1990', REPO_REPO: 'note1' }),
    ['REPO_TOKEN'],
    '还是模板里的占位值，等于没填'
  );
  assert.deepEqual(
    missingConfigKeys({ REPO_TOKEN: 'tok1', REPO_OWNER: 'o', REPO_REPO: 'r' }),
    ['REPO_PROVIDER'],
    '供应商没有默认值——缺了就是缺了'
  );
});

/* ---------------- 旧名字与供应商取值 ---------------- */

test('旧名字还在用：逐条给出「旧名 → 新名」', () => {
  const report = legacyKeyReport({ GITEE_TOKEN: 'tok1', GITEE_OWNER: 'o', GITEE_REPO: 'r' });
  assert.deepEqual(report, ['GITEE_TOKEN → REPO_TOKEN', 'GITEE_OWNER → REPO_OWNER', 'GITEE_REPO → REPO_REPO']);
});

test('新旧名字都配了：不拿旧名字拦人', () => {
  // 旧行没删只是懒，不是错——按新名字跑就行
  assert.deepEqual(
    legacyKeyReport({ GITEE_OWNER: 'stale', REPO_PROVIDER: 'gitee', REPO_TOKEN: 'tok1', REPO_OWNER: 'o', REPO_REPO: 'r' }),
    []
  );
});

test('REPO_PROVIDER：缺了、或写了别家，都说清可选值', () => {
  assert.match(providerProblem({}), /没有默认值/);
  const bad = providerProblem({ REPO_PROVIDER: 'gitlab' });
  assert.match(bad, /gitee 或 github/);
  assert.match(bad, /gitlab/);
  assert.equal(providerProblem({ REPO_PROVIDER: 'github' }), null);
});

test('可取值名单与后端适配层是同一份（别各写各的）', async () => {
  const { PROVIDER_NAMES } = await import('../server/src/providers/index.js');
  assert.deepEqual(PROVIDERS, PROVIDER_NAMES);
});

/* ---------------- 只推该推的那几项 ---------------- */

test('pushPlan：机密走 secret，其余走 var；访问密码只在设了的时候推', () => {
  const base = { REPO_PROVIDER: 'gitee', REPO_TOKEN: 'tok1', REPO_OWNER: 'o', REPO_REPO: 'r' };
  assert.deepEqual(pushPlan(base), {
    secrets: ['REPO_TOKEN'],
    vars: ['REPO_PROVIDER', 'REPO_OWNER', 'REPO_REPO'],
  });
  assert.deepEqual(pushPlan({ ...base, APP_PASSWORD: 'pw1' }), {
    secrets: ['REPO_TOKEN', 'APP_PASSWORD'],
    vars: ['REPO_PROVIDER', 'REPO_OWNER', 'REPO_REPO'],
  });
});

test('配置文件里多出来的键不会被推上去', () => {
  // 这条是票面点名的那条：环境变量只能挑着推，绝不整份倒。
  // 那份文件会被整份读进应用进程，误放的部署令牌如果被一起推上去，
  // 就等于把它交给了另一个平台。
  const parsed = {
    REPO_PROVIDER: 'gitee',
    REPO_TOKEN: 'tok1',
    REPO_OWNER: 'o',
    REPO_REPO: 'r',
    DEPLOY_TOKEN: 'fake-value',
  };
  const plan = pushPlan(parsed);
  assert.deepEqual([...plan.secrets, ...plan.vars], ['REPO_TOKEN', 'REPO_PROVIDER', 'REPO_OWNER', 'REPO_REPO']);
  assert.deepEqual(unknownConfigKeys(parsed), ['DEPLOY_TOKEN']);
});

test('访问密码还是占位话时按「没设」处理', () => {
  // 不处理的话，它会作为一个真的密码推上去，而末尾确认拿同一个字符串比对也过得去——
  // 「密码没填」这件事从头到尾不会露头
  const kept = dropPlaceholderPassword({ REPO_TOKEN: 'tok1', REPO_OWNER: 'o', REPO_REPO: 'r' });
  assert.equal('APP_PASSWORD' in kept, false);

  const dropped = dropPlaceholderPassword({ REPO_OWNER: 'o', APP_PASSWORD: '你的访问密码' });
  assert.equal('APP_PASSWORD' in dropped, false);
  assert.deepEqual(pushPlan(dropped).secrets, ['REPO_TOKEN']);

  const real = dropPlaceholderPassword({ REPO_OWNER: 'o', APP_PASSWORD: 'pw1' });
  assert.equal(real.APP_PASSWORD, 'pw1');
});

test('deployVarArgs：三个 --var，且命令行里不出现令牌', () => {
  const args = deployVarArgs({ REPO_PROVIDER: 'gitee', REPO_TOKEN: 'tok1', REPO_OWNER: 'd1cky1990', REPO_REPO: 'note1' });
  assert.deepEqual(args, [
    '--var', 'REPO_PROVIDER:gitee',
    '--var', 'REPO_OWNER:d1cky1990',
    '--var', 'REPO_REPO:note1',
  ]);
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
  const m = providerFailureMessage({ what: 'token', status: 401, body: { message: '401 Unauthorized' } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /令牌/);
  assert.match(m.hint.join(' '), /私人令牌/);
  assert.match(m.hint.join(' '), new RegExp(CONFIG_REL.replace(/[.]/g, '\\.')), '要说去哪改');
});

test('自检：仓库 404 → 配置类，提醒名字大小写与建仓选项', () => {
  const m = providerFailureMessage({ what: 'repo', status: 404, body: { message: 'Not Found' } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /仓库不存在/);
  assert.match(m.hint.join(' '), /大小写/);
  assert.match(m.hint.join(' '), /--create-repo/);
});

test('自检：默认分支 404 → 说的是「空仓库」，不是「仓库不存在」', () => {
  // 同一个 404 在两处意思不同，混着说会把人指到错的地方
  const m = providerFailureMessage({ what: 'branch', status: 404, body: null });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /空仓库/);
});

test('自检：没有写权限 → 配置类', () => {
  const m = providerFailureMessage({ what: 'write', status: 200, body: { permission: { push: false } } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /没有写权限/);
});

test('自检：网络类失败说「重跑一次」，不说去改配置', () => {
  const m = providerFailureMessage({ what: 'token', network: '等了 15 秒没有回应' });
  assert.equal(m.kind, 'network');
  assert.match(m.message, /连不上 gitee\.com/);
  assert.match(m.hint.join(' '), /重跑一次/);
  assert.equal(/配置/.test(m.hint.join(' ')), false, '网络问题别让人去改配置');
});

test('自检：Gitee 自己 502 时不冒充「令牌不对」', () => {
  const m = providerFailureMessage({ what: 'token', status: 502, body: '<html>bad gateway</html>' });
  assert.equal(m.kind, 'network');
  assert.match(m.message, /502/);
});

test('自检：GitHub 侧的话跟着换——令牌被拒指向细粒度令牌，不是 Gitee 那套', () => {
  const m = providerFailureMessage({ provider: 'github', what: 'token', status: 401, body: { message: 'Bad credentials' } });
  assert.equal(m.kind, 'config');
  assert.match(m.message, /GitHub/);
  assert.match(m.hint.join(' '), /Fine-grained|细粒度/);
  assert.match(m.hint.join(' '), /Contents/);
  assert.equal(/projects 权限/.test(m.hint.join(' ')), false, '别把 Gitee 的权限说明搬到 GitHub 上');
});

test('自检：GitHub 网络失败说的是它自己的域名', () => {
  const m = providerFailureMessage({ provider: 'github', what: 'token', network: 'fetch failed' });
  assert.equal(m.kind, 'network');
  assert.match(m.message, /连不上 api\.github\.com/);
});

test('建仓撞名：两家各自的号码都认得出，别的 422 不认', () => {
  assert.equal(isNameTaken('gitee', { status: 400, body: { message: '文件名已存在' } }), true);
  assert.equal(isNameTaken('github', { status: 422, body: { message: 'Repository creation failed.', errors: [{ code: 'already_exists' }] } }), true);
  assert.equal(isNameTaken('github', { status: 422, body: { message: 'Invalid request.', errors: [{ code: 'invalid' }] } }), false);
  assert.equal(isNameTaken('github', { status: 404, body: { message: 'Not Found' } }), false);
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
  const body = { error: '未配置 REPO_PROVIDER / REPO_TOKEN / REPO_OWNER / REPO_REPO（本地放 .dev.vars，线上配环境变量）' };
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

/* ---------------- 命令行参数 ---------------- */

test('parseArgs：`--subdomain 名字` 与 `--subdomain=名字` 都认', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--subdomain', 'd1cky']), {
    flags: new Set(['--dry-run']),
    values: { subdomain: 'd1cky' },
  });
  assert.deepEqual(parseArgs(['--subdomain=note1']).values, { subdomain: 'note1' });
  assert.deepEqual(parseArgs([]).values, {});
});

/* ---------------- 部署侧失败（wrangler 自己报的） ---------------- */

/** 真实输出，2026-10-18 用户第二次部署时原样撞出来的 */
const SUBDOMAIN_PROMPT = {
  code: 1,
  out: [
    'Total Upload: 12.85 KiB / gzip: 4.12 KiB',
    'Uploaded obsidian-sync-server (11.30 sec)',
    '? Would you like to register a workers.dev subdomain now?',
    '🤖 Using fallback value in non-interactive context: no',
  ].join('\n'),
  err: '',
};

test('没注册 workers.dev 子域：说的是「代码传上去了，缺个地址」，不是「部署失败」', () => {
  const stop = wranglerFailureStop(SUBDOMAIN_PROMPT, '部署没成');
  assert.match(stop.info.headline, /workers\.dev 子域/);
  assert.match(stop.info.detail.join(' '), /代码已经传上去了/);
  const hints = stop.info.hint.join(' ');
  assert.match(hints, /--subdomain/, '要给出脚本自己的那条路');
  assert.match(hints, /wrangler subdomain|Your subdomain/, '也要给手动那条');
});


/** 真实输出，2026-10-18 用户首次部署时原样撞出来的 */
const MEMBERSHIPS_FAILURE = {
  code: 1,
  out: '',
  err: [
    '✘ [ERROR] A request to the Cloudflare API (/memberships) failed.',
    'Authentication failed (status: 400) [code: 9106]',
    '⛅️ wrangler 3.114.17 (update available 4.151.1)',
  ].join('\n'),
};

test('「账号级令牌」那句话必须是它自己的一句，不能混成「令牌不对」', () => {
  // 这条是被真跑纠正过的：同一个 400，说成「令牌是假的」会让人不停重建令牌，
  // 而真正缺的是「告诉 wrangler 用哪个账号」
  const stop = wranglerFailureStop(MEMBERSHIPS_FAILURE, '推 REPO_TOKEN 没成');
  assert.match(stop.info.headline, /账号级/);
  const hints = stop.info.hint.join(' ');
  assert.match(hints, /CLOUDFLARE_ACCOUNT_ID/, '要给出最快的那条解法');
  assert.match(hints, /My Profile/, '另一条路是换成用户级令牌');
});

test('令牌被拒：点名权限里要有 Workers Scripts : Edit', () => {
  const stop = wranglerFailureStop(
    { code: 1, out: '', err: 'Authentication error [code: 10000] Please ensure it has the correct permissions' },
    '部署没成'
  );
  assert.match(stop.info.headline, /不认这个令牌/);
  assert.match(stop.info.hint.join(' '), /Workers Scripts/);
});

test('多个账号：让它把账号 ID 设上', () => {
  const stop = wranglerFailureStop({ code: 1, out: '', err: 'More than one account available' }, '部署没成');
  assert.match(stop.info.headline, /多个账号/);
  assert.match(stop.info.hint.join(' '), /CLOUDFLARE_ACCOUNT_ID/);
});

test('连不上：说重跑一次，不让人去改权限', () => {
  const stop = wranglerFailureStop({ code: 1, out: '', err: 'fetch failed\nECONNREFUSED 104.16.0.1:443' }, '部署没成');
  assert.match(stop.info.headline, /没连上 Cloudflare/);
  assert.match(stop.info.hint.join(' '), /重跑一次/);
});

test('认不出的报错：原样留下最后几行，别自己编原因', () => {
  const stop = wranglerFailureStop(
    { code: 1, out: '', err: 'line1\nline2\nsomething odd happened' },
    '部署没成'
  );
  assert.equal(stop.info.headline, '部署没成');
  assert.ok(stop.info.detail.join(' ').includes('something odd happened'));
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
