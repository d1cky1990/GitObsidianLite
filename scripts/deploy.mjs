// 一条命令部署到 Cloudflare Workers：`node scripts/deploy.mjs`
//
// 把原来散在人手底下的几步压成一条：读配置 → 查部署令牌 → 自检 → 构建前端 →
// 推变量 → 部署 → 确认。顺序不是随手排的：
//
//   · **自检必须在开头。** 它走的是「本机 → 仓库平台（Gitee / GitHub）」这条路，五秒出结果；
//     放在构建之后才停，就白等几分钟。这也是「失败一律停下」这条能成立的前提。
//   · **末尾那次确认不能省。** 它走的是「Cloudflare → 仓库平台」这条路，与开头
//     那次不是同一条网络路（#18 的分法）：本机自检全过，不等于线上够得到仓库。
//
// 失败一律停下，不留强行部署的开关。话分两种，这不是语气差别：
//   · 说得清的（令牌 / 仓库 / 权限 / 变量缺项）→ 点名「哪一项、去哪改」
//   · 说不清的（网络 / 对方临时出错）→ 「没测出来，多半是网络，重跑一次」
// 两种话对应的是两种动作：去改配置，还是再试一次。混着说，人就只能瞎猜。
//
// 配置只有一处：`server/.dev.vars`（本地开发也读它）。部署令牌不进那个文件——
// 它只在本机环境变量 `CLOUDFLARE_API_TOKEN` 里，理由见 README「部署上线」。
//
// Workers 没有「建应用」这一步：`wrangler deploy` 第一次跑就把 Worker 建出来。
// 所以「幂等」在这里的含义是：第二次跑不重复建、变量已存在就改值、构建与上传
// 只是再来一遍。**没有任何一步会因为「上次跑过」而失败。**

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGACY_ENV, OPTIONAL_ENV, PROVIDER_NAMES, REQUIRED_ENV } from '../server/src/env-names.js';
import { BASE as GITEE_BASE } from '../server/src/providers/gitee.js';
import { BASE as GITHUB_BASE } from '../server/src/providers/github.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const WEB_DIR = path.join(ROOT, 'web');

/** 唯一一份配置。相对仓库根，报错时也用它说话 */
export const CONFIG_REL = 'server/.dev.vars';
/**
 * 配置项的名字**从服务端那一份取**，不在这里另写一份：应用说缺 A、脚本说缺 B 是最难查的
 * 一类错（`server/src/env-names.js`）。
 */
export const REQUIRED_KEYS = REQUIRED_ENV;
/** 可选：设了才启用访问密码 */
export const OPTIONAL_KEYS = OPTIONAL_ENV;
/** 能连的仓库平台 */
export const PROVIDERS = PROVIDER_NAMES;
/** 旧名字 → 新名字（#36 硬切）：检测到旧名还在用就逐条点名 */
export const LEGACY_KEYS = LEGACY_ENV;
/** 部署令牌：只在本机环境变量里，**不进配置文件、也不推给平台** */
export const DEPLOY_TOKEN_ENV = 'CLOUDFLARE_API_TOKEN'; // secret-scan:allow —— 这是变量名，不是值

/**
 * 各家的接口根与它要的那套鉴权。接口根**取自适配层**（同一件事只写一处）；
 * 这里只管自检要用的诊断信息（怎么称呼它、权限字段叫什么）。
 */
const PROVIDER_HTTP = {
  gitee: {
    label: 'Gitee',
    base: GITEE_BASE,
    host: 'gitee.com',
    permissionField: 'permission',
  },
  github: {
    label: 'GitHub',
    base: GITHUB_BASE,
    host: 'api.github.com',
    permissionField: 'permissions',
  },
};
const UA = 'obsidian-mobile-web/1.0 (deploy script)';
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

/** 建仓时放的那篇示例笔记——放仓库根、名字一眼能认出，把各记号演示一遍 */
export const SAMPLE_NOTE_PATH = '从这里开始.md';
export const SAMPLE_NOTE = [
  '# 从这里开始',
  '',
  '这篇是部署脚本替你建的示例笔记，用来确认「打开一篇笔记」这条路是通的。看够了直接删掉。',
  '',
  '## 列表与勾选框',
  '',
  '- 这是一条普通列表',
  '- [ ] 点一下方框，它会被勾上（真会改这篇文件）',
  '- [x] 再点一下取消',
  '',
  '## 双链与标签',
  '',
  '- 双链：[[从这里开始]]（指向这一篇，能点）',
  '- 标签：#示例 #手机笔记',
  '',
  '## 表格',
  '',
  '| 记号 | 手机上长什么样 |',
  '|---|---|',
  '| `#标签` | 小胶囊 |',
  '| `- [ ]` | 可点的方框 |',
  '| `[[笔记]]` | 可点的链接 |',
  '',
].join('\n');

/* ---------------- 配置（纯函数，可单测） ---------------- */

/**
 * 读 `.dev.vars` 的正文，交出键值对。
 * 只认 `KEY = value` 这一种形状；注释行、空行、看不懂的行一律跳过。
 * 引号里的值原样取出（`#` 是密码里的合法字符，不能无脑当行尾注释切掉）。
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDevVars(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (/^["']/.test(value)) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** 模板里的占位值——填了等于没填，得当成「缺」 */
export function isPlaceholder(value) {
  const s = String(value ?? '').trim();
  if (!s) return true;
  return /^(你的|your\b)/i.test(s) || /^<.*>$/.test(s);
}

/**
 * 缺了哪几项（含「还是模板里的占位值」）。顺序固定，报错时按这个顺序点名。
 * @param {Record<string, string>} parsed
 */
export function missingConfigKeys(parsed) {
  return REQUIRED_KEYS.filter((key) => isPlaceholder(parsed[key]));
}

/**
 * 旧名字还在用的那几项（旧名有值、对应的新名没值）。
 * 只报「真的靠旧名在跑」的那些：新旧都配着的人只是没删旧行，不该被拦下来。
 * @param {Record<string, string>} parsed
 * @returns {string[]} 形如 `GITEE_TOKEN → REPO_TOKEN`
 */
export function legacyKeyReport(parsed) {
  return Object.entries(LEGACY_KEYS)
    .filter(([oldName, newName]) => parsed[oldName] && !parsed[newName])
    .map(([oldName, newName]) => `${oldName} → ${newName}`);
}

