// 本地正文副本的后台同步（落 #33，规则定在 #32 的结论里）。
//
// 三件事，各自一段：
//   1. 远端笔记的「路径 → 指纹」地图：从**现存那次全库清单请求**里取，不新增接口。
//      关键事实——`/api/tree/recursive` 的每个节点本来就带着 sha，只是前端解析时丢掉了。
//   2. 增量计划：指纹不同或本地没有 → 取；仓库里已经没有 → 删。
//   3. 执行：一批一批取，**取到一篇存一篇**。所以关页面、关开关、断网，最多只损失
//      「还没取到的那几篇」，没有半成品状态，下次接着来——不需要专门的续传机制。
//      批的大小（`batchSize`）影响的就是这句里的「那几篇」：批越小，在飞的一批越少，
//      中断时丢得越少、而轮数越多。2026-10-18（#40）起服务端一批上限从 50 收到 20，
//      这是往「丢得更少」的方向变的，没写反。
//
// 本模块不碰 DOM、不碰 localStorage、不直接发请求：三样都由调用方注入。逻辑（尤其是
// 增量与上限扣账）因此可以在 node 里单测，不用开浏览器。

/** `/api/tree/recursive` 的 tree → 笔记的 路径 → 指纹 地图（只收 `.md`）。 */
export function noteShaMap(tree) {
  const m = new Map();
  for (const n of tree || []) {
    if (!n || n.type !== 'blob' || typeof n.path !== 'string' || !n.path) continue;
    if (!/\.md$/i.test(n.path)) continue;
    if (typeof n.sha === 'string' && n.sha) m.set(n.path, n.sha);
  }
  return m;
}

/**
 * 增量计划。
 * @param {Map<string,string>} remote 远端 路径→指纹
 * @param {Map<string,string>} local  本地 路径→指纹
 * @returns {{fetch:{path:string,sha:string}[], remove:string[]}}
 */
export function planSync(remote, local) {
  const fetch = [], remove = [];
  for (const [path, sha] of remote) if (local.get(path) !== sha) fetch.push({ path, sha });
  for (const path of local.keys()) if (!remote.has(path)) remove.push(path);
  // 按路径序排：结果与遍历顺序无关，出问题时也好对账
  fetch.sort((a, b) => a.path.localeCompare(b.path));
  remove.sort((a, b) => a.path.localeCompare(b.path));
  return { fetch, remove };
}

/**
 * 批与批之间的默认间隔（毫秒）。**这个数有来历，别随手往下调**（#38）。
 *
 * 上游会限流，而且是按出口 IP 的速率掐的：连着取快了就回 403（一整页 WAF 拦截页，不是
 * 接口的错误体），之后连 `/api/head` 一起被拦——那不是「搜索坏了」，是这台机器上跑着的
 * 应用整个用不了。加压实测到的线是「约 600 次/分钟起会被拦」（480 次/分钟跑满一分钟没事，
 * 960 那档三十九秒就被拦），而我们这一档约 188 次/分钟，**只到那条线的三分之一**。
 *
 * 数字与两次实测的时间、条件都住在 `docs/design/obsidian-mobile-web/spec.md` §4，
 * 测法与可重跑的工具是 `scripts/probe-upstream-rate.mjs`——**要改这个数，先去那边跑一遍**。
 *
 * 为什么留着三分之一的余量而不往下压：账是不对称的。快一点省的是首次那几分钟（而且只有
 * 首次，增量时这个间隔根本不生效），快过头换来的是整台机器被拦在门外。被拦多久看撞法：
 * 加压实测那次一分钟就解除了，2026-10-02 那次猛冲是二十分钟。而且验的时候只覆盖了一条
 * 出口，线上经 Workers 出去是另一批 IP，没量过的地方不拿它赌。
 */
export const DEFAULT_BATCH_GAP_MS = 4000;

/**
 * @param {{
 *   store: {index:Function, put:Function, remove:Function},
 *   loadTree: () => Promise<{head?:string, tree:any[]}>,
 *   fetchBlobs: (files:{path:string,sha:string}[]) => Promise<{blobs:{path:string,sha:string,content:string}[], failed:{path:string,error:string}[]}>,
 *   getCapBytes: () => number,
 *   onProgress?: (s:object) => void,
 *   batchSize?: number,
 *   batchGapMs?: number,
 * }} deps
 */
