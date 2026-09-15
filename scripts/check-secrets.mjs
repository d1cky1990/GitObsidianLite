// 提交前凭据检查：把误提交拦在本地。
//
// 判断一条内容像不像真凭据，用三层，精度从高到低：
//
//   1. 指纹 —— 拿本机 server/.dev.vars 里的真值当指纹去扫。零误报、与格式无关。
//      这是唯一盖得住 Gitee 令牌的那一层：32 位 hex、无固定前缀，平台侧的
//      provider 规则对它完全失明（结论见 #1）。
//   2. 形态 —— 敏感变量名 + 像真值的赋值（GITEE_TOKEN = "..."）、私钥文件块、
//      天然的凭据文件名。
//   3. 熵   —— 高熵长串，**但只在它紧邻敏感词时**（`token=…`、`Bearer …`）。
//      不设「无关键词也拦」的那一档：lock 文件的 integrity、文档里的 URL 会立刻
//      把它淹掉，而它本来也分不清「32 位 hex 的令牌」与「32 位 hex 的 commit sha」。
//      没有关键词的兜底交给指纹层——拿本机真值当指纹，不靠猜。
//
// 这套东西成不成立只看一件事：**它会不会被人主动绕开**。误报多的 hook 会被
// --no-verify 掉，等于没装——而且更糟，它会让人以为有防护。所以规则只拦
// 「像真实值的」，文档里光出现 GITEE_TOKEN 这个变量名不算。
//
// 用法：
//   node scripts/check-secrets.mjs          检查暂存内容（pre-commit 调它）
//   node scripts/check-secrets.mjs --all    检查工作区全部文件
//
// 豁免一条：在该行任意位置写 `secret-scan:allow`。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 行内豁免标记 */
export const ALLOW_MARKER = /secret-scan:\s*allow/;

/** hooks 该指向哪里——`--status` 用它判断装没装 */
export const WANTED_HOOKS_PATH = '.githooks';

/**
 * 变量名里出现这些「词」，它的值才值得看一眼。
 * 按词切分再匹配，不按子串——`tokenizer` 这类名字里含 token，但不是秘密的容器；
 * 按子串匹配时连本文件自己的 `SECRET_KEY` 都被报了出来。
 */
const SECRET_WORDS = new Set([
  'token', 'secret', 'password', 'passwd', 'passphrase', 'credential',
  'credentials', 'authorization', 'bearer',
]);

/** 拆开写但连起来才是秘密词的名字：`API_KEY`、`privateKey`、`accessKey` */
const SECRET_COMPOUNDS = new Set([
  'apikey', 'accesskey', 'privatekey', 'secretkey', 'authtoken',
  'accessid', 'secretid', 'sessionkey', 'signingkey', 'encryptionkey',
]);

/**
 * 紧跟在秘密词后面的这些词说明：这个变量装的是**关于秘密的元数据**，不是秘密本身。
 * `tokenCount`、`privateKeyPath`、`passwordPolicy` —— 名字里都有秘密词，
 * 但它们的值是一串数字、一条路径、一个枚举。不排掉它们，误报会以「看起来最像
 * 安全代码」的方式混进来。
 */
const META_SUFFIX = new Set([
  'count', 'length', 'len', 'size', 'name', 'type', 'kind', 'path', 'file', 'dir',
  'url', 'uri', 'id', 'index', 'idx', 'version', 'ver', 'prefix', 'suffix', 'label',
  'header', 'format', 'ttl', 'expiry', 'expires', 'at', 'age', 'status', 'enabled',
  'required', 'help', 'hint', 'error', 'message', 'msg', 'policy', 'algorithm', 'algo',
  'field', 'param', 'manager', 'provider', 'source',
]);

/** 触发「附近有熵串」的关键词 */
const KEYWORD_HINT = /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|authorization|凭据|令牌|密钥|密码)/i;

/**
 * 敏感词必须落在候选串**前面**这么多字符内。
 * 秘密是被标注出来的——`token=xxx`、`Bearer xxx`、`"api_key": "xxx"`，标注总在
 * 值的前面。同一条长句里隔了四十个字符才出现「token」二字，那是散文，不是赋值；
 * 文档里的误报绝大多数来自这种巧合。
 */
const KEYWORD_WINDOW = 24;

/**
 * 熵串候选：不含 `.` `/` `+` `=`。
 * 这几种字符一放进来，URL 的路径、`foo.bar.baz` 形式的标识符、lock 文件里的
 * sha512 都会被当成一个「长串」——实测在 lock 与文档上会炸出几百条误报。
 */