/**
 * `REPO_PROVIDER` 有没有问题。**它没有默认值**：默认成 Gitee 的话，配了 GitHub 令牌
 * 却忘写连哪家的人会拿到一个指向 Gitee、报「令牌无效」的错误，排查方向被带向错的地方。
 * @param {Record<string, string>} parsed
 * @returns {string|null}
 */
export function providerProblem(parsed) {
  const v = String(parsed.REPO_PROVIDER ?? '').trim();
  if (!v) return 'REPO_PROVIDER 没配——它没有默认值，得自己写连哪一家';
  if (!PROVIDERS.includes(v)) return `REPO_PROVIDER 只能是 ${PROVIDERS.join(' 或 ')}，现在是「${v}」`;
  return null;
}

/** 配置里多出来的键——不推，但要提一句，因为其中可能有部署令牌 */
export function unknownConfigKeys(parsed) {
  return Object.keys(parsed).filter((k) => !REQUIRED_KEYS.includes(k) && !OPTIONAL_KEYS.includes(k));
}

/**
 * 访问密码还是模板里那句占位话时，当作没设。
 * 不这样处理的话，它会被当成一个真的密码推上去——而它同时也能通过末尾的确认
 * （应用拿同一个字符串比，当然相等），于是「密码没填」这件事从头到尾不会露头。
 * @param {Record<string, string>} parsed
 */
export function dropPlaceholderPassword(parsed) {
  if (!parsed.APP_PASSWORD || !isPlaceholder(parsed.APP_PASSWORD)) return parsed;
  const { APP_PASSWORD, ...rest } = parsed;
  return rest;
}

/**
 * 该推哪几项、各走哪条路。
 * **机密走 secret、其余走 var**：令牌与访问密码是机密，平台的 secret 接口不让读回明文；
 * 供应商 / owner / 仓库名是普通变量，走 `--var` 就在部署命令里，不留状态。
 * 除这几项之外**一个字都不推**——配置文件里躺着别的键，也不能顺手带走。
 * @param {Record<string, string>} values
 * @returns {{secrets: string[], vars: string[]}}
 */
export function pushPlan(values) {
  return {
    secrets: ['REPO_TOKEN', ...(values.APP_PASSWORD ? ['APP_PASSWORD'] : [])],
    vars: ['REPO_PROVIDER', 'REPO_OWNER', 'REPO_REPO'],
  };
}

/**
 * `wrangler deploy` 的 `--var` 参数。
 * 用命令行参数而不是写进 wrangler.toml：配置只有 server/.dev.vars 一处，
 * 抄进 toml 就是第二份，而第二份没人校对。
 * @param {Record<string, string>} values
 */
export function deployVarArgs(values) {
  return [
    '--var', `REPO_PROVIDER:${values.REPO_PROVIDER}`,
    '--var', `REPO_OWNER:${values.REPO_OWNER}`,
    '--var', `REPO_REPO:${values.REPO_REPO}`,
  ];
}

/**
 * 从 wrangler 的输出里揪出线上地址。
 * 认的是 `<worker>.<账号>.workers.dev` 这个形状——wrangler 在 "Deployed ... triggers"
 * 后面打一行它。揪不到不算失败：地址能在控制台看到，只是这一步的确认做不了。
 * @param {string} text
 */
export function parseWorkersUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return m ? m[0] : null;
}

/* ---------------- 失败怎么说话（纯函数，可单测） ---------------- */

/**
 * 自检里某一项没通过时，那句话怎么说。
 *
 * `what` 指是哪一项，因为**同一个状态码在不同项上意思不同**：404 在「读仓库」上
 * 是仓库不存在或看不见，在「读默认分支」上是仓库还是空的。按状态码统一翻译，就会
 * 把人指到错的地方去。
 *
 * 返回值里 `kind` 决定最后一句：`config` = 去改配置，`network` = 再试一次。
 * @param {{provider?: 'gitee'|'github', what: 'token'|'repo'|'branch'|'write', status?: number, body?: unknown, network?: string}} e
 * @returns {{kind: 'config'|'network', message: string, hint: string[]}}
 */
export function providerFailureMessage({ provider = 'gitee', what, status, body, network }) {
  const p = PROVIDER_HTTP[provider] || PROVIDER_HTTP.gitee;
  const upstream = messageOf(body);

  if (network || status === 0) {
    return {
      kind: 'network',
      message: `连不上 ${p.host}${network ? `（${network}）` : ''}`,
      hint: ['这项没测出来，多半是网络，重跑一次：node scripts/deploy.mjs'],
    };
  }

  if (what === 'token') {
    if (status === 401 || status === 403) {
      return {
        kind: 'config',
        message: `REPO_TOKEN 被 ${p.label} 拒了（令牌无效、过期，或者被吊销了）`,
        hint: provider === 'github'
          ? [
            '去 GitHub 重新生成一个：Settings → Developer settings → Personal access tokens → Fine-grained tokens',
            '只授权这个仓库的 Contents: read and write 就够（最小权限）；经典令牌要勾 repo',
            `把新值填回 ${CONFIG_REL} 的 REPO_TOKEN`,
          ]
          : [
            '去 Gitee 重新生成一个：设置 → 私人令牌，勾上 projects',
            `把新值填回 ${CONFIG_REL} 的 REPO_TOKEN`,
          ],
      };
    }
    return {
      kind: 'network',
      message: `${p.label} 回了 ${status}${upstream ? `（${upstream}）` : ''}，不是「令牌不对」该有的样子`,
      hint: [`这项没测出来，可能是 ${p.label} 自己出问题了，过一会儿重跑一次`],
    };
  }

  if (what === 'repo') {
    if (status === 404) {
      return {
        kind: 'config',
        message: '仓库不存在，或者这个令牌看不见它',
        hint: [
          `核对 ${CONFIG_REL} 里的 REPO_OWNER 与 REPO_REPO——名字大小写要和 ${p.label} 上完全一致`,
          provider === 'github'
            ? '私有仓库还要令牌被授权到这个仓库（细粒度令牌要单独勾选仓库）'
            : '私有仓库还要令牌有 projects 权限（Gitee 的私人令牌页面能勾）',
          '仓库确实还没建的话，加 --create-repo 让脚本替你建一个私有仓',
        ],
      };
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'config',
        message: '这个令牌读不了这个仓库（被拒了）',
        hint: [
          provider === 'github'
            ? '细粒度令牌要在 Repository access 里勾上这个仓库，权限给 Contents: read'
            : '令牌要勾 projects 权限，然后用的是自己的令牌：Gitee 设置 → 私人令牌',
        ],
      };
    }
    return {
      kind: 'network',
      message: `读仓库时 ${p.label} 回了 ${status}${upstream ? `（${upstream}）` : ''}`,
      hint: [`这项没测出来，多半是网络或 ${p.label} 自己出错，重跑一次`],
    };
  }

  if (what === 'branch') {
    if (status === 404) {
      return {
        kind: 'config',
        message: '仓库里读不到默认分支——多半是个空仓库（一次提交都没有）',
        hint: [
          '空仓库没有分支，应用打开就是空的',
          '先随便提交一篇笔记；或者删掉重来，加 --create-repo 让脚本建仓时顺手放一篇示例',
        ],
      };
    }
    return {
      kind: 'network',
      message: `读默认分支时 ${p.label} 回了 ${status}${upstream ? `（${upstream}）` : ''}`,
      hint: ['这项没测出来，多半是网络，重跑一次'],
    };
  }

  // what === 'write'：仓库读到了，但权限字段说不能写
  return {
    kind: 'config',
    message: '这个令牌能读这个仓库，但没有写权限（提交会失败）',
    hint: [
      provider === 'github'
        ? '细粒度令牌要改成 Contents: read and write（经典令牌勾 repo）'
        : 'Gitee → 设置 → 私人令牌 → 重新生成，勾上 projects',
      '如果这个仓库是别人的，需要对方把你加成开发者 / collaborator',
    ],
  };
}

