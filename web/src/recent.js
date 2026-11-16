// 「最近打开」：只记路径的本机记录 + 失效预先核对（#64）。
//
// 这个模块不碰 DOM、不发真请求、不读正文。记下来的只有一串路径（工单 #64 第 2 条）：
// 不记内容指纹，所以搬走的笔记不追；不按时间过期；本机会丢，但界面上不交代。
// 失效核对的三档与「同一批路径一分钟内不重复」都做成可注入依赖的纯规则，
// 真请求由 main.js 注入 probe（复用 GET /api/file?path= 的 404）。

export const RECENT_KEY = 'gitobsidianlite.recent.v1';
export const VERIFY_KEY = 'gitobsidianlite.recent.verify.v1';
export const MAX_RECENT = 5;
export const VERIFY_TTL_MS = 60_000; // 同一批路径一分钟内不重复核对

function resolveStore(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (e) { return null; }
}

/** 只留非空字符串路径、去重、截断到 5 条——所有进出存储的数组都过这一道。 */
function dedupe(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths || []) {
    if (typeof p !== 'string' || !p.trim()) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

/** 每次成功打开就置顶、去重、截断。不按时间过期（没有时间参数）。 */
export function addRecent(paths, path) {
  if (typeof path !== 'string' || !path.trim()) return dedupe(paths);
  return dedupe([path, ...(paths || [])]);
}

/** 应用内删掉正在读的那篇 → 那条去掉。 */
export function removeRecent(paths, path) {
  return dedupe((paths || []).filter((p) => p !== path));
}

/**
 * 改名 / 移动 → 直接换成新路径，保留原来的位置。
 * 新路径若已在列表里，去重后只留靠前那一条；from 不在列表里（搬走的）不追。
 */
export function replaceRecentPath(paths, from, to) {
  if (!from || !to || from === to || !(paths || []).includes(from)) return dedupe(paths);
  return dedupe((paths || []).map((p) => (p === from ? to : p)));
}

/** 一条要能认出是哪一篇：名字 + 一行浅色父目录（905 篇里有 112 组同名）。 */
export function recentEntry(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  const name = parts.pop() || String(path || '');
  return { name, parent: parts.join('/') || '根目录' };
}

/* ---------- 本机存储：坏值一律当没有 ---------- */

export function readRecent(storage) {
  const store = resolveStore(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? dedupe(data) : [];
  } catch (e) { return []; }
}

export function writeRecent(paths, storage) {
  const store = resolveStore(storage);
  if (!store) return;
  try { store.setItem(RECENT_KEY, JSON.stringify(dedupe(paths))); }
  catch (e) { /* 配额满 / 隐私模式：忽略，不让它变成一次报错 */ }
}

function readRecord(store, key, valid) {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return valid(data) ? data : null;
  } catch (e) { return null; }
}

export function readVerifyRecord(storage) {
  return readRecord(resolveStore(storage), VERIFY_KEY,
    (d) => d && typeof d.key === 'string' && typeof d.at === 'number');
}

export function writeVerifyRecord(record, storage) {
  const store = resolveStore(storage);
  if (!store) return;
  try { store.setItem(VERIFY_KEY, JSON.stringify(record)); }
  catch (e) { /* 忽略 */ }
}

/* ---------- 失效预先核对 ---------- */

/** 一批路径的签名。排序后拼接：置顶换了顺序仍算同一批，换了一条内容才算新一批。 */
export function verifySignature(paths) {
  return [...(paths || [])].sort().join('\u0000');
}

/** 同一批路径一分钟内不重复核对；空列表不必核对。 */
export function shouldVerify(paths, record, now) {
  const list = paths || [];
  if (!list.length) return false;
  if (!record || record.key !== verifySignature(list)) return true;
  return now - record.at >= VERIFY_TTL_MS;
}

/**
 * 一次询问的结论三档，互不冒充：
 *   probe 没抛错 → 在；确凿的 404 / notFound → 真不在；
 *   其余（断网、5xx、要密码）→ 问不到，绝不当成「不在了」。
 */
export function classifyProbe(err) {
  if (!err) return 'exists';
  if (err.notFound === true || err.status === 404) return 'missing';
  return 'unknown';
}

/**
 * 把一批结论落成要标「已失效」的路径。
 * 只要有一条问不到，整批结论就不可信 —— 返回 null 表示「保持不变」，
 * 不标失效、不弹提示（工单 #64 第 3 条 / 判据 3）。
 */
export function applyVerification(results) {
  if (results.some((r) => r.kind === 'unknown')) return null;
  return results.filter((r) => r.kind === 'missing').map((r) => r.path);
}

/**
 * 空状态出现那一刻的核对编排：5 条并行各问一次，一分钟内同批不重复。
 * 全部依赖注入，便于单测；真请求由调用方给 probe。
 *
 * @returns {Promise<{ran:boolean, invalid:string[]|null, unknownBatch:boolean}>}
 *   ran=false 表示这一分钟里刚问过、这次没发请求；invalid=null 表示整批结论不可信。
 */
export async function checkRecents(paths, { probe, now, storage } = {}) {
  const list = dedupe(paths);
  const at = typeof now === 'function' ? now() : (typeof now === 'number' ? now : Date.now());
  const store = resolveStore(storage);
  if (!shouldVerify(list, readVerifyRecord(store), at)) {
    return { ran: false, invalid: null, unknownBatch: false };
  }
  const ask = typeof probe === 'function' ? probe : async () => ({ status: 0, message: 'no probe' });
  // 并行：一起来，约一秒一起回，不串行拖成五次。
  const results = await Promise.all(list.map(async (path) => {
    let err;
    try { err = await ask(path); }
    catch (e) { err = e; }
    return { path, kind: classifyProbe(err) };
  }));
  const invalid = applyVerification(results);
  writeVerifyRecord({ key: verifySignature(list), at }, store);
  return {
    ran: true,
    invalid,
    unknownBatch: invalid === null && results.some((r) => r.kind === 'unknown'),
  };
}

/** 点已失效那条：重新问一次（标注只是上一次的结论，不是永久判决）。 */
export async function recheckOne(path, { probe } = {}) {
  const ask = typeof probe === 'function' ? probe : async () => ({ status: 0, message: 'no probe' });
  let err;
  try { err = await ask(path); }
  catch (e) { err = e; }
  return classifyProbe(err);
}