const ENTROPY_CANDIDATE = /[A-Za-z0-9_-]{20,2048}/g;

/** 天然的凭据文件——按路径拦，与内容无关（`git add -f` 也拦得住） */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.dev\.vars(\.\w+)?$/, why: '本地凭据文件' },
  { re: /(^|\/)\.env(\.[\w.-]+)?$/, why: '环境文件' },
  { re: /(^|\/)\.deploy-token$/, why: '部署令牌' },
  { re: /\.token$/, why: '令牌文件' },
  { re: /\.pem$/, why: '私钥 / 证书' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, why: 'SSH 私钥' },
  { re: /(^|\/)(credentials|secrets)\.(json|ya?ml)$/i, why: '凭据文件' },
];
/** 模板后缀不算凭据文件 */
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;

/** 占位值的构成词——整个值由这些词拼出来，才算占位 */
const PLACEHOLDER_WORDS = new Set([
  'your', 'yours', 'the', 'my', 'mine', 'some', 'a', 'an', 'here', 'fill', 'in',
  'change', 'me', 'please', 'set', 'use', 'put', 'value',
  'token', 'password', 'passwd', 'secret', 'key', 'apikey', 'api', 'access', 'private',
  'xxx', 'xx', 'yyy', 'zzz', 'placeholder', 'example', 'sample', 'dummy', 'fake',
  'redacted', 'changeme', 'todo', 'tbd', 'test',
]);

/**
 * 是否是占位值（而非真值）。
 * @param {string} value
 */
