// 本地正文副本（搜索用）。规则全部定在 #32 的结论里，这里只做实现：
// **只给搜索用、一篇一条、零依赖、默认关、关掉即删**。
//
// 为什么用浏览器自带的 IndexedDB 而不是 localStorage：后者单条上限约 5 MB，且是
// **同步阻塞**的——全库正文约 3.6 MB，塞进去会贴到天花板，最先坏掉的反而会是那份
// 全库名单（另一个键）。两样东西分开存、分开删，生命周期本来也不一样。
//
// 记录形状：{ path, sha, size, content }。`sha` 是这篇的版本身份，增量就靠它比对；
// `size` 是正文的 UTF-8 字节数，在写的时候算一次——「已用 X MB」要它，而每次现算
// 一遍等于把整库重新编码一遍。
//
// 这一层是薄管道，逻辑在 note-sync.js 里（那份有单测）。它自己只在真浏览器里验：
// 打开、写入、游标遍历、清空，全都是浏览器行为，没有纯函数可测。

const DB_NAME = 'gitobsidianlite';
const DB_VERSION = 1;
const STORE = 'notes';

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 游标遍历。`continue()` 必须在 onsuccess 里同步调，事务才不会中途关掉 */
function eachRecord(store, onEach) {
  return new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      onEach(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export function utf8Bytes(s) {
  return new TextEncoder().encode(s || '').length;
}

/**
 * 开一个本地正文库。
 * @param {{idb?: IDBFactory, dbName?: string}} [opts] `idb` 可注入，只给测试用
 */
export function createNoteStore({ idb = globalThis.indexedDB, dbName = DB_NAME } = {}) {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = idb.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'path' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('打不开本地正文库'));
    });
    // 开失败就别把坏掉的 promise 留着——否则之后每一次都直接拿到同一个失败
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  async function run(mode, fn) {
    const d = await open();
    const tx = d.transaction(STORE, mode);
    // 事务的完成回调必须在 fn 之前挂上：fn 里 await 过之后，事务可能已经结束了
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('本地正文库事务中止'));
    });
    const out = await fn(tx.objectStore(STORE));
    await done;
    return out;
  }

  return {
    /** 存一篇（同路径覆盖）。取到一篇就存一篇，所以没有「半成品」这种状态。 */
    async put({ path, sha, content }) {
      const rec = { path, sha, size: utf8Bytes(content), content };
      await run('readwrite', (s) => promisify(s.put(rec)));
    },

    async remove(path) {
      await run('readwrite', (s) => promisify(s.delete(path)));
    },

    async get(path) {
      return run('readonly', (s) => promisify(s.get(path)));
    },

    async count() {
      return run('readonly', (s) => promisify(s.count()));
    },

    /**
     * 一次游标遍历拿到增量要的三样东西：
     * `shas`（路径→指纹，比对用）、`sizes`（路径→字节数，上限扣账用）、`bytes`（已用总量）。
     * 分三次遍历当然也能写，但每一次都要把全库读一遍。
     */
    async index() {
      return run('readonly', async (s) => {
        const shas = new Map(), sizes = new Map();
        let count = 0, bytes = 0;
        await eachRecord(s, (v) => {
          shas.set(v.path, v.sha);
          sizes.set(v.path, v.size || 0);
          count += 1;
          bytes += v.size || 0;
        });
        return { shas, sizes, count, bytes };
      });
    },

    /** 搜索要的：全部原文。约 3.6 MB，在内存里逐篇扫是百毫秒级（#32 §2）。 */
    async allNotes() {
      return run('readonly', async (s) => {
        const out = [];
        await eachRecord(s, (v) => out.push({ path: v.path, content: v.content }));
        return out;
      });
    },

    /** 关掉开关 / 「清空本地正文」都走它。**全库名单不在这库里，一根汗毛都不动。** */
    async clear() {
      await run('readwrite', (s) => promisify(s.clear()));
    },
  };
}
