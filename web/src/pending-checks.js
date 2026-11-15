// 勾选「先记本机、送到再划掉」（#60）。
//
// 这一层只回答一件事：一篇笔记上还有哪些「勾」没落地。它把旧版 main.js 里那条
// `taskQueue` 的毛病一次改掉——旧队列每笔只揣「点下去之前的正文」和「勾上还是取消」，
// 提交时才去读屏幕上那篇的 path / 正文 / sha；换过篇就等于把甲篇的改动写到乙篇头上、
// 把甲篇的版本号安到乙篇身上（#34 那个假冲突坑的同源）。
//
// 这里的分工：
//   - **纯函数**（mergeIntent / applyLines / lastDone）：按篇聚合意图、把意图序列套回
//     基准正文、按最后一行选提交信息用词。全不碰 DOM 与网络，能整体跑进 node --test。
//   - **薄持久层**（createStore）：只把「路径 / 行号 / 状态 / 那一刻的版本号」写进本机，
//     绝不写正文。那一刻的正文只停在编排层的内存里，供这一次发送用（见下方 createPendingChecks）。
//   - **编排层**（createPendingChecks）：把上面两样接上 readFile / writeFile / 提示条，
//     管好「点下即发、失败留着、切回前台补发、送不到就清掉」。它靠注入依赖，测试里
//     换成假的就能把每条分支走一遍。
//
// 切换一行仍走 tasks.js 的 `toggleTaskInContent`——「只认列表项开头、补当天日期、
// 四态点击落点」这些既有规则一条不另造，本模块只负责「把哪几行按什么顺序再翻一遍」。

import { toggleTaskInContent } from './tasks.js';
import { baseOf, commitMessage } from './file-names.js';

/* ---------- 纯函数：待发记录 ---------- */

/** 本机存储用的键。换 key 等于把老设备上没送到的几笔丢掉，别轻易改。 */
const STORAGE_KEY = 'pendingChecks.v1';

/**
 * 把一条点击意图并入「按篇聚合」的待发记录。
 *
 * 一篇只有一条；同篇再点只在 `lines` 末尾追加一行（保留先后顺序，不去重——同一行连点
 * 两次本就是翻两次，回原样，重放时照着翻回去才对）。基准 `sha` 锁死在第一笔那一刻：
 * 连勾都发生在第一笔落地之前，屏幕上那篇的版本号一直没换，补发的「整篇没变」必须
 * 对着同一个版本号核对。
 *
 * **只取意图字段**：`content`（那一刻的正文）即便被传进来也不进记录——工单判据 10，
 * 本机翻遍只许有路径 / 行号 / 状态 / 版本号，不许有正文。
 *
 * @returns 新的记录对象，不改传入的 `records`。
 */
export function mergeIntent(records, intent) {
  const { path, sha, line, done } = intent;
  const existing = records[path];
  const entry = existing
    ? { path, sha: existing.sha, lines: [...existing.lines, { line, done: !!done }] }
    : { path, sha, lines: [{ line, done: !!done }] };
  return { ...records, [path]: entry };
}

/**
 * 把一串意图按行号依次套到一份基准正文上（补发时用：此刻内存里那份乐观正文已经随
 * 页面重开丢了，只能拿远端最新正文重放）。逐行走 tasks.js 的切换，行号不漂。
 *
 * @returns {{ok: true, content: string} | {ok: false, reason: string}}
 *          `line-gone`＝那一行已经不是任务项行（被删 / 被改）——判「真送不到」。
 */
export function applyLines(content, lines) {
  let cur = String(content);
  for (const { line } of lines) {
    const next = toggleTaskInContent(cur, line);
    if (next === null) return { ok: false, reason: 'line-gone' };
    cur = next;
  }
  return { ok: true, content: cur };
}

/** 合并发送时，提交信息按「最后一行改动的结果」选词（工单第 10 条，不新造词）。 */
export function lastDone(lines) {
  return lines.length ? !!lines[lines.length - 1].done : false;
}

/* ---------- 薄持久层 ---------- */

/**
 * 只认 `{ [path]: { path, sha, lines: [{line, done}] } }` 这一种形状。
 * `save` 显式挑字段再序列化，杜绝任何正文万一混进内存记录后被写进本机。
 * `load` 对脏数据逐条丢弃（坏 JSON、缺字段、非法行号），不让一份坏缓存把界面弄崩。
 */