/** Gitee 的错误体有两种形态：`{message}` 与 `{messages: []}` */
function messageOf(body) {
  if (typeof body === 'string') return body.slice(0, 200);
  if (!body || typeof body !== 'object') return '';
  if (body.message) return String(body.message).slice(0, 200);
  if (Array.isArray(body.messages)) return body.messages.join('；').slice(0, 200);
  return '';
}

/**
 * 本项目自己的 API 的错法是 `{error: "..."}`（见 `server/src/core.js`），
 * 与 Gitee 的 `{message}` **不是同一个字段**。认错了字段，就会把「变量没配齐」
 * 说成「连不上仓库」——而这两件事一个去改配置、一个去查网络。
 */
function apiErrorText(body) {
  if (typeof body === 'string') return body.slice(0, 300);
  if (!body || typeof body !== 'object') return '';
  return String(body.error || body.message || '').slice(0, 300);
}

/**
 * 末尾那次确认：线上到底通没通。
 *
 * 这里要分清三件事，混成一句「失败了」就等于把三条不同的路说成一条：
 *   · `unreachable` —— 本机根本没连上那个地址（本机 → Cloudflare 这条路）
 *   · `missing-vars` —— 应用起来了，但变量没到位（部署侧的事，去改配置）
 *   · `upstream` —— 应用起来了、变量也在，但它连不上仓库（Cloudflare → Gitee 这条路）
 * @param {{status?: number, body?: any, network?: string}} r
 * @returns {{ok: boolean, kind: 'ok'|'auth'|'missing-vars'|'upstream'|'unreachable', message: string, sha?: string}}
 */
export function classifyRuntime({ status, body, network }) {
  if (network || !status) {
    return { ok: false, kind: 'unreachable', message: `打不开线上地址（${network || '没有响应'}）` };
  }
  if (status === 200 && body && typeof body.sha === 'string') {
    return { ok: true, kind: 'ok', sha: body.sha, message: `线上读到了仓库最新版本 ${body.sha.slice(0, 7)}` };
  }
  if (status === 401) {
    return {
      ok: false,
      kind: 'auth',
      message: '应用要访问密码，而它不认本地这份',
    };
  }
  const text = apiErrorText(body);
  if (status >= 500 && /未配置/.test(text)) {
    return {
      ok: false,
      kind: 'missing-vars',
      message: `应用起来了，但它的变量没配齐：${text}`,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      kind: 'unreachable',
      message: '地址通了，但它在 /api/head 上回 404——这个地址上好像不是应用本身',
    };
  }
  return {
    ok: false,
    kind: 'upstream',
    message: `应用起来了，但它连不上仓库：${text || `回了 ${status}`}`,
  };
}

/* ---------------- 跑子进程 ---------------- */

/**
 * 跑一条命令，收下它的输出。
 * 不用 execFileSync：本机实测同步启动子进程会以 EBUSY 失败（见 check-secrets.mjs）。
 * @returns {Promise<{code:number, out:string, err:string, error?:Error}>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd || ROOT,
        env: opts.env || process.env,
        // Windows 上 npm 是 .cmd，绕不开 shell（.cmd 不能被直接 exec）
        shell: Boolean(opts.shell),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, out: '', err: '', error });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; if (opts.echo) process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; if (opts.echo) process.stderr.write(d); });
    // 子进程不读 stdin 时（比如 vite）写进去会 EPIPE；那不是错误
    child.stdin.on('error', () => {});
    child.on('error', (error) => resolve({ code: -1, out, err, error }));
    child.on('close', (code) => resolve({ code, out, err }));
    // 机密走 stdin，不走命令行参数——参数会进进程列表与 shell 历史
    child.stdin.end(opts.stdin == null ? '' : opts.stdin);
  });
}

/* ---------------- 说话 ---------------- */

const say = (s = '') => console.log(s);
const bad = (s = '') => console.error(s);

/** 走到某一步，且这一步没过：带上「哪一步 + 下一步怎么办」，由 main 统一打印 */
class Stop extends Error {
  constructor(info) {
    super(info.headline);
    this.info = info;
  }
}

function printStop(info) {
  bad('');
  bad(`✗ 第 ${info.step} 步（${STEPS[info.step - 1]}）没过：${info.headline}`);
  for (const line of info.detail || []) bad(`   ${line}`);
  if (info.hint && info.hint.length) {
    bad('');
    for (const line of info.hint) bad(`   → ${line}`);
  }
  bad('');
  bad('没有继续往下走——部署出来也只会是个用不了的东西。');
}

/* ---------------- 网络：仓库平台与线上应用 ---------------- */

