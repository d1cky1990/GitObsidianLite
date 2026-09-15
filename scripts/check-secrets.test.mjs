// check-secrets 的测试。
//
// 两侧都要钉住，而且**误报侧更要紧**：这层防护的失效方式不是漏报，是被人
// `--no-verify` 掉——误报多一次，绕过的动机就强一分。所以下面「不该拦」的用例
// 全部取自真实语料：本仓库的文档、lock 文件、以及当初撞出来的三种形态误报。
//
// 一条纪律：假凭据写成**中性命名的常量**，测试里用插值引用，不直接写
// `GITEE_TOKEN=「一串像真值的东西」`。理由见最后一个用例——扫描器不认自己的语料，
// 靠的是形状，不是善意。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  scanContent,
  checkPath,
  isPlaceholderValue,
  isSecretKeyName,
  isLiteralValue,
  entropy,
} from './check-secrets.mjs';

/* ---------------- 假凭据 ----------------
 * 两条约束，都是踩过的：
 *
 * 1. 常量名刻意中性、测试里用插值引用（下面所有用例都这么做）。文件里不存在一行
 *    「秘密词 = 像真值的字面量」，否则扫描器会把测试语料本身当成泄漏。
 * 2. **不碰平台认得的前缀**（`ghp_` / `AKIA…` / 私钥头字面量）。规则本身不需要
 *    这些前缀就能被测到——形态层看的是「敏感名 + 像真值的字面量」，熵层看的是
 *    「敏感词紧邻的高熵串」。而带上前缀会让 GitHub 的 push protection 在 push
 *    时把测试夹具当成真泄漏拦下：本仓库是公开的，那等于用一次推送故障换一句
 *    「夹具更逼真」。私钥头没有可替换的形状，所以拼出来——这也是那两条用例要
 *    行内标记的原因。
 */
const HEX32 = '4f3a8b2c9d1e5f6a7b8c9d0e1f2a3b4c';
const HEX32B = '9e1d7c5b3a2f8e6d4c0b9a7f5e3d1c2b';
const MIXED = 'K7mQ2pR9tV4wY8zA3bC5dE6fG0hJ1kL2';
const BLOB = 'q7Zm2Xp9Rt4Wv8Yz1Ac3Be5Df6Gh0Jk2Lm4Np6Qr8St0Uv2Wx4Yz6A';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmMiLCJpYXQiOjE3MDAwMDAwMDB9.5mQ3xR8pV2tY7wZ1bC4dF6gH9jK0nM2Pq4Rs6Tu8';
const PWD = 'Tr0ub4dor&3-Horse';
const PK_HEAD = ['-----BEGIN ', 'OPENSSH PRIVATE KEY', '-----'].join('');
const PK_HEAD_RSA = ['-----BEGIN ', 'RSA PRIVATE KEY', '-----'].join('');

/** 一行内容是否被拦下 */
const flags = (text, opts) => scanContent('x', text, opts).length > 0;
/** 拦下它的规则名 */
const rules = (text, opts) => scanContent('x', text, opts).map((h) => h.rule);

/* ---------------- 该拦的 ---------------- */

test('指纹层：出现本机凭据文件里的真值', () => {
  const fingerprints = [{ source: 'server/.dev.vars', key: 'GITEE_TOKEN', value: HEX32 }];
  // 32 位 hex，无固定前缀——形态与熵两层对它都是瞎的，只有指纹认得
  assert.equal(flags(`token: ${HEX32}`, { fingerprints }), true);
  assert.deepEqual(rules(`token: ${HEX32}`, { fingerprints }), ['指纹'],
    '同一个值被多层命中时只报一次，且报最精确的那层');
  // 同一个值出现在毫不相干的位置也认得出
  assert.equal(flags(`x = "${HEX32}"`, { fingerprints }), true);
});

test('指纹层：报出的证据是脱敏的，不回显真值', () => {
  const [hit] = scanContent('x', `token: ${HEX32}`, {
    fingerprints: [{ source: 'server/.dev.vars', key: 'GITEE_TOKEN', value: HEX32 }],
  });
  assert.ok(!hit.excerpt.includes(HEX32), '证据里不得出现完整真值');
  assert.ok(hit.excerpt.includes('已脱敏'));
});

test('形态层：本项目环境变量被赋了真值', () => {
  assert.equal(flags(`GITEE_TOKEN=${HEX32}`), true);
  assert.equal(flags(`GITEE_TOKEN="${HEX32}"`), true);
  assert.equal(flags(`DEPLOY_TOKEN: ${MIXED}`), true);
  assert.equal(flags(`const apiKey = '${MIXED}';`), true);
  assert.equal(flags(`password = "${PWD}"`), true, '密码里的 & 不该被形状检查误杀');
});

