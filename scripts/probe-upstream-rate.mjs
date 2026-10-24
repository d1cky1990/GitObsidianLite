#!/usr/bin/env node
// 上游限流探测（#38）：按**生产形态**逐篇取 git/blobs，看这台机器的出口 IP 能连取多少篇
// 才开始回 403、以及封上以后多久自己解除。
//
// 为什么要它：`web/src/note-sync.js` 的 `batchGapMs` 当初是猜的（第一次实测就把出口 IP
// 撞封了，没能在同一个 IP 上继续量）。#38 要求这个数必须实测。**测完就停、别为了量阈值
// 再撞一遍**——所以本脚本的规矩是：撞到第一次 403 立刻收手，只量「撞上之后多久恢复」，
// 不在同一趟里接着加压。
//
// 用法（令牌从 `server/.dev.vars` 读，不进命令行、不进仓库）：
//
//   node scripts/probe-upstream-rate.mjs --limit 5          # 冒烟：只取 5 篇，确认能跑通
//   node scripts/probe-upstream-rate.mjs                    # 按生产节奏跑完全库（篇数每次现数）
//   node scripts/probe-upstream-rate.mjs --gap 8000         # 换一个批间隔再测
//   node scripts/probe-upstream-rate.mjs --ramp             # **加压**：逐档抬速率，量撞墙点
//
// 两种模式：
//   - **默认（按生产形态）**：一批 20、批内并发 6、批与批间隔 `--gap`。它回答「照这个节奏
//     备完全库会不会撞墙」。撞上就停，只量恢复时间。
//   - **`--ramp`（加压）**：把「每分钟多少个请求」一档一档往上抬（`--ladder 60,120,...`，
//     每档 `--stage-seconds` 秒），回答「这台机器的出口 IP 到底撑到多少才开始拦」。
//     **它一定会撞墙**——这正是它的用途，代价是这个出口 IP 会有约 20 分钟连不上 Gitee。
//     跑之前确认这台机器上没有别的活依赖它。
//
// 参数：--batch（一批几篇，默认 20，与 `MAX_BLOB_BATCH` 一致）、--concurrency（批内并发，
// 默认 6，与 `BLOB_CONCURRENCY` 一致）、--gap（批间隔毫秒，默认 4000）、--limit（最多取
// 几篇，0 = 全库）、--max-requests（总请求上限，兜底用）。
//
// 成绩单写到 `.scratch/upstream-rate-<时间>.md`（`.scratch/` 被 git 忽略）。**它不进仓库**：
// 里面的数字会随笔记库增长与出口 IP 变化而过期，长期有效的那一条应当回写到
// `docs/design/obsidian-mobile-web/spec.md` 与相关注释里。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VARS_FILE = join(ROOT, 'server', '.dev.vars');
const OUT_DIR = join(ROOT, '.scratch');
const BASE = 'https://gitee.com/api/v5';

// 撞墙之后的探测节奏：每分钟轻探一次，最多等 40 分钟。实测过一次约 20 分钟解除，
// 这里留出余量；探针本身只发 1 个请求/分钟，不会把封禁续期。
const RECOVERY_POLL_MS = 60_000;
const RECOVERY_MAX_MS = 40 * 60_000;

/* ---------- 参数 ---------- */

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const num = (name, dflt) => {
  const v = opt(name, null);
  if (v === null || v === true) return dflt;   // 没给、或给了参数名没给值
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

const BATCH = Math.max(1, num('batch', 20));
const CONCURRENCY = Math.max(1, num('concurrency', 6));
const GAP = num('gap', 4000);
const LIMIT = num('limit', 0) || Infinity;
const MAX_REQUESTS = num('max-requests', 0) || Infinity;

// 加压模式：逐档往上抬「每分钟多少个请求」，撞到 403 就停。默认档位 60 → 960。
const RAMP = opt('ramp', false) === true;
const STAGE_SECONDS = Math.max(5, num('stage-seconds', 60));
const LADDER = String(opt('ladder', '60,120,240,480,960'))
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

/* ---------- 小工具 ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = () => new Date();
const stamp = (d = now()) =>
  (d instanceof Date ? d : new Date(d)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** `.dev.vars` 是 `KEY = value`（等号两侧可能有空格），也认 `KEY=value` 与引号 */
function parseVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/** 出口 IP 只记前三段——够判断「换没换出口」，又不至于把完整地址写进文件 */
async function exitIpMasked() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    const { ip } = await r.json();
    const parts = String(ip).split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : '(v6)';
  } catch {
    return '(取不到)';
  }
}

/* ---------- 请求 ---------- */