/**
 * 打一次仓库平台。两家的鉴权形态在这里分完（Gitee 查询串 / GitHub Bearer 头），
 * 上层只面对「状态码 + 错误体」。
 *
 * 网络层失败（连不上、超时）用 `status: 0` + `network` 交回，HTTP 层失败原样交回
 * 状态码与错误体——**怎么解释交给上层的 `providerFailureMessage`**，
 * 因为同一个状态码在不同项上意思不同。
 * @returns {Promise<{status:number, body:any, network?:string}>}
 */
async function providerRequest(provider, pathname, { token, method = 'GET', payload, timeout = 15000 } = {}) {
  const p = PROVIDER_HTTP[provider] || PROVIDER_HTTP.gitee;
  const init = {
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  };

  let url;
  if (provider === 'github') {
    url = `${p.base}${pathname}`;
    init.headers.Authorization = `Bearer ${token}`;
    init.headers['X-GitHub-Api-Version'] = '2022-11-28';
  } else {
    const sep = pathname.includes('?') ? '&' : '?';
    url = `${p.base}${pathname}${sep}access_token=${encodeURIComponent(token)}`;
  }

  if (payload !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    return { status: 0, body: null, network: networkText(e) };
  }
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, body };
}

/** 把 fetch 的异常翻成一句人能读的原因 */
function networkText(e) {
  if (!e) return '未知错误';
  if (e.name === 'TimeoutError' || /timed out|timeout/i.test(e.message || '')) return '等了 15 秒没有回应';
  const cause = e.cause && (e.cause.code || e.cause.message);
  return cause ? `${e.message}：${cause}` : e.message || String(e);
}

/* ---------------- 自检（本机 → 仓库平台） ---------------- */

/**
 * 四项检查，全部是**只读**的：令牌活否 / 仓库在否且看得见 / 有没有写权限 / 默认分支读不读得到。
 * 第三项不做真写入——仓库信息接口自带「调用者对本仓的写权限」，读它即可，
 * 不在别人的仓库里留垃圾。
 *
 * 两家在这四项上问的是同一批问题，只是**权限字段的名字不同**（Gitee `permission`、
 * GitHub `permissions`），所以只差一行取值。
 * @returns {Promise<{login:string, repo:any, branch:string, sha:string}>}
 */