test('熵层：敏感词紧邻的高熵串', () => {
  assert.equal(flags(`Authorization: Bearer ${BLOB}`), true);
  assert.equal(flags(`curl -H 'Authorization: token ${BLOB}'`), true);
  assert.equal(flags(`{"api_key": "${MIXED}"}`), true);
  // JWT 里有点号，会被候选串的字符集切开——逐段看，前两段仍够长
  assert.equal(flags(`Authorization: Bearer ${JWT}`), true);
});

test('私钥块', () => {
  // 私钥头在文件里是拼出来的（见夹具注释），所以这几行没有字面量可拦——
  // 但规则本身必须认得。下面用拼接好的串喂给规则，验证的是规则而不是文件。
  assert.equal(flags(PK_HEAD), true);
  assert.equal(flags(PK_HEAD_RSA), true);
});

test('路径层：不该进仓库的文件名', () => {
  for (const p of ['server/.dev.vars', '.env', '.env.local', 'deploy/.deploy-token', 'a/id_rsa', 'cert.pem', 'config/credentials.json']) {
    assert.ok(checkPath(p), `${p} 应当被拦下`);
  }
});

test('行内豁免标记', () => {
  assert.equal(flags(`GITEE_TOKEN=${HEX32}  // secret-scan:allow`), false);
});

/* ---------------- 不该拦的（真实语料）---------------- */

test('不该拦：文档里只出现变量名', () => {
  const corpus = [
    '`GITEE_TOKEN` 由部署平台的环境变量注入，不进仓库。',
    '- `server/.dev.vars`（已被 .gitignore 排除）存放 GITEE_TOKEN、owner、仓库名。',
    '访问密码（APP_PASSWORD）与部署令牌都放在 .dev.vars 里，本文件不出现它们的值。',
  ];
  for (const line of corpus) assert.equal(flags(line), false, `误报：${line}`);
});

test('不该拦：散文里的敏感词与长串隔得远（实测撞出的两条）', () => {
  const corpus = [
    // 真实来自 docs/design/obsidian-mobile-web/map.md
    '- [02-single-vs-multi-user-auth](issues/02-single-vs-multi-user-auth.md) — MVP 单用户 self-hosted，token 作服务端配置；鉴权层可插拔，OAuth/多租户留 v2；app 发布为未来愿景。',
    // 真实来自 docs/design/.../research/03-remote-change-detection.md
    'Gitee OpenAPI v5 响应不返回 Access-Control-Allow-Origin，浏览器直接 fetch 报错（有实测）。故移动端 web 不能直连，需后端代理，顺带隐藏 access_token。',
  ];
  for (const line of corpus) assert.equal(flags(line), false, `误报：${line}`);
});

test('不该拦：右值是代码而不是字面量（实测撞出的三条）', () => {
  const corpus = [
    // 真实来自 web/src/vault-refs.js：点分标识符路径
    'const renderToken = md.renderer.rules.image || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));',
    'const token = tokens[idx];',
    // 真实来自本文件自己：正则字面量
    'const SECRET_WORDS = /(?:TOKEN|SECRET|PASSWORD|PASSWD)/i;',
    'const tokenCount = Number(localStorage.getItem("averyverylongkeyname"));',
  ];
  for (const line of corpus) assert.equal(flags(line), false, `误报：${line}`);
});

test('不该拦：占位值与引用', () => {
  const corpus = [
    'GITEE_TOKEN=your-token-here',
    'GITEE_TOKEN="YOUR_TOKEN_HERE"',
    'GITEE_TOKEN=xxxxxxxxxxxxxxxx',
    'GITEE_TOKEN=<你的令牌>',
    'GITEE_TOKEN=${GITEE_TOKEN}',
    'GITEE_TOKEN=process.env.GITEE_TOKEN',
    'APP_PASSWORD=change-me-please',
    'password = token',
  ];
  for (const line of corpus) assert.equal(flags(line), false, `误报：${line}`);
});

test('不该拦：lock 文件的完整性哈希与普通 URL', () => {
  const corpus = [
    '"integrity": "sha512-oVJq3C8kDn1lPqmZ0rT4XWvYbGfNhUe7aKsLc2d9MxQzRtE5wIhBnAoJl6pYyV3uUwKfSgZdNq0mQrC=="',
    'resolved "https://registry.npmjs.org/vite/-/vite-5.4.11.tgz"',
  ];
  for (const line of corpus) assert.equal(flags(line), false, `误报：${line}`);
});