export function createBodySync({
  store, loadTree, fetchBlobs, getCapBytes, onProgress = () => {},
  // 一批几篇。**别超过服务端的 `MAX_BLOB_BATCH`（现在是 20）**——超了服务端直接回
  // 400「一次最多 20 篇」，而现在的错误处理会把它当成「请求没发出去」，整趟同步停住。
  // 那个 20 是 Cloudflare Workers 的「单次调用最多 50 个外发请求」倒推出来的，不是
  // 随便调的（见 `server/src/core.js`）；这里是它的另一半，改一边就得改另一边。
  batchSize = 20,
  batchGapMs = DEFAULT_BATCH_GAP_MS,
}) {
  // 一次同步的可见状态。`total` 是**这一趟**要取的篇数，不是全库篇数——进度那句
  // 「已备 X / 共 Y」用的是它，所以它必须跟这一趟做的事对得上。
  const state = {
    status: 'idle',   // idle | running | done | capped | blocked | error
    done: 0,
    total: 0,
    failed: 0,
    error: '',
  };
  let running = null;

  const report = () => onProgress({ ...state });

  async function run() {
    Object.assign(state, { status: 'running', done: 0, total: 0, failed: 0, error: '' });
    report();

    let t;
    try {
      t = await loadTree();
    } catch (e) {
      Object.assign(state, { status: 'error', error: '没能拿到仓库清单：' + e.message });
      report();
      return;
    }
    const remote = noteShaMap(t && t.tree);

    const local = await store.index();
    const { fetch: todo, remove } = planSync(remote, local.shas);

    // 仓库里已经没有的先删。这一步是纯本地动作，不会失败到需要用户知道
    let used = local.bytes;
    for (const path of remove) {
      await store.remove(path);
      used -= local.sizes.get(path) || 0;
    }

    state.total = todo.length;
    report();
    if (!todo.length) {
      Object.assign(state, { status: 'done' });
      report();
      return;
    }

    const cap = getCapBytes();
    let done = 0, failed = 0;

    for (let i = 0; i < todo.length; i += batchSize) {
      if (i > 0 && batchGapMs) await sleep(batchGapMs);
      const batch = todo.slice(i, i + batchSize);
      let r;
      try {
        r = await fetchBlobs(batch);
      } catch (e) {
        // 请求本身就没发出去（断网、服务端挂了）。停在这一趟——接着一批一批地撞，
        // 是把一次网络故障放大成几十次
        Object.assign(state, { status: 'error', error: e.message || String(e) });
        state.done = done; state.failed = failed + batch.length;
        report();
        return;
      }

      // 整批一篇都没拿到：这不像「某几篇被删了」，像撞上了上游的限制（见上面 batchGapMs）。
      // 停在这一趟，别接着撞——已经到手的都在库里，下次打开从这儿接着来。
      if (!r.blobs.length && (r.failed || []).length) {
        Object.assign(state, {
          status: 'blocked',
          error: (r.failed[0] && r.failed[0].error) || '上游一篇都没给',
        });
        state.done = done; state.failed = failed + r.failed.length;
        report();
        return;
      }

      for (const b of r.blobs) {
        const size = utf8Length(b.content);
        const old = local.sizes.get(b.path) || 0;
        // 上限只拦新增，**绝不回删**：到了就停下并如实说，不替用户删东西腾地方
        if (used - old + size > cap) { state.status = 'capped'; break; }
        await store.put({ path: b.path, sha: b.sha, content: b.content });
        local.sizes.set(b.path, size);
        used = used - old + size;
        done += 1;
        state.done = done;
        report();
      }
      failed += (r.failed || []).length;
      state.failed = failed;
      state.done = done;
      report();
      if (state.status === 'capped') break;
    }

    if (state.status !== 'capped') state.status = 'done';
    report();
  }

  return {
    state,
    get running() { return !!running; },
    /** 同步一趟。已经在跑就直接返回同一个 promise——并发调用不会发两份请求。 */
    sync() {
      if (!running) {
        running = run().catch((e) => {
          Object.assign(state, { status: 'error', error: e.message || String(e) });
          report();
        }).finally(() => { running = null; });
      }
      return running;
    },
    /**
     * 顺风车入口：拿既有那次「仓库最新版本身份」检查的结果决定要不要动。
     * `reused`＝ HEAD 没变（清单是缓存里的），此时本地又已经齐了，就**什么都不做**——
     * 不能每次都去拉一遍全库清单，那一次实测 3~5 秒。
     */
    async consider({ reused, noteCount }) {
      if (reused && noteCount > 0) {
        const have = await store.count().catch(() => 0);
        if (have >= noteCount) return;
      }
      return this.sync();
    },
  };
}

function utf8Length(s) {
  return new TextEncoder().encode(s || '').length;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
