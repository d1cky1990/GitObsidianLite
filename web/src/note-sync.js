// 本地正文副本的后台同步（落 #33，规则定在 #32 的结论里）。
//
// 三件事，各自一段：
//   1. 远端笔记的「路径 → 指纹」地图：从**现存那次全库清单请求**里取，不新增接口。
//      关键事实——`/api/tree/recursive` 的每个节点本来就带着 sha，只是前端解析时丢掉了。
//   2. 增量计划：指纹不同或本地没有 → 取；仓库里已经没有 → 删。
//   3. 执行：一批一批取，**取到一篇存一篇**。所以关页面、关开关、断网，最多只损失
//      「还没取到的那几篇」，没有半成品状态，下次接着来——不需要专门的续传机制。
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
  batchSize = 25,
  // 批与批之间垫一下。**上游会限流**：实测连着取到 600 多篇时开始回 403（一整页 WAF
  // 拦截页，不是接口的错误体），之后连 /api/head 都一起被拦。宁可慢一点备完，也不要
  // 备到一半被整台机器拦在门外——所以节奏由客户端自己拿住，不指望上游宽容。
  //
  // ⚠️ 这个值是**保守的猜测，没实测过**（第一次实测就把出口 IP 撞封了，没法在同一个
  // IP 上再量阈值）。代价是不对称的：慢一点只是首次多花几分钟，快一点是整台机器连不上。
  // 增量（≤一批）时这个间隔根本不生效，所以日常改动感觉不到它。
  batchGapMs = 4000,
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
