// 一屏两栏的「三个词」状态、地址栏与返回语义（#61）。
//
// 这些是纯逻辑：不碰 DOM、不碰 history 对象本身，只给出决策与数据，事件接线在
// layout.js。抽出来是为了让工单第 1/5/6/7 条能有单测钉住（真浏览器验不了的
// 部分，至少逻辑层不许错）。词汇见 GLOSSARY.md。

// 「编辑 / 冲突态」这条判据只住在 editor-guard.js 一处（#66 的置灰也读它）——
// 这里要用它，就引过来，不另抄一份 isLockedMode。
import { isLockedMode } from './editor-guard.js';

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

/** 地址栏指向的那篇笔记（不是笔记链接就给空串）——几处比「是不是同一篇」都读这一处。 */
function notePathIn(hash) {
  const parsed = parseHash(hash);
  return parsed.kind === 'note' ? parsed.path : '';
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
 *
 * #74：**编辑 / 冲突态里侧栏不算一层**。窄屏这两个态侧栏是锁死的（☰ 换成「退出编辑」），
 * 宽屏它常驻——都不是用户刚拉开的那一层；先「收侧栏」再 return 会把那一问整个吞掉。
 */
export function sidebarCountsAsBackLayer(state = {}) {
  return !!state.sidebarOpen && !isLockedMode(state.mode || 'read');
}

export function decideBack(state) {
  if (sidebarCountsAsBackLayer(state)) return 'close-sidebar';
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

/* ---------- 评审修复第 2 条：旧目录链接落地的接线层判定 ----------------------
   F-13：分享链接落阅读态；旧目录链接那一级不在了就逐级上退；断网说「连不上」。
   F-14：同一个原因四处说法一致，「问不到」不许说成「找不到」、不许冒充「不在了」。
   存在性判定只用内存里那份全库名单（ensureIndex 的 notePaths），
   **不为一个落地判定新增网络请求**；名单没到＝问不到。 */

/**
 * 用内存全库名单判某一级目录在不在：任一笔记路径以 `dir + '/'` 开头即算在。
 *  - 空 dir ＝仓库根，恒为在（不算「不在了」，不谎报上退）；
 *  - notePaths 不是数组（名单还没到 / 拉不到）→ undefined＝「问不到」，
 *    由调用方按 offline 分支说「连不上」，绝不谎报上退。
 */
export function indexDirExists(notePaths, dir) {
  if (!Array.isArray(notePaths)) return undefined;
  if (!dir) return true;
  const prefix = String(dir).replace(/\/+$/, '') + '/';
  return notePaths.some((p) => typeof p === 'string' && p.startsWith(prefix));
}

/**
 * 注入 resolveLanding 的 { online, exists } 判定器（纯函数，接线层可单测）。
 * online＝名单是否到手：没到 / 拉不到＝问不到（resolveLanding 直接给 offline
 * 「连不上」），绝不谎报上退；到手后才用 exists 逐级判「确实不在」。
 */
export function landingProbeFromIndex(notePaths) {
  return {
    online: Array.isArray(notePaths),
    exists: (dir) => indexDirExists(notePaths, dir) === true,
  };
}

/* ---------- #72：站内换了一篇，别当成「用户按了系统返回」 --------------------

   为什么这次 popstate 不是返回、以及这个浏览器的脾气，写在 README「只存在于屏幕上的
   那些行为，怎么验」那条里（一个事实只住一处）；这里只说判定怎么下。

   怎么分辨：**只读地址栏与「打开的那篇」的差**，不读事件里的 state——站内跳转那条
   历史记录没有状态标记，读它一定读成 null。
   编辑 / 冲突态一律不算换篇：那两个态里每一次返回都只退一层，有改动还得先问
   「放弃改动？」。一条 popstate 若被判成换篇就会绕过那一问，草稿悄悄没了。 */

/**
 * 这次 popstate 指向的是不是另一篇笔记（是＝换篇，交给路由去打开）。
 * @param {{openedPath?:string, mode?:'read'|'edit'|'conflict'}} state
 *        openedPath ＝ 正文区现在真的是哪一篇（空＝没打开笔记）；
 *        mode ＝ 现在的态。两个都由接线层注入真实值，别拿 navState 里的镜像当真相。
 * @param {string} hash 地址栏当前 hash
 */
export function isNoteSwitchOnPopstate(state = {}, hash = '') {
  if ((state.mode || 'read') !== 'read') return false;
  const path = notePathIn(hash);
  if (!path) return false;
  return path !== (state.openedPath || '');
}

/* ---------- #74：编辑态的系统返回，得先把退掉的那一步拽回来 ------------------

   病根一句话：**按返回这件事，在弹窗之前就已经做完了**——历史退了一条，程序这时才问
   「放弃改动？」，那个「取消」于是成了空头支票。修法与判定为什么这样下，写在 spec.md
   「地址栏只记右边是哪篇」下面（一个事实只住一处）；这里只留一个必须单测得住的判定。 */

/**
 * 这次 hashchange 是不是「正在编辑的这一篇指回了它自己」。
 *
 * 历史被拽回来之后，浏览器还会把那次退格排队的 hashchange 派发一次；地址栏此时
 * 已经是这篇的编辑地址，若照常走 openFile，编辑器和草稿会被一次「重新打开」冲掉
 * （打开会把 draft 换成文件正文、把态切回阅读）。这一下不算打开，直接跳过。
 * @param {{mode?:string, editingPath?:string}} state editingPath ＝ 正在编辑的那篇
 */
export function isSameEditedNote(state = {}, hash = '') {
  if (!isLockedMode(state.mode)) return false;
  return notePathIn(hash) === (state.editingPath || '') && !!state.editingPath;
}