export function isPlaceholderValue(value) {
  const s = String(value ?? '').replace(/^["']|["']$/g, '').trim();
  if (!s) return true;
  if (/[你的示例请待模板占位]/.test(s)) return true; // 中文占位词
  if (s.length > 40) return false;
  const words = s.toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => PLACEHOLDER_WORDS.has(w) || /^\d+$/.test(w));
}

/**
 * 变量名是否值得看它的值。
 * 按 `_` / `-` / 大小写边界切词，单段命中 `SECRET_WORDS`、或相邻两段拼起来命中
 * `SECRET_COMPOUNDS` 才算；命中后若紧跟着一个 `META_SUFFIX`，说明装的是元数据。
 * @param {string} name
 */
export function isSecretKeyName(name) {
  const segs = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // accessToken → access Token
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // APIKey → API Key
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

  /** 命中处「最后一个秘密词」的下标；-1 表示没命中 */
  let end = -1;
  for (let i = 0; i < segs.length; i++) {
    if (SECRET_WORDS.has(segs[i]) || SECRET_WORDS.has(segs[i].replace(/s$/, ''))) {
      end = i;
      continue;
    }
    if (i + 1 < segs.length && SECRET_COMPOUNDS.has(segs[i] + segs[i + 1])) end = i + 1;
  }
  if (end < 0) return false;
  return !META_SUFFIX.has(segs[end + 1]); // 元数据后缀 → 不是秘密的容器
}

/** 值是「引用」而不是「字面量」：读环境变量、属性访问、模板拼接 */
function isReference(value) {
  return /\$\{|\benv\.|process\.env|Deno\.env|import\.meta|=>/.test(value);
}

/**
 * 值是否具备「字面量秘密」的形状。
 * 用**禁字符**而不是允许字符集：白名单会把 `&` 这类密码里常见的符号一起卡掉
 * （实测 `Tr0ub4dor&3-Horse` 被误杀）。真正该判掉的是**表达式的形状**——
 * 函数调用、下标、正则、字符串插值、模板拼接。
 * 另一条是点分标识符路径 `md.renderer.rules.image`：没有禁字符，但那是代码。
 * @param {string} value
 */
export function isLiteralValue(value) {
  if (/[()[\]{}|?*\\,;!<>`"'#@$%^~:\s]/.test(value)) return false;
  if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(value)) return false;
  return charClasses(value) >= 2;
}

/** 香农熵（bit/字符） */
export function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 字符类数量：小写 / 大写 / 数字 / 符号 */
function charClasses(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[+/=_.-]/.test(s)) n++;
  return n;
}

/**
 * 从本地凭据文件里取出真值当指纹（只读、不打印）。
 * @param {string} root 仓库根
 * @returns {{source:string,key:string,value:string}[]}
 */
export function loadFingerprints(root, env = process.env) {
  const out = [];
  for (const rel of ['server/.dev.vars', '.dev.vars', '.env']) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (!m || !isSecretKeyName(m[1])) continue;
      const value = m[2].replace(/^["']|["']$/g, '').trim();
      if (value.length >= 8) out.push({ source: rel, key: m[1], value });
    }
  }
  // 同名环境变量（CI 里注入的那一份）
  for (const key of ['GITEE_TOKEN', 'APP_PASSWORD', 'DENO_DEPLOY_TOKEN']) {
    const value = env[key];
    if (value && value.length >= 8) out.push({ source: '环境变量', key, value });
  }
  return out;
}

/**
 * 扫描一段文本。
 * @param {string} file 展示用的路径
 * @param {string} text 内容
 * @param {{fingerprints?:{source:string,key:string,value:string}[]}} [opts]
 * @returns {{file:string,line:number,col:number,rule:string,detail:string,excerpt:string}[]}
 */
export function scanContent(file, text, opts = {}) {
  const fingerprints = opts.fingerprints || [];
  const hits = [];
  const lines = String(text).split(/\r?\n/);

  /** 把命中处换成脱敏标记——按位置替换，不用 String.replace（它会命中先出现的那个） */
  const maskAt = (line, start, len) =>
    line.slice(0, start) + maskValue(line.substr(start, len)) + line.slice(start + len);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOW_MARKER.test(line)) continue;
    const lineNo = i + 1;

    for (const fp of fingerprints) {
      const at = line.indexOf(fp.value);
      if (at < 0) continue;
      hits.push({
        file, line: lineNo, col: at + 1, rule: '指纹',
        detail: `与 ${fp.source} 里 ${fp.key} 的值一致`,
        excerpt: line.split(fp.value).join('«已脱敏»'),
      });
      break;
    }

    const pk = line.indexOf('-----BEGIN');
    if (pk >= 0 && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
      hits.push({ file, line: lineNo, col: pk + 1, rule: '私钥', detail: '私钥文件内容', excerpt: '«私钥块»' });
    }

    // 形态：敏感变量名 = 像真值的字面量。
    // 值在语句分隔符处收住——`token = abc…;` 里的分号不属于值，带着它会被
    // 形状检查当成表达式而漏报（实测）。`$` 与 `{}` 也排除：那是模板插值，
    // 右值是代码不是秘密（`token = ${SOME_CONST}`）。
    for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(["']?)([^\s'";,)\]}{$]+)\2/g)) {
      const [, key, , value] = m;
      if (!isSecretKeyName(key)) continue;
      if (value.length < 12) continue;
      if (isPlaceholderValue(value)) continue;
      if (isReference(value)) continue;   // 是引用不是值
      if (!isLiteralValue(value)) continue; // 是表达式/标识符路径，不是秘密
      const at = m.index + m[0].indexOf(value);
      hits.push({
        file, line: lineNo, col: at + 1, rule: '形态',
        detail: `${key} 被赋了一个像真值的字面量`,
        excerpt: maskAt(line, at, value.length),
      });
    }

    // 熵：敏感词紧邻其后的高熵串。
    // 只认「紧邻」，不认「同行」——判据与理由见 KEYWORD_WINDOW。
    for (const m of line.matchAll(ENTROPY_CANDIDATE)) {
      const cand = m[0];
      const lead = line.slice(Math.max(0, m.index - KEYWORD_WINDOW), m.index);
      if (!KEYWORD_HINT.test(lead)) continue;
      if (isPlaceholderValue(cand)) continue;
      const classes = charClasses(cand);
      const h = entropy(cand);
      if (classes < 2 || h < 3.2) continue;
      hits.push({
        file, line: lineNo, col: m.index + 1, rule: '熵',
        detail: `敏感词紧邻的高熵串（${cand.length} 字符，${classes} 类字符，熵 ${h.toFixed(1)}）`,
        excerpt: maskAt(line, m.index, cand.length),
      });
    }
  }
  // 同一个值常常同时命中形态层与熵层（`TOKEN=4f3a…` 两边都成立）。
  // 按「行 + 列」去重，同一处只报一次：输出翻倍不会让人更在意，只会让人更快学会跳过它。
  const seen = new Set();
  return hits.filter((h) => {
    const id = `${h.line}:${h.col}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 按路径判断：这个文件名本身就不该进仓库 */
export function checkPath(file) {
  if (TEMPLATE_SUFFIX.test(file)) return null;
  for (const { re, why } of FORBIDDEN_PATHS) {
    if (re.test(file)) return { file, line: 0, rule: '路径', detail: `不该进仓库的${why}`, excerpt: file };
  }
  return null;
}

/** 脱敏：留 3 个字符便于辨认，绝不整串打出来 */
function maskValue(v) {
  return v.length <= 4 ? '«已脱敏»' : `${v.slice(0, 3)}…«已脱敏，共 ${v.length} 字符»`;
}

/* ---------- CLI ---------- */

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function stagedFiles() {
  const out = git(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return out.split('\0').filter(Boolean);
}

function stagedContent(file) {
  try {
    const buf = execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 });
    return buf.includes(0) ? null : buf.toString('utf8'); // 二进制跳过内容规则
  } catch {
    return null;
  }
}

/** 所有「有可能被提交」的文件：已跟踪的 + 未跟踪但没被忽略的。被忽略的不算。 */
function committableFiles() {
  const opt = ['-c', 'core.quotepath=false'];
  const tracked = git([...opt, 'ls-files', '-z']).split('\0');
  const others = git([...opt, 'ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return [...new Set([...tracked, ...others])].filter(Boolean);
}

function report(hits, label) {
  if (hits.length === 0) return 0;
  console.error(`\n✗ 提交被拦下：${label}里发现 ${hits.length} 处疑似凭据\n`);
  for (const h of hits) {
    console.error(`  ${h.file}${h.line ? ':' + h.line + (h.col ? ':' + h.col : '') : ''}  [${h.rule}] ${h.detail}`);
    if (h.line) console.error(`      ${h.excerpt.trim().slice(0, 160)}`);
  }
  console.error(`
凭据一旦提交，删文件不等于删内容——要清干净得重写 git 历史，push 过的还得当
它已泄漏、轮换凭据。所以先确认，再绕过：

  · 误报        该行加 \`secret-scan:allow\`，或把占位值改成一眼假的（xxx / 你的令牌）
  · 真泄漏      从改动里拿掉，改放 server/.dev.vars（已被 .gitignore 排除）
  · 确实要绕过  git commit --no-verify   ← 绕过的正是这一层，别当成没事
`);
  return 1;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/check-secrets.mjs [--all | --status]');
    console.log('  默认      检查暂存内容（pre-commit 调它）');
    console.log('  --all     检查所有可能被提交的文件（含未跟踪、不含被忽略的）');
    console.log('  --status  确认 pre-commit hook 装没装（core.hooksPath 是本地配置，不进版本库）');
    return 0;
  }

  const root = git(['rev-parse', '--show-toplevel']).trim();
  process.chdir(root);

  if (argv.includes('--status')) {
    let current = '';
    try { current = git(['config', '--get', 'core.hooksPath']).trim(); } catch { /* 未设置 */ }
    const ok = current === WANTED_HOOKS_PATH;
    console.log(`仓库根      ${root}`);
    console.log(`core.hooksPath  ${current || '(未设置)'}`);
    console.log(`pre-commit  ${ok ? '✓ 已启用' : '✗ 未启用 —— 跑 node scripts/install-hooks.mjs'}`);
    console.log(`指纹        ${loadFingerprints(root).length} 条（来自 server/.dev.vars 与环境变量）`);
    return ok ? 0 : 1;
  }

  const mode = argv.includes('--all') ? 'all' : 'staged';
  const fingerprints = loadFingerprints(root);
  const hits = [];
  let checked = 0;
  const files = mode === 'staged' ? stagedFiles() : committableFiles();
  for (const file of files) {
    const p = checkPath(file);
    if (p) hits.push(p);
    let text;
    if (mode === 'staged') {
      text = stagedContent(file);
    } else {
      try {
        const buf = fs.readFileSync(file);
        text = buf.includes(0) || buf.length > 2 * 1024 * 1024 ? null : buf.toString('utf8');
      } catch { text = null; }
    }
    if (text == null) continue;
    checked++;
    hits.push(...scanContent(file, text, { fingerprints }));
  }

  const code = report(hits, mode === 'staged' ? '暂存内容' : '工作区');
  if (code === 0 && mode === 'all') {
    console.log(`✓ 扫过 ${checked} 个文件，未发现疑似凭据（指纹 ${fingerprints.length} 条）`);
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error('check-secrets 自身出错：', e && e.message);
    process.exitCode = 2;
  }
}