async function selfCheck(values, { onLine }) {
  // 解构取值（不写成 `const token = values.REPO_TOKEN`）：那样写会被提交前的凭据检查
  // 当成「token 被赋了一个像真值的字面量」拦下来——它认形状，认不出右边是个变量
  const { REPO_PROVIDER: provider, REPO_TOKEN: token, REPO_OWNER: owner, REPO_REPO: repo } = values;

  /** 点名到这里为止：哪一项、什么话、去哪改。`reason` 给上层判断，别让上层去比文案 */
  let login = '';
  const stop = (what, r) => {
    const msg = providerFailureMessage({ provider, what, status: r.status, body: r.body, network: r.network });
    throw new Stop({
      step: 3,
      reason: what === 'repo' && r.status === 404 ? 'repo-missing' : `${what}-failed`,
      login,
      headline: msg.message,
      detail: [`检查的是 ${owner}/${repo}（令牌与仓库名都来自 ${CONFIG_REL}）`],
      hint: msg.hint,
    });
  };

  // ① 令牌活否
  const me = await providerRequest(provider, '/user', { token });
  if (me.status < 200 || me.status >= 300) stop('token', me);
  login = me.body.login || '';
  onLine(`令牌     ✓ 有效（${login || '已通过'}）`);

  // ② 仓库在否、看不看得见
  const repoInfo = await providerRequest(provider, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
  if (repoInfo.status < 200 || repoInfo.status >= 300) stop('repo', repoInfo);
  const privacy = repoInfo.body.private ? '私有' : '公开';
  onLine(`仓库     ✓ ${owner}/${repo}（${privacy}）`);

  // ③ 写权限（读字段，不写东西）
  const permissionField = PROVIDER_HTTP[provider].permissionField;
  const perm = repoInfo.body[permissionField] || {};
  if (perm.push === false) stop('write', { status: 200, body: repoInfo.body });
  // 字段缺失时**不当作通过**，也不因此停下：说的是「没读到」，让人自己心里有数。
  // 把「没读到」说成「有权限」是这一层最坏的一种谎。
  onLine(perm.push ? '写权限   ✓ 可以提交' : '写权限   ? 没读到权限字段，没法确认（可能提交时才失败）');

  // ④ 默认分支读不读得到（两家都是 /branches/{name}，回执里都有 commit.sha）
  const branch = repoInfo.body.default_branch || (provider === 'github' ? 'main' : 'master');
  const head = await providerRequest(
    provider,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
    { token }
  );
  if (head.status < 200 || head.status >= 300) stop('branch', head);
  const sha = (head.body && head.body.commit && head.body.commit.sha) || '';
  onLine(`默认分支 ✓ ${branch}${sha ? `（最新 ${sha.slice(0, 7)}）` : ''}`);

  return { login, repo: repoInfo.body, branch, sha };
}

/* ---------------- 可选：替用户建仓 ---------------- */

/** 「这个名字被占了」在两家是不同的号码：Gitee 400 + 措辞，GitHub 422 + errors[].code */
export function isNameTaken(provider, { status, body }) {
  if (provider === 'github') {
    const codes = (body && Array.isArray(body.errors) ? body.errors : [])
      .map((e) => (e && (e.code || e.message)) || '').join(' ');
    return status === 422 && /already exists|already_exists|name already exists/i.test(`${messageOf(body)} ${codes}`);
  }
  return status === 400 && /已存在|already exists/i.test(messageOf(body));
}

/**
 * 仓库不存在时，替用户建一个私有仓，并在根目录放一篇示例笔记。
 * 只在这个仓库**刚被建出来、还是空的**时候写东西——不在已有仓库里落任何文件。
 * 重名一律停下：自动加后缀会凭空多出一个仓，人自己都找不到。
 */
async function createRepo(values, login) {
  const { REPO_PROVIDER: provider, REPO_TOKEN: token, REPO_OWNER: owner, REPO_REPO: repo } = values;
  const p = PROVIDER_HTTP[provider];

  if (owner.toLowerCase() !== String(login).toLowerCase()) {
    throw new Stop({
      step: 3,
      headline: `仓库还没建，但 owner（${owner}）不是这个令牌的账号（${login}）`,
      detail: ['脚本只能在自己的账号下建仓，不能替别人建'],
      hint: [
        `把 ${CONFIG_REL} 的 REPO_OWNER 改成 ${login}（或者你自己先在网页上把仓库建好）`,
      ],
    });
  }

  say(`   仓库还没建，建一个私有仓并放一篇示例笔记（${SAMPLE_NOTE_PATH}）`);
  const created = await providerRequest(provider, '/user/repos', {
    token,
    method: 'POST',
    payload: { name: repo, private: true, auto_init: true, description: '手机端笔记（GitObsidianLite）' },
    timeout: 20000,
  });
  if (isNameTaken(provider, created)) {
    throw new Stop({
      step: 3,
      headline: `「${repo}」这个名字已经被占了`,
      detail: ['脚本不会自动加后缀——那样会凭空多出一个仓，你自己都找不到'],
      hint: [`换一个名字，改 ${CONFIG_REL} 里的 REPO_REPO`],
    });
  }
  if (created.status < 200 || created.status >= 300) {
    throw new Stop({
      step: 3,
      headline: `建仓没成（${p.label} 回了 ${created.status}${created.network ? `：${created.network}` : ''}）`,
      detail: [messageOf(created.body) || `（${p.label} 没给错误体，也没有别的线索）`],
      hint: [
        `也可以自己在网页上建一个私有仓，然后把名字填回 ${CONFIG_REL} 的 REPO_REPO`,
        '仓库名被占了就换一个——脚本不会自动加后缀（那样会多出一个仓，你自己都找不到）',
      ],
    });
  }

  // 放示例笔记：Gitee 新建走 POST，GitHub 新建走 PUT（都是「不带 sha」那一侧）
  const note = await providerRequest(provider, `/repos/${owner}/${repo}/contents/${encodeURIComponent(SAMPLE_NOTE_PATH)}`, {
    token,
    method: provider === 'github' ? 'PUT' : 'POST',
    payload: {
      content: Buffer.from(SAMPLE_NOTE, 'utf8').toString('base64'),
      message: '初始化：放一篇示例笔记',
    },
    timeout: 20000,
  });
  if (note.status < 200 || note.status >= 300) {
    throw new Stop({
      step: 3,
      headline: '仓库建好了，但示例笔记没写进去',
      detail: [`${p.label} 回的是 ${note.status}：${messageOf(note.body) || '（没有错误体）'}`],
      hint: ['仓库本身是可用的，重跑一次即可（建仓那步会因为已存在而跳过）'],
    });
  }
}

/* ---------------- 本地依赖与构建 ---------------- */

function hasModule(dir, name) {
  return fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'));
}

/** 装依赖。只在缺的时候跑——第二次之后这一步不会出现 */
async function ensureDeps(dir, marker, label) {
  if (hasModule(dir, marker)) return;
  say(`   ${label} 还没装依赖，先装一次（只有第一次会跑到这里）`);
  const r = await run(NPM, ['install', '--no-audit', '--no-fund'], { cwd: dir, shell: IS_WIN, echo: true });
  if (r.error) {
    throw new Stop({
      step: 4,
      headline: '找不到 npm',
      detail: [String(r.error.message || r.error)],
      hint: ['需要 Node 22（装完要重开终端，让 PATH 生效）'],
    });
  }
  if (r.code !== 0) {
    throw new Stop({
      step: 4,
      headline: `${label} 装依赖失败`,
      detail: ['上面是 npm 最后打印的几行'],
      hint: ['多半是网络，重跑一次；一直不行就进那个目录手动跑 npm install 看完整报错'],
    });
  }
}

/* ---------------- 主流程 ---------------- */

const STEPS = ['读配置', '查部署令牌', '自检', '构建前端', '推变量并部署', '确认线上'];
const TOTAL = STEPS.length;

function step(n) {
  say('');
  say(`▸ ${n}/${TOTAL} ${STEPS[n - 1]}`);
}

/**
 * 拆命令行参数。`--subdomain 名字` 与 `--subdomain=名字` 都认——
 * 这个名字是「workers.dev 子域」，注册完全球唯一，只能由人给，脚本不编。
 * @param {string[]} argv
 * @returns {{flags: Set<string>, values: {subdomain?: string}}}
 */
export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--subdomain' || a === '-s') { values.subdomain = argv[++i]; continue; }
    if (a.startsWith('--subdomain=')) { values.subdomain = a.slice('--subdomain='.length); continue; }
    if (a.startsWith('-')) flags.add(a);
  }
  return { flags, values };
}