test('不该拦：模板文件按路径放行', () => {
  for (const p of ['server/.dev.vars.example', '.env.sample', 'config/credentials.yaml.template']) {
    assert.equal(checkPath(p), null, `${p} 不该被路径规则拦下`);
  }
});

/* ---------------- 单元 ---------------- */

test('isSecretKeyName 按词切分，不按子串', () => {
  assert.equal(isSecretKeyName('GITEE_TOKEN'), true);
  assert.equal(isSecretKeyName('accessToken'), true);
  assert.equal(isSecretKeyName('API_KEY'), true, '拆开写但连起来是秘密词');
  assert.equal(isSecretKeyName('accessKey'), true);
  assert.equal(isSecretKeyName('SECRET_KEY'), true);
  assert.equal(isSecretKeyName('password'), true);
  assert.equal(isSecretKeyName('tokenizer'), false, '子串匹配会误伤');
  assert.equal(isSecretKeyName('keyboard'), false);
  assert.equal(isSecretKeyName('renderImage'), false);
});

test('isSecretKeyName 放过「关于秘密的元数据」', () => {
  assert.equal(isSecretKeyName('tokenCount'), false);
  assert.equal(isSecretKeyName('privateKeyPath'), false);
  assert.equal(isSecretKeyName('passwordPolicy'), false);
  assert.equal(isSecretKeyName('tokenizerVersion'), false);
  assert.equal(isSecretKeyName('secretManagerArn'), false);
  // 但元数据词出现在前面时不影响判断
  assert.equal(isSecretKeyName('countOfTokens'), true);
});

test('isLiteralValue 挡下标识符路径与表达式', () => {
  assert.equal(isLiteralValue(HEX32), true);
  assert.equal(isLiteralValue(MIXED), true);
  assert.equal(isLiteralValue(PWD), true);
  assert.equal(isLiteralValue('md.renderer.rules.image'), false);
  assert.equal(isLiteralValue('tokens[idx]'), false);
  assert.equal(isLiteralValue('tokens[0].value'), false);
  assert.equal(isLiteralValue('/(?:TOKEN|SECRET)/i'), false);
  assert.equal(isLiteralValue('aaaaaaaaaaaaaaaa'), false, '单一字符类不算');
});

test('isPlaceholderValue 认得中英文占位写法', () => {
  for (const v of ['your-token', 'YOUR_TOKEN_HERE', 'xxx', 'placeholder', 'change-me', '你的令牌', '示例值', '']) {
    assert.equal(isPlaceholderValue(v), true, `${v} 应判为占位`);
  }
  for (const v of [HEX32, MIXED, BLOB]) {
    assert.equal(isPlaceholderValue(v), false, `${v} 不应判为占位`);
  }
});

test('entropy 落在合理区间', () => {
  assert.ok(entropy('aaaaaaaa') < 0.1);
  assert.ok(entropy(HEX32) > 3.5);
});

test('命中带行号列号，且行内多条都报', () => {
  const text = ['# 标题', `GITEE_TOKEN=${HEX32}`, `APP_PASSWORD=${PWD}`].join('\n');
  const hits = scanContent('x', text);
  assert.deepEqual(hits.map((h) => h.line), [2, 3]);
  assert.deepEqual(hits.map((h) => h.col), [13, 14], '列号指向值的起点，就着编辑器能直接跳过去');
  assert.deepEqual(hits.map((h) => h.rule), ['形态', '形态']);
});

test('同一行两处不同的值都报，不会互相吃掉', () => {
  const hits = scanContent('x', `token_a = "${HEX32}"; token_b = "${HEX32B}";`);
  assert.equal(hits.length, 2);
});

test('值在语句分隔符处收住（`token = abc…;` 不能因分号漏报）', () => {
  const hits = scanContent('x', `const token = ${HEX32};`);
  assert.equal(hits.length, 1, '分号不该被吃进值里，否则会被当成表达式而漏报');
  assert.equal(hits[0].rule, '形态');
  assert.match(hits[0].detail, /token 被赋了/);
});

test('扫描器不把自己的测试语料当成泄漏', async () => {
  const self = await readFile(new URL('./check-secrets.test.mjs', import.meta.url), 'utf8');
  assert.deepEqual(
    scanContent('check-secrets.test.mjs', self),
    [],
    '假凭据必须写成中性常量 + 插值引用；直接写「秘密词 = 像真值的字面量」，' +
    '扫描器会把测试文件本身拦下来（实测发生过）。',
  );
});