export function createStore(storage) {
  return {
    load() {
      let raw;
      try { raw = JSON.parse(storage.getItem(STORAGE_KEY) || '{}'); }
      catch (e) { return {}; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out = {};
      for (const [path, rec] of Object.entries(raw)) {
        if (!rec || typeof rec !== 'object') continue;
        if (typeof rec.sha !== 'string' || !Array.isArray(rec.lines)) continue;
        const lines = rec.lines
          .filter((l) => l && Number.isInteger(l.line) && l.line >= 0 && typeof l.done === 'boolean')
          .map((l) => ({ line: l.line, done: l.done }));
        if (!lines.length) continue;
        out[path] = { path, sha: rec.sha, lines };
      }
      return out;
    },
    save(records) {
      const clean = {};
      for (const [path, rec] of Object.entries(records)) {
        clean[path] = {
          path,
          sha: rec.sha,
          lines: rec.lines.map((l) => ({ line: l.line, done: !!l.done })),
        };
      }
      try { storage.setItem(STORAGE_KEY, JSON.stringify(clean)); }
      catch (e) { /* 本机存储写不进去也不能把界面弄坏 */ }
    },
  };
}

/* ---------- 编排层 ---------- */

/**
 * 提示条的粘性门（G-4：送不到的提示不许被后续普通提示顶掉）。
 *
 * main.js 的 `toast()` 在写 `state.message` 之前问一句：当前显示着的那条若是「送不到」
 * （带 sticky），新来的又不是另一条 sticky，就挡下——否则这次失败等于静默了。
 * 做成独立纯函数，这条规矩就能进单测，而不是散在渲染里靠肉眼保证。
 */
export function allowToast(currentAction, incomingAction) {
  const stickyNow = !!(currentAction && currentAction.sticky);
  const incomingSticky = !!(incomingAction && incomingAction.sticky);
  return !(stickyNow && !incomingSticky);
}

const RETRY_MSG = '还没送到，联网后自动再试';

/**
 * 把纯函数与持久层接上外部边界。`deps` 全由 main.js 注入，测试里换成假的即可逐条走分支：
 *   storage / readFile / writeFile / toast / openNote / getScreen / setScreenSha
 *
 * `getScreen()` 返回 `{ view, path, mode }`，就是「屏幕上那篇」的实时状态。模块不主动
 * 监听「换篇」——每条待发记录自带 path，提交永远用它自己的 path；屏幕状态只在三处用到：
 * 跳过正在编辑的那篇、补发落地后只在「正是那篇且阅读态」时同步版本号、判断要不要点名。
 * 这样「换篇判据按屏幕上那篇变了」不用往渲染函数里塞一行代码。
 */
export function createPendingChecks(deps) {
  const { storage, readFile, writeFile, toast, openNote, getScreen, setScreenSha } = deps;
  const store = createStore(storage);

  let records = store.load();            // 持久的意图（无正文）
  const memContent = new Map();          // path → 那一刻乐观切换后的整篇，只在内存，绝不落盘
  const inFlight = new Set();            // 一篇同时只许有一个写在路上
  const deferred = new Set();            // 已判定「可补发」的篇：在线期间不再反复自动发，等 replay
  let retryNotified = false;            // 「还没送到」一波只提示一次

  function persist() { store.save(records); }

  function notifyRetry() {
    if (retryNotified) return;
    retryNotified = true;
    toast(RETRY_MSG);
  }

  /** 真的送不到了：当场清掉那一条，不再反复试，点名 + 打开，且不许被顶掉。 */
  function dropUndeliverable(path) {
    delete records[path];
    memContent.delete(path);
    deferred.delete(path);
    persist();
    toast(`${baseOf(path)}：勾选没保存上，那一行或这篇已经变了`, {
      label: '打开',
      run: () => openNote(path),
      sticky: true,
    });
  }

  /** 送成了：划掉这一条（在途期间又点的新行留着，while 下一轮再发），同步版本号、告知。 */
  function onSent(path, newSha, snapshot, origin) {
    const entry = records[path];
    const added = entry.lines.length - snapshot.length; // await 期间又点了几下
    if (added > 0) {
      entry.lines = entry.lines.slice(snapshot.length);
      entry.sha = newSha; // 第一笔落地换了版本号，剩下的行得用新 sha 写，才不会报假冲突
    } else {
      delete records[path];
      memContent.delete(path);
      deferred.delete(path);
    }
    persist();

    const s = getScreen();
    // 只在这篇正开在屏幕上（阅读态）时同步版本号：换过篇就绝不能改到别的篇头上（判据 2/9）
    if (s.view === 'editor' && s.path === path && s.mode === 'read') setScreenSha(newSha);
    // 补发成功一律点名；在线点勾成功时只有「写的不是屏幕上那篇」才点名（F-12）
    const named = origin === 'replay' || s.path !== path;
    toast(named ? `已保存 · ${baseOf(path)}` : '已保存');
    retryNotified = false;
  }

  /**
   * 决定这次写什么内容。
   *   - 在线点击（origin='click'）：那一刻乐观切换后的整篇就在内存里，直接写，不多发一次读。
   *   - 补发（origin='replay'）：内存那份已随页面重开丢了，必须重新拿最新正文——**整篇
   *     版本号没变**才把那几行套上去；变了就判「送不到」，绝不盲写。
   */
  async function buildContent(path, entry, snapshot, origin) {
    if (origin === 'click' && memContent.has(path)) {
      return { kind: 'ready', content: memContent.get(path) };
    }
    let fresh;
    try { fresh = await readFile(path); }
    catch (e) {
      if (e && e.notFound) return { kind: 'undeliverable', reason: 'gone' };
      return { kind: 'retry' }; // 断网/问不到，就别猜，留着下次补发
    }
    if (!fresh || fresh.sha !== entry.sha) return { kind: 'undeliverable', reason: 'changed' };
    const applied = applyLines(fresh.content, snapshot);
    if (!applied.ok) return { kind: 'undeliverable', reason: applied.reason };
    return { kind: 'ready', content: applied.content };
  }

  /** 一篇的一次尝试：一次写出、一次核对。返回 true 表示这条可以（可能还有新行）继续。 */
  async function attempt(path, origin) {
    const entry = records[path];
    if (!entry) return false;
    const snapshot = entry.lines.slice();
    const built = await buildContent(path, entry, snapshot, origin);
    if (built.kind === 'undeliverable') { dropUndeliverable(path); return false; }
    if (built.kind === 'retry') { deferred.add(path); notifyRetry(); return false; }
    try {
      const r = await writeFile(
        path, built.content, entry.sha,
        commitMessage.check(path, lastDone(snapshot)), // 按最后一行改动的结果选词
      );
      onSent(path, r.sha, snapshot, origin);
      return true;
    } catch (e) {
      // sha 核对不过（整篇被改过）/ 那篇不见了：补发再多次也没用，判送不到
      if (e && (e.conflict || e.notFound)) { dropUndeliverable(path); return false; }
      // 其余（断网、连不上）：可补发，留着，提示一次
      deferred.add(path); notifyRetry(); return false;
    }
  }

  /** 一篇串起来发：成功后若期间又点了新行，while 下一轮用新 sha 再落地。 */
  async function flushPath(path, origin) {
    if (inFlight.has(path)) return; // 该篇已有写在路上，交给那一轮的 while 捡新行
    inFlight.add(path);
    try {
      while (records[path]) {
        const ok = await attempt(path, origin);
        if (!ok) break; // 失败（可补发 / 送不到）就停，记录留着或已清掉
      }
    } finally {
      inFlight.delete(path);
    }
  }

  /** 点勾：先记本机（只记意图），再立刻发一次。返回 Promise 便于测试等待，界面不 await。 */
  async function record(intent) {
    records = mergeIntent(records, intent);
    memContent.set(intent.path, intent.content); // 那一刻的正文只进内存，供这一次发送
    persist();
    if (!deferred.has(intent.path)) return flushPath(intent.path, 'click');
  }

  /** 应用启动 / 切回前台跑一次：逐篇补发，跳过此刻正在编辑的那一篇。 */
  async function replay() {
    deferred.clear();
    retryNotified = false;
    const jobs = [];
    for (const path of Object.keys(records)) {
      const s = getScreen();
      if (s.view === 'editor' && s.path === path && (s.mode === 'edit' || s.mode === 'conflict')) continue;
      jobs.push(flushPath(path, 'replay'));
    }
    await Promise.all(jobs);
  }

  return { record, replay };
}