async function main(argv) {
  const { flags, values: options } = parseArgs(argv);
  if (flags.has('--help') || flags.has('-h')) {
    printHelp();
    return 0;
  }
  const dryRun = flags.has('--dry-run');
  const wantCreateRepo = flags.has('--create-repo');
  const subdomain = options.subdomain;

  say(`仓库根  ${ROOT}`);
  say(`配置    ${CONFIG_REL}`);

  /* 1 读配置 ------------------------------------------------------------ */
  step(1);
  const cfgFile = path.join(ROOT, CONFIG_REL);
  if (!fs.existsSync(cfgFile)) {
    throw new Stop({
      step: 1,
      headline: `没找到 ${CONFIG_REL}`,
      detail: ['这个文件是唯一一份配置，本地开发与部署都读它'],
      hint: [`复制一份模板：server/.dev.vars.example → ${CONFIG_REL}`, '然后把令牌、owner、仓库名填进去'],
    });
  }
  const raw = parseDevVars(fs.readFileSync(cfgFile, 'utf8'));

  // 旧名字硬切（#36）：报一句「未配置」等于让人自己猜三个名字的对应关系，
  // 而猜错的方向通常是「令牌坏了」，于是会白白重建一次令牌。
  const legacy = legacyKeyReport(raw);
  if (legacy.length) {
    throw new Stop({
      step: 1,
      headline: '配置用的是旧变量名，已经不再认（换成中性名了）',
      detail: [...legacy.map((line) => `${line}`), '另外要加一项 REPO_PROVIDER：连 Gitee 填 gitee，连 GitHub 填 github'],
      hint: [
        `改 ${CONFIG_REL} 里的名字（模板见 server/.dev.vars.example）`,
        '这是硬切：旧名字不再兼容运行，但改三个名字只是几分钟的事',
      ],
    });
  }

  const values = dropPlaceholderPassword(raw);
  if (raw.APP_PASSWORD && !values.APP_PASSWORD) {
    say('   APP_PASSWORD 还是模板里的占位值，按「没设」处理（要密码就换成真的）');
  }

  const problem = providerProblem(values);
  if (problem) {
    throw new Stop({
      step: 1,
      headline: problem,
      detail: ['它决定这个部署连哪一家：两家的令牌、权限、接口都不一样'],
      hint: [
        `在 ${CONFIG_REL} 里写一行 REPO_PROVIDER = gitee（或 github）`,
        '故意不给默认值：默认成 Gitee 的话，「配了 GitHub 令牌却忘写连哪家」会被报成「令牌无效」，方向全错',
      ],
    });
  }

  const missing = missingConfigKeys(values);
  if (missing.length) {
    throw new Stop({
      step: 1,
      headline: `缺 ${missing.join(' / ')}`,
      detail: ['这几项是应用自己要用的，缺一项应用就起不来'],
      hint: [
        `在 ${CONFIG_REL} 里补上（模板见 server/.dev.vars.example）`,
        '令牌的权限：Gitee 勾 projects；GitHub 用细粒度令牌、只授权这个仓库的 Contents: read/write',
        'owner 与仓库名的大小写要和平台上完全一致',
      ],
    });
  }
  const plan = pushPlan(values);
  const shown = [...plan.secrets, ...plan.vars];
  say(`   连的是 ${PROVIDER_HTTP[values.REPO_PROVIDER].label}（REPO_PROVIDER=${values.REPO_PROVIDER}）`);
  say(`   读到 ${shown.length} 项：${shown.join(' / ')}`);

  const unknown = unknownConfigKeys(values);
  if (unknown.length) {
    // 只提一句，不推。部署令牌躺在这份文件里是个常见误放——那份文件会被整份读进应用进程
    say(`   另外还有 ${unknown.join(' / ')} —— 这些不推给平台（只推上面那几项）`);
    if (unknown.some((k) => /DEPLOY|CLOUDFLARE|CF_/i.test(k))) {
      say(`   ⚠ 部署令牌别放这里：它该在本机环境变量 ${DEPLOY_TOKEN_ENV} 里`);
    }
  }

  /* 2 查部署令牌 -------------------------------------------------------- */
  step(2);
  const deployToken = process.env[DEPLOY_TOKEN_ENV];
  if (!deployToken) {
    throw new Stop({
      step: 2,
      headline: `本机环境变量里没有 ${DEPLOY_TOKEN_ENV}`,
      detail: ['它只用于从这台机器推代码，不属于应用，所以不进配置文件'],
      hint: [
        '在 Cloudflare 控制台建一个 API 令牌：My Profile → API Tokens → 用 "Edit Cloudflare Workers" 模板',
        `cmd 里设一次：setx ${DEPLOY_TOKEN_ENV} "..."   —— 然后重开终端，PATH / 环境变量才刷新`,
        '（用 cmd 而不是 PowerShell：PowerShell 会把命令记进历史文件，令牌跟着落盘）',
      ],
    });
  }
  say(`   ${DEPLOY_TOKEN_ENV} 已设置（值不打印）`);
  if (process.env.CLOUDFLARE_ACCOUNT_ID) say('   CLOUDFLARE_ACCOUNT_ID 也设了：部署到它指定的那个账号');

  /* 3 自检（本机 → 仓库平台） ------------------------------------------- */
  step(3);
  const providerHost = PROVIDER_HTTP[values.REPO_PROVIDER].host;
  say(`   走的是「本机 → ${providerHost}」，与后面部署那条路不是同一条`);
  let head;
  try {
    head = await selfCheck(values, { onLine: (l) => say(`   ${l}`) });
  } catch (e) {
    // 仓库不存在时给「替用户建仓」留一条明路——但仍然要点名，绝不偷偷建。
    // 认的是 `reason`，不是那句给人看的话：文案一改，这条明路就会无声地失效。
    const repoMissing = e instanceof Stop && e.info.reason === 'repo-missing';
    if (!repoMissing || !wantCreateRepo) throw e;
    await createRepo(values, e.info.login);
    head = await selfCheck(values, { onLine: (l) => say(`   ${l}`) });
  }

  /* 4 构建前端 ---------------------------------------------------------- */
  step(4);
  await ensureDeps(WEB_DIR, 'vite', '前端');
  const build = await run(NPM, ['run', 'build'], { cwd: WEB_DIR, shell: IS_WIN, echo: true });
  if (build.code !== 0) {
    throw new Stop({
      step: 4,
      headline: '前端构建失败',
      detail: ['上面是构建工具最后打印的几行'],
      hint: ['先本地复现：cd web && npm run build'],
    });
  }
  if (!fs.existsSync(path.join(WEB_DIR, 'dist', 'index.html'))) {
    throw new Stop({
      step: 4,
      headline: '构建说成功了，但 web/dist 里没有 index.html',
      detail: ['wrangler 把 web/dist 当静态资源目录，它是空的就等于部署了个空站'],
      hint: ['看 web/vite.config.js 的输出目录，或者手动跑一次 npm run build 看产物落在哪'],
    });
  }

  /* 5 推变量 + 部署 ----------------------------------------------------- */
  step(5);
  const wrangler = path.join(SERVER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(wrangler)) {
    throw new Stop({
      step: 5,
      headline: 'server 里没有 wrangler',
      detail: ['部署靠它，它是项目的开发依赖'],
      hint: ['cd server && npm install', '（这一步脚本没有替你做，因为部署工具的版本要跟着仓库走）'],
    });
  }
  const wranglerRun = (args, opts = {}) =>
    run(process.execPath, [wrangler, ...args], { cwd: SERVER_DIR, ...opts });

  if (dryRun) {
    say('   --dry-run：只试打包，不上传、不推变量');
    const r = await wranglerRun(['deploy', '--dry-run', '--outdir', path.join(ROOT, '.scratch', 'deploy-dry'), ...deployVarArgs(values)], { echo: true });
    if (r.code !== 0) {
      throw new Stop({
        step: 5,
        headline: '打包没过',
        detail: ['上面是 wrangler 报的错'],
        hint: ['这是纯本地的一步，报错指向代码或配置，不涉及网络'],
      });
    }
    say('');
    say('✓ 打包通过（--dry-run，没有上传）。去掉 --dry-run 就是真的部署。');
    return 0;
  }

  // 机密先推、再部署：部署时脚本要靠这些变量才能跑起来。
  for (const key of plan.secrets) {
    // 值走 stdin——命令行参数会进进程列表和 shell 历史
    const r = await wranglerRun(['secret', 'put', key], { stdin: values[key] });
    if (r.code !== 0) throw wranglerFailureStop(r, `推 ${key} 没成`);
    say(`   ${key}  ✓ 已推（加密，平台不会回读明文）`);
  }
  say(`   ${plan.vars.join(' / ')}  ✓ 跟着部署命令走，不落平台状态`);

  let deploy = await wranglerRun(['deploy', ...deployVarArgs(values)], { echo: true });

  // 账号还没注册 workers.dev 子域时，wrangler 会问「要不要现在注册」，非交互下取 no
  // 然后不等你救它——代码传上去了，却一个地址都拿不到。这个名字全球唯一、只能人选，
  // 所以脚本不替人编，只在他给了 `--subdomain` 时替他注册，再重试一次部署。
  if (deploy.code !== 0 && needsSubdomain(`${deploy.out}\n${deploy.err}`) && subdomain) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(subdomain)) {
      throw new Stop({
        step: 5,
        headline: `--subdomain 给的名字不像话：${subdomain}`,
        detail: ['子域只能是 2~63 位小写字母、数字、横线，且以字母或数字开头'],
        hint: ['像这样重跑：node scripts/deploy.mjs --subdomain 你的名字'],
      });
    }
    say(`   这个账号还没有 workers.dev 子域，先注册成 ${subdomain}（每个账号一次）`);
    const reg = await wranglerRun(['subdomain', subdomain], { echo: true });
    if (reg.code !== 0) throw wranglerFailureStop(reg, `注册子域 ${subdomain} 没成`);
    deploy = await wranglerRun(['deploy', ...deployVarArgs(values)], { echo: true });
  }
  if (deploy.code !== 0) throw wranglerFailureStop(deploy, '部署没成');

  const url = parseWorkersUrl(`${deploy.out}\n${deploy.err}`);
  say('');
  say(url ? `   线上地址  ${url}` : '   （没能从输出里认出线上地址，去控制台看 Worker 的地址）');

  /* 6 确认（Cloudflare → 仓库平台） ------------------------------------- */
  step(6);
  if (!url) {
    // 认不出地址就不算跑完：这一步正是「部署成功」与「线上够得到仓库」的分界，
    // 跳过它然后报成功，等于把一件没验过的事说成验过了
    throw new Stop({
      step: 6,
      headline: '部署命令成功了，但没能从它的输出里认出线上地址',
      detail: ['没有地址就没法确认「线上够不够得到仓库」——这一步不能省'],
      hint: [
        '去控制台 → Workers → 这个 Worker，地址在概览页上',
        '在浏览器里打开那个地址（能看到笔记列表就通了）；或者打开 <地址>/api/head 看有没有 sha',
      ],
    });
  }
  say(`   走的是「Cloudflare → ${providerHost}」——本机自检过了，不等于这条路通`);

  let probe;
  try {
    const resp = await fetch(`${url}/api/head`, {
      headers: {
        'User-Agent': UA,
        ...(values.APP_PASSWORD ? { 'X-Auth': values.APP_PASSWORD } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    probe = classifyRuntime({ status: resp.status, body });
  } catch (e) {
    probe = classifyRuntime({ network: networkText(e) });
  }

  if (probe.ok) {
    say(`   ✓ ${probe.message}`);
    if (head.sha && probe.sha && head.sha !== probe.sha) {
      say(`     （自检时读到的是 ${head.sha.slice(0, 7)}，线上读到的是 ${probe.sha.slice(0, 7)}——这中间有人提交过）`);
    }
    say('');
    say('部署完成。手机打开这个地址：');
    say(`  ${url}`);
    if (values.APP_PASSWORD) say('  会先要一次访问密码，就是配置文件里那个 APP_PASSWORD。');
    return 0;
  }

  // 失败也分三种，说的话不一样——这正是「部署没成功」与「部署成功但连不上仓库」的分界
  if (probe.kind === 'unreachable') {
    throw new Stop({
      step: 6,
      headline: `部署命令成功了，但${probe.message}`,
      detail: ['这说明代码推上去了，你本机却连不上它'],
      hint: [
        '先在浏览器里打开这个地址试试：打得开就是本机网络对 *.workers.dev 不通，应用没问题',
        '刚部署完的地址通常几秒内就生效，隔十几秒再重跑一次也可以',
      ],
    });
  }
  if (probe.kind === 'auth') {
    throw new Stop({
      step: 6,
      headline: probe.message,
      detail: ['线上那个应用的 APP_PASSWORD 与本机配置里的不是同一个'],
      hint: [
        `把线上在用的密码写回 ${CONFIG_REL} 的 APP_PASSWORD，重跑一次——重跑会把线上那个值改掉`,
        '想彻底关掉密码：控制台里删掉这个 secret，或者 cd server && npx wrangler secret delete APP_PASSWORD',
      ],
    });
  }
  if (probe.kind === 'missing-vars') {
    throw new Stop({
      step: 6,
      headline: probe.message,
      detail: ['部署通了，但应用自己说配置没到——变量那一步的结果没落到这个版本上'],
      hint: ['重跑一次；还不行就去控制台看这个 Worker 的 Variables 里少哪一个'],
    });
  }
  throw new Stop({
    step: 6,
    headline: `部署是成功的，但应用连不上仓库`,
    detail: [probe.message, `这条路是「Cloudflare → ${providerHost}」，与开头那次自检不是同一条`],
    hint: [
      '先确认仓库名与令牌在线上真的是这份（控制台 → Workers → 这个 Worker → Settings → Variables）',
      `${PROVIDER_HTTP[values.REPO_PROVIDER].label} 偶尔会拦境外出口，隔几分钟重跑一次；一直不行就当成「这个平台连不上它」来查`,
    ],
  });
}

/** 部署侧（wrangler）失败：按它报的话分三种最常见的卡点，认不出的就原样给最后几行 */
/** 输出里有没有出现「要不要注册 workers.dev 子域」这个问句 */
export function needsSubdomain(text) {
  return /workers\.dev subdomain/i.test(String(text));
}

/**
 * 部署侧（wrangler）失败：认得出就点名，认不出就原样交回最后几行。
 *
 * 这里两次改判的依据都来自**真跑一次**（2026-10-18 用户首次部署撞出来的）：
 * `Authentication failed (status: 400) [code: 9106]` 不是「令牌是假的」，而是
 * **「账号级令牌」调不了用户级的 /memberships 端点**——wrangler 先要问「这个令牌
 * 属于哪个账号」，问不到就一步也走不下去。两种令牌长得很像，但只有用户级的能回答
 * 这个问题；账号级的必须**额外告诉它账号 ID**。把这两件事混成一句「令牌不对」，
 * 人就会一直在同一个地方重建令牌。
 */
export function wranglerFailureStop(r, headline) {
  const text = `${r.err}\n${r.out}`;
  const tail = text.split(/\r?\n/).filter((l) => l.trim()).slice(-8);

  // 也来自真跑一次（2026-10-18 第二次）：账号没注册过 workers.dev 子域，
  // wrangler 会问一句「要不要现在注册」，非交互下取 no 就收工。这件事的现象是
  // 「代码传上去了、却没有地址」，特别容易被读成「部署失败」。
  if (needsSubdomain(text)) {
    return new Stop({
      step: 5,
      headline: `${headline}：这个账号还没有 workers.dev 子域（每个账号只注册一次）`,
      detail: [
        '代码已经传上去了，缺的只是给它一个地址——没有子域，Worker 起来也没有网址',
        '它在等一个人回答「要不要现在注册」，而这个名字全球唯一，得由你选，脚本不编',
      ],
      hint: [
        '加上名字重跑：node scripts/deploy.mjs --subdomain 你的名字（小写字母/数字/横线，注册后就是 名字.workers.dev）',
        '或者先去控制台设一次：Workers & Pages → 右栏 Your subdomain → Change，然后重跑',
        '也可以手动跑：cd server && npx wrangler subdomain 你的名字',
        '控制台明明看得到子域、它却还在问：多半是令牌指向的账号不对——两个账号各有一份 Workers，地址不互通',
        '   那种情况设 CLOUDFLARE_ACCOUNT_ID 指向有子域的那个账号，或者换成那个账号的令牌',
      ],
    });
  }

  // 这一条必须在「令牌不被认」之前，否则会被那句 Authentication failed 抢走
  if (/\/memberships|9106/.test(text)) {
    return new Stop({
      step: 5,
      headline: `${headline}：这个令牌是「账号级」的，wrangler 没法靠它确认该部署到哪个账号`,
      detail: ['它去问 Cloudflare「我是谁、属于哪个账号」（/memberships），账号级令牌回答不了这个问题'],
      hint: [
        '最快的解法是把账号也指定上：setx CLOUDFLARE_ACCOUNT_ID "..."（那串在控制台 Workers 概览页右侧，就是建令牌那页上的 Account ID）',
        '另一条路：换成「用户级」令牌——头像 → My Profile → API Tokens，模板 Edit Cloudflare Workers（不是 Manage Account 那一页）',
        '两个都设好之后，重开终端再跑一次',
      ],
    });
  }

  if (/Authentication (?:error|failed)|not authenticated|10000|Invalid API Token|Unauthorized/i.test(text)) {
    return new Stop({
      step: 5,
      headline: `${headline}：Cloudflare 不认这个令牌`,
      detail: [`用的是 ${DEPLOY_TOKEN_ENV}`],
      hint: [
        '令牌可能建坏了或已被删：去控制台重建一个（模板 Edit Cloudflare Workers）',
        '权限里要有 Workers Scripts : Edit，否则部署这一步一定被拒',
        '用 setx 覆盖那个环境变量，然后重开终端',
      ],
    });
  }

  if (/More than one account|multiple accounts/i.test(text)) {
    return new Stop({
      step: 5,
      headline: `${headline}：这个令牌能进多个账号，wrangler 不知道该用哪个`,
      detail: ['账号 ID 在控制台的 Workers 概览页右侧'],
      hint: ['setx CLOUDFLARE_ACCOUNT_ID "..."，然后重开终端'],
    });
  }

  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|socket hang up|502|503/i.test(text)) {
    return new Stop({
      step: 5,
      headline: `${headline}：没连上 Cloudflare`,
      detail: tail.length ? tail : ['（wrangler 没有打印原因）'],
      hint: ['这项没测出来，多半是网络，重跑一次：node scripts/deploy.mjs'],
    });
  }

  return new Stop({
    step: 5,
    headline: headline,
    detail: tail.length ? tail : ['（wrangler 没有打印原因）'],
    hint: ['上面最后几行就是 wrangler 给的原因；同样的命令手动跑也能复现：cd server && npx wrangler deploy'],
  });
}

function printHelp() {
  say('');
  say('用法：node scripts/deploy.mjs [--dry-run | --create-repo | --subdomain 名字 | --help]');
  say('');
  say('  （不带参数）     读配置 → 自检 → 构建前端 → 推变量 → 部署 → 确认线上');
  say('  --dry-run       只做到「试打包」为止：不推变量、不上传、不确认');
  say('  --create-repo   仓库不存在时，替你在自己账号下建一个私有仓，并放一篇示例笔记');
  say('  --subdomain X   Cloudflare 账号还没注册 workers.dev 子域时，用这个名字注册（每个账号一次）');
  say('  --help          这一屏');
  say('');
  say(`配置只有一处：${CONFIG_REL}（四项：${[...REQUIRED_KEYS, ...OPTIONAL_KEYS].join(' / ')}）`);
  say(`部署令牌只在本机环境变量：${DEPLOY_TOKEN_ENV}`);
}

/* ---------------- 入口 ---------------- */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Stop) {
      printStop(e.info);
      process.exitCode = 1;
    } else {
      bad('');
      bad(`✗ 脚本自己出错了：${e && e.stack ? e.stack : e}`);
      bad('   这不是配置问题，是脚本的缺陷——把上面这段贴到仓库的 issue 里。');
      process.exitCode = 2;
    }
  }
}