let token = '';
const counts = { req: 0, ok: 0, blocked: 0, failed: 0 };

function say(s) {
  process.stdout.write(s + '\n');
}

/** 上游到底是不是「被拦了」——状态码看不出来，得看响应体是不是一整页 HTML（WAF） */
function classify(status, body) {
  const isHtml = typeof body === 'string' && /^\s*</.test(body);
  if (status === 403 || status === 429) return { kind: 'blocked', isHtml };
  if (status >= 200 && status < 300) return { kind: 'ok', isHtml };
  return { kind: 'error', isHtml };
}

/**
 * 发一个请求。**不打印 URL**（里面带令牌）。
 * @returns {Promise<{kind:'ok'|'blocked'|'error', status:number, ms:number, body:any, text:string}>}
 */
async function hit(path, { timeout = 30000 } = {}) {
  counts.req += 1;
  const t0 = Date.now();
  let status = 0;
  let text = '';
  try {
    // 与生产一致：令牌走 query（服务端就是这么调的）
    const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    status = r.status;
    text = await r.text();
  } catch (e) {
    const ms = Date.now() - t0;
    counts.failed += 1;
    return { kind: 'error', status: 0, ms, body: null, text: '网络层失败：' + (e.message || String(e)) };
  }
  const ms = Date.now() - t0;
  const { kind, isHtml } = classify(status, text);
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML 或空 */ }
  if (kind === 'ok') counts.ok += 1;
  else if (kind === 'blocked') counts.blocked += 1;
  else counts.failed += 1;
  return { kind, status, ms, body, text, isHtml };
}

/* ---------- 主流程 ---------- */

/** 读配置、验令牌、拿整棵树。两种模式共用这一段。 */
async function prepare() {
  const vars = parseVars(await readFile(VARS_FILE, 'utf8'));
  const { REPO_PROVIDER, REPO_TOKEN, REPO_OWNER, REPO_REPO } = vars;
  // 这把尺子只量过 Gitee 的 WAF（#38）。GitHub 侧的限流是另一套、没量过——
  // 拿它去测 GitHub 会测出一个不是 GitHub 的数字，比没有更糟。
  if (REPO_PROVIDER && REPO_PROVIDER !== 'gitee') {
    console.error(`这份探针只量过 Gitee 的限流，现在配置连的是 ${REPO_PROVIDER}。要量它就另外写一把尺子。`);
    process.exit(2);
  }
  const missing = [
    ['REPO_TOKEN', REPO_TOKEN], ['REPO_OWNER', REPO_OWNER], ['REPO_REPO', REPO_REPO],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`server/.dev.vars 里缺 ${missing.join(' / ')}，没法测。`);
    process.exit(2);
  }
  token = REPO_TOKEN;
  const repo = `/repos/${REPO_OWNER}/${REPO_REPO}`;

  const ip = await exitIpMasked();
  say(`出口 IP（遮蔽）：${ip}`);

  // 预热：4 个请求拿到整棵树。这一步也顺便验证令牌对不对（错了就别往下撞）
  const t0 = Date.now();
  const repoInfo = await hit(repo);
  if (repoInfo.kind !== 'ok') {
    console.error(`第一个请求就没过（HTTP ${repoInfo.status}）：${repoInfo.text.slice(0, 200)}`);
    process.exit(2);
  }
  const branch = (repoInfo.body && repoInfo.body.default_branch) || 'master';
  const b = await hit(`${repo}/branches/${encodeURIComponent(branch)}`);
  if (b.kind !== 'ok') {
    console.error(`拿分支失败（HTTP ${b.status}）`);
    process.exit(2);
  }
  const headSha = b.body && b.body.commit && b.body.commit.sha;
  let treeSha = headSha;
  const c = await hit(`${repo}/commits/${headSha}`);
  if (c.kind === 'ok' && c.body && c.body.commit && c.body.commit.tree) treeSha = c.body.commit.tree.sha;
  const t = await hit(`${repo}/git/trees/${treeSha}?recursive=1`);
  if (t.kind !== 'ok' || !t.body || !Array.isArray(t.body.tree)) {
    console.error(`拿整棵树失败（HTTP ${t.status}）`);
    process.exit(2);
  }
  const notes = t.body.tree.filter((n) => n && n.type === 'blob' && /\.md$/i.test(n.path || ''));
  say(`清单：${t.body.tree.length} 个文件，其中 .md ${notes.length} 篇（预热 ${Date.now() - t0}ms，${counts.req} 个请求）`);
  return { repo, notes, ip };
}

