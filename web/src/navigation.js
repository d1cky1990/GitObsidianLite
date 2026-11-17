// 一屏两栏的「三个词」状态、地址栏与返回语义（#61）。
//
// 这些是纯逻辑：不碰 DOM、不碰 history 对象本身，只给出决策与数据，事件接线在
// layout.js。抽出来是为了让工单第 1/5/6/7 条能有单测钉住（真浏览器验不了的
// 部分，至少逻辑层不许错）。词汇见 GLOSSARY.md。

export const SIDEBAR_BREAKPOINT = 900;

/**
 * 三个词各有唯一真相：
 * - selectedFolder 选中的文件夹（新建落点，与正在读哪篇无关）
 * - openedPath     打开的那篇（右边显示哪篇，地址栏只跟它走）
 * - editingPath    正在编辑的那篇（编辑 / 冲突态里的那篇）
 * 旧代码里一个 state.path 同时当「当前目录」与「当前文件」，才会拼出
 * `某篇.md/新笔记.md`；这里从数据结构上把它拆开。
 */
export function createNavState() {
  return {
    selectedFolder: '',
    openedPath: '',
    editingPath: '',
    sidebarOpen: false,
    placeholderDepth: 0,
    mode: 'read', // read | edit | conflict
  };
}

export function getSelectedFolder(state) { return state.selectedFolder; }
export function setSelectedFolder(state, path) { state.selectedFolder = path || ''; return state.selectedFolder; }
export function getOpenedPath(state) { return state.openedPath; }
export function setOpenedPath(state, path) { state.openedPath = path || ''; return state.openedPath; }
export function getEditingPath(state) { return state.editingPath; }
export function setEditingPath(state, path) { state.editingPath = path || ''; return state.editingPath; }

/** 新建落点只读「选中的文件夹」，绝不读「打开的那篇」。空 = 仓库根。 */
export function createTarget(state) {
  return state.selectedFolder || '';
}

/** 地址栏只记「右边是哪篇」。侧栏开合 / 树展开 / 搜索词 / 设置都不进地址栏。 */
export function noteHref(path) {
  return path ? '#/edit/' + encodeURIComponent(path) : '#/';
}

/** 解析 hash：只认笔记（分享链接）与目录（旧链接）；其余当空状态。 */
export function parseHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h.startsWith('/edit/')) return { kind: 'note', path: decodeURIComponent(h.slice(6)) };
  if (h.startsWith('/dir/')) return { kind: 'dir', path: decodeURIComponent(h.slice(5)) };
  return { kind: 'empty', path: '' };
}

/** 侧栏滑出压一条占位历史：地址栏不变，state 里只放一个标记。 */
export function pushSidebarPlaceholder(state) {
  state.placeholderDepth += 1;
  return { historyState: { sidebarPlaceholder: true }, addressUnchanged: true };
}

/** 三种关法每一条都要吃掉一条占位；没有占位时不凭空退一步。 */
export function popSidebarPlaceholder(state) {
  if (state.placeholderDepth <= 0) return false;
  state.placeholderDepth -= 1;
  return true;
}

/**
 * 返回四层：系统返回 ＝ 界面「‹ 返回」＝ 关掉这篇；侧栏开着先收侧栏；
 * 编辑态退出编辑（有改动先问）；冲突态退回编辑。旧「返回＝回目录」作废。
 */
export function decideBack(state) {
  if (state.sidebarOpen) return 'close-sidebar';
  if (state.mode === 'conflict') return 'conflict-to-edit';
  if (state.mode === 'edit') return 'exit-edit';
  if (state.openedPath) return 'close-note';
  return 'none';
}

/**
 * 链接落地：
 * - 断网 → 「连不上」（不说「找不到」，也不冒充没有）
 * - 分享链接（指向一篇）→ 阅读态、侧栏关着
 * - 旧目录链接 → 那一级不在了就逐级上退（最多四层），并明说
 *   「这个目录不在了，已上退到这里」
 * exists(path) 由调用方注入（一次很轻的「那一层在不在」判定）。
 */
export function resolveLanding({ hash = '', exists = () => true, online = true } = {}) {
  if (online === false) {
    return { kind: 'offline', path: '', message: '连不上', sidebarOpen: false };
  }
  const parsed = parseHash(hash);
  if (parsed.kind === 'note') {
    return { kind: 'note', path: parsed.path, message: '', sidebarOpen: false };
  }
  if (parsed.kind === 'empty') {
    return { kind: 'empty', path: '', message: '', sidebarOpen: false };
  }

  const parts = parsed.path.split('/').filter(Boolean);
  if (parts.length === 0) {
    // 本来就指向仓库根：不算「不在了」，不谎报上退
    return { kind: 'dir', path: '', message: '', sidebarOpen: false };
  }
  let candidate = parts.join('/');
  let retreated = false;
  for (let i = 0; i < 4 && parts.length > 0; i++) {
    if (exists(candidate)) {
      return {
        kind: 'dir', path: candidate,
        message: retreated ? '这个目录不在了，已上退到这里' : '',
        sidebarOpen: false,
      };
    }
    parts.pop();
    candidate = parts.join('/');
    retreated = true;
  }
  // 逐级上退都没找到，落到仓库根，仍把那句话说出来
  return { kind: 'dir', path: '', message: '这个目录不在了，已上退到这里', sidebarOpen: false };
}

/* ---------- 评审修复第 1 条：返回四层真正落地 ---------------------------------
   旧规矩「返回＝回到这篇所在的目录」整条作废（design-brief §7 第 408 行 /
   附录 B 第 513 行）。「关掉这篇」＝右侧回空状态 + 地址栏回根 + 不新增历史。
   纯决策与落地指令在这里（可单测），DOM 接线在 main.js / layout.js。 */

/** 「关掉这篇」后地址栏落点：仓库根。绝不指向 dirOf(path) 那个目录。 */
export const CLOSE_NOTE_HREF = noteHref('');

/**
 * 返回四层的落地指令（供 main.js 的 ui:back 接线用）。
 * 判据是调用方传进来的真实 mode / openedPath / sidebarOpen —— #65 提醒过
 * layout 自己的 navState.mode 未必同步，别拿它的 decision 当真相。
 *  - close-sidebar：侧栏开着先收侧栏，由 layout 的 popstate 自己处理；
 *  - conflict-to-edit / exit-edit：沿用 #65 的 conflictBackToEdit() / exitEdit()；
 *  - close-note：href 恒为 CLOSE_NOTE_HREF（根）。historyOp='replace' 要调用方用
 *    replaceState 把「当前这一条」钉成根：不 push（点完按系统返回不会又打开这篇）、
 *    不 back（系统返回时浏览器已自行回退一条，再叠一次就退两层）。
 */
export function backDirective(state) {
  const decision = decideBack(state);
  return {
    decision,
    href: decision === 'close-note' ? CLOSE_NOTE_HREF : '',
    historyOp: decision === 'close-note' ? 'replace' : 'none',
  };
}