/** 撞墙之后量恢复：每分钟轻探一次，直到回 200 或等够了 */
async function waitRecovery(repo, probeSha) {
  say(`从这里开始每分钟轻探一次（1 个请求），等它自己解除……`);
  const blockWall = Date.now();
  while (Date.now() - blockWall < RECOVERY_MAX_MS) {
    await sleep(RECOVERY_POLL_MS);
    const r = await hit(`${repo}/git/blobs/${encodeURIComponent(probeSha)}`);
    const waited = Math.round((Date.now() - blockWall) / 1000);
    if (r.kind === 'ok') {
      say(`  ${waited}s 后恢复（HTTP ${r.status}）`);
      return { seconds: waited, at: now() };
    }
    say(`  ${waited}s 仍未恢复（HTTP ${r.status}）`);
  }
  say(`  等了 ${RECOVERY_MAX_MS / 60000} 分钟仍未恢复，放弃等待。`);
  return null;
}

async function writeReport(lines, wall) {
  const reportPath = join(OUT_DIR, `upstream-rate-${wall.toISOString().replace(/[:.]/g, '-')}.md`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
  process.stdout.write(`\n成绩单写到：${reportPath}\n`);
}

/**
 * 加压模式：把「每分钟多少个请求」一档一档往上抬，撞到第一次 403 就收手。
 *
 * 为什么按「每分钟多少个」加压，而不是「一共发了多少个」：上游那边是按出口 IP 的速率
 * 掐的（2026-10-02 那次是猛冲，几十秒内发了 600 多个），而我们的生产节奏是匀速的
 * （一批 20、间隔 4 秒）。两个轴不同，能对打到生产上的是「速率」。
 *
 * 每档都从池子里轮着取 sha——同一篇反复取，撞的是「请求太密」，与取的是哪一篇无关；
 * 轮着用只是别让它被当成缓存命中（真被缓存了，量的就不是上游了）。
 */
async function rampMain() {
  const { repo, notes, ip } = await prepare();
  const pool = notes.filter((n) => n && n.sha).slice(0, Math.min(200, notes.length));
  if (!pool.length) {
    console.error('仓库里没有可取的 blob，没法加压。');
    process.exit(2);
  }
  say(`加压档位：${LADDER.join(' → ')} 次/分钟，每档 ${STAGE_SECONDS}s，批内并发 ${CONCURRENCY}，池子 ${pool.length} 篇`);
  say(`开始：${stamp()}`);

  const stages = [];
  const startedAt = Date.now();
  let blockedAt = null;
  let stop = false;
  let cursor = 0;

  for (const rate of LADDER) {
    if (stop) break;
    const interval = 60000 / rate;
    const stageStart = Date.now();
    let nextAt = stageStart;        // 均匀铺开的节奏：谁先到谁发
    let sSent = 0, sOk = 0, sFail = 0;
    say(`\n档位 ${rate} 次/分钟（每 ${interval.toFixed(0)}ms 一个）…`);

    const worker = async () => {
      while (!stop && Date.now() - stageStart < STAGE_SECONDS * 1000) {
        if (counts.req >= MAX_REQUESTS) { stop = true; break; }
        const now0 = Date.now();
        const wait = Math.max(0, nextAt - now0);
        // 排到的这一格若已经超出本档的截止时间，就别占了——否则几个并发会把
        // 未来好几秒的格子先预订掉，低速率档会被拖长（实测过一次：5 秒的档跑了 16 秒）
        if (now0 + wait - stageStart >= STAGE_SECONDS * 1000) break;
        nextAt = Math.max(now0, nextAt) + interval;
        if (wait) await sleep(wait);
        if (stop) break;
        const f = pool[cursor++ % pool.length];
        sSent += 1;
        const r = await hit(`${repo}/git/blobs/${encodeURIComponent(f.sha)}`);
        if (r.kind === 'ok') { sOk += 1; continue; }
        if (r.kind === 'blocked') {
          stop = true;
          // 同一档里有几个在飞：只记第一个撞上的
          if (!blockedAt) {
            blockedAt = {
              at: now(), elapsed: Date.now() - startedAt, nth: counts.req,
              rate, stageSent: sSent, isHtml: r.isHtml,
            };
          }
          return;
        }
        sFail += 1;
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, 64) }, worker));
    stages.push({ rate, sent: sSent, ok: sOk, fail: sFail, ms: Date.now() - stageStart });
    say(`  发出 ${sSent} 个：成功 ${sOk}、失败 ${sFail}`);
    if (blockedAt && blockedAt.rate === rate) break;
  }

  const elapsedMs = Date.now() - startedAt;
  let recovered = null;
  if (blockedAt) {
    say('');
    say(`⚠ 撞墙：${blockedAt.rate} 次/分钟这一档、该档发出第 ${blockedAt.stageSent} 个时被拦` +
      `（回的是${blockedAt.isHtml ? '一整页 HTML，像 WAF 拦截页' : '错误体，不像 WAF'}）。`);
    recovered = await waitRecovery(repo, pool[0].sha);
  }

  /* ---------- 成绩单 ---------- */

  const wall = now();
  const lines = [];
  const P = (s) => { lines.push(s); process.stdout.write(s + '\n'); };
  const topRate = stages.length ? stages[stages.length - 1].rate : 0;

  P('');
  P('## 上游限流加压实测（#38 · ramp）');
  P('');
  P(`- 时间：${stamp(startedAt)} → ${stamp(wall)}`);
  P(`- 出口 IP（遮蔽）：${ip}`);
  P(`- 档位：${LADDER.join(' → ')} 次/分钟，每档 ${STAGE_SECONDS}s，批内并发 ${CONCURRENCY}`);
  P('');
  if (blockedAt) {
    P(`- **开始被拦的档位：${blockedAt.rate} 次/分钟**（这一档发出第 ${blockedAt.stageSent} 个时撞上）`);
    P(`- 累计：从开跑算，${elapsedMs / 1000 < 1 ? '不到 1' : (blockedAt.elapsed / 1000).toFixed(1)}s 内发出了 ${blockedAt.nth} 个请求（含预热）`);
    P(`- 拦截形态：${blockedAt.isHtml ? '一整页 HTML（WAF 拦截页），不是接口错误体' : '错误体（不是 HTML）'}`);
    P(`- 恢复：${recovered ? '约 ' + (recovered.seconds / 60).toFixed(1) + ' 分钟后（' + recovered.seconds + 's）' : '未在 ' + RECOVERY_MAX_MS / 60000 + ' 分钟内恢复'}`);
    const safeRate = blockedAt.rate === LADDER[0] ? 0 : LADDER[Math.max(0, LADDER.indexOf(blockedAt.rate) - 1)];
    P(`- 也就是说：**${safeRate} 次/分钟这一档是撑得住的**（整档跑完没触发），${blockedAt.rate} 会触发`);
  } else {
    P(`- 结果：**跑完 ${LADDER.length} 档，零 403**（最高撑到 ${topRate} 次/分钟）`);
    P(`- 累计：${(elapsedMs / 1000).toFixed(1)}s，${counts.req} 个请求`);
  }
  P(`- 请求合计：${counts.req} 个（成功 ${counts.ok}、被拦 ${counts.blocked}、其它失败 ${counts.failed}）`);
  P('');
  P('各档位：');
  P('');
  P('| 计划速率 | 发出 | 成功 | 失败 | 用时 |');
  P('|---|---|---|---|---|');
  for (const s of stages) P(`| ${s.rate} 次/分钟 | ${s.sent} | ${s.ok} | ${s.fail} | ${(s.ms / 1000).toFixed(1)}s |`);

  await writeReport(lines, wall);
}

async function main() {
  if (RAMP) return rampMain();
  const { repo, notes, ip } = await prepare();
  say(`开始：${stamp()}`);
  say(`节奏：一批 ${BATCH} 篇、批内并发 ${CONCURRENCY}、批间隔 ${GAP}ms、上限 ${LIMIT === Infinity ? '全库' : LIMIT + ' 篇'}`);

  const todo = notes.slice(0, LIMIT === Infinity ? notes.length : Math.min(LIMIT, notes.length));
  say(`这一趟取 ${todo.length} 篇`);

  let blockedAt = null;      // {申请序号, 路径, 时间, 已取到几篇, 已发几个请求}
  let stop = false;
  const batches = [];        // {i, 篇数, ms, 成功, 失败}
  const startedAt = Date.now();
  let done = 0;
  let failedList = [];

  for (let i = 0; i < todo.length; i += BATCH) {
    if (stop) break;   // 撞墙/到上限：这一批不再开始，后面的也不再开始
    if (i > 0 && GAP) await sleep(GAP);
    const batch = todo.slice(i, i + BATCH);
    let cursor = 0;
    let okN = 0, failN = 0;
    const bt0 = Date.now();

    const worker = async () => {
      while (!stop && cursor < batch.length) {
        if (counts.req >= MAX_REQUESTS) { stop = true; break; }
        const f = batch[cursor++];
        const r = await hit(`${repo}/git/blobs/${encodeURIComponent(f.sha)}`);
        if (r.kind === 'ok') { okN += 1; done += 1; continue; }
        if (r.kind === 'blocked') {
          // 撞到就停：这一批剩下的、后面所有批都不再发。
          // 同一批里有几个在飞：**只记第一个撞上的那个**，别让后到的把位置改了。
          stop = true;
          if (!blockedAt) {
            blockedAt = {
              at: now(), elapsed: Date.now() - startedAt, path: f.path,
              nth: counts.req, done, isHtml: r.isHtml,
            };
          }
          return;
        }
        failN += 1;
        failedList.push({ path: f.path, status: r.status, text: r.text.slice(0, 120) });
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    batches.push({ i: i / BATCH + 1, n: batch.length, ms: Date.now() - bt0, ok: okN, fail: failN });

    const pct = ((Math.min(i + BATCH, todo.length) / todo.length) * 100).toFixed(0);
    say(`  第 ${batches.length} 批：${okN}/${batch.length} 篇到手，${Date.now() - bt0}ms（累计 ${done} 篇，${pct}%）`);
    // 撞了墙就回到循环顶上 break——那里也管着「别再开下一批」
  }

  const elapsedMs = Date.now() - startedAt;

  // 撞墙了：量恢复
  let recovered = null;
  if (blockedAt) {
    say('');
    say(`⚠ 撞墙：第 ${blockedAt.nth} 个请求（第 ${blockedAt.done + 1} 篇，${blockedAt.path}）被拦` +
      `（回的是${blockedAt.isHtml ? '一整页 HTML，像 WAF 拦截页' : '错误体，不像 WAF'}）。`);
    recovered = await waitRecovery(repo, todo[Math.min(blockedAt.done, todo.length - 1)].sha);
  }

  /* ---------- 成绩单 ---------- */

  const wall = now();
  const survived = blockedAt ? blockedAt.nth - 1 : counts.req;
  const rate = elapsedMs > 0 ? (counts.req / (elapsedMs / 60000)) : 0;
  const lines = [];
  const P = (s) => { lines.push(s); process.stdout.write(s + '\n'); };

  P('');
  P('## 上游限流实测（#38）');
  P('');
  P(`- 时间：${stamp(startedAt)} → ${stamp(wall)}`);
  P(`- 出口 IP（遮蔽）：${ip}`);
  P(`- 节奏：一批 ${BATCH} 篇、批内并发 ${CONCURRENCY}、批间隔 ${GAP}ms`);
  P(`- 目标：${todo.length} 篇（全库 .md 共 ${notes.length} 篇）`);
  P('');
  P(`- 结果：**${blockedAt ? '撞上 403' : '跑完，零 403'}**`);
  P(`- 到手的篇数：${done} / ${todo.length}`);
  P(`- 发出的请求：${counts.req} 个（成功 ${counts.ok}、被拦 ${counts.blocked}、其它失败 ${counts.failed}）`);
  P(`- 总耗时：${(elapsedMs / 1000).toFixed(1)}s（有效 ${rate.toFixed(1)} 请求/分钟，约 ${(rate / 60).toFixed(2)} 请求/秒）`);
  if (done > 0) {
    const perNote = elapsedMs / done;
    P(`- 每篇平均：${perNote.toFixed(0)}ms（照这个速度，全库 ${notes.length} 篇需约 ${((perNote * notes.length) / 60000).toFixed(1)} 分钟）`);
  }
  if (blockedAt) {
    P(`- 撞墙位置：第 ${blockedAt.nth} 个请求 / 第 ${blockedAt.done + 1} 篇 / 开跑后 ${(blockedAt.elapsed / 1000).toFixed(1)}s`);
    P(`- 从撞墙到恢复：${recovered ? recovered.seconds + 's（约 ' + (recovered.seconds / 60).toFixed(1) + ' 分钟）' : '未在 ' + RECOVERY_MAX_MS / 60000 + ' 分钟内恢复'}`);
    P(`- 也就是说：这台机器的出口 IP 在「${(blockedAt.elapsed / 1000).toFixed(0)}s 内 ${survived} 个请求」这一档上会触发拦截`);
  }
  if (failedList.length) {
    P('');
    P('其它失败（不是 403，逐条列出来）：');
    for (const f of failedList.slice(0, 20)) P(`- ${f.path}：HTTP ${f.status} ${f.text.replace(/\s+/g, ' ')}`);
    if (failedList.length > 20) P(`- …另有 ${failedList.length - 20} 条`);
  }
  P('');
  P('各批耗时：');
  P('');
  P('| 批 | 篇数 | 到手 | 失败 | 耗时 |');
  P('|---|---|---|---|---|');
  for (const b2 of batches) P(`| ${b2.i} | ${b2.n} | ${b2.ok} | ${b2.fail} | ${b2.ms}ms |`);

  await writeReport(lines, wall);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
