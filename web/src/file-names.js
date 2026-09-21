// 文件操作的纯逻辑：名字怎么算、重名怎么判、提交信息怎么写。
//
// 抽成纯函数不是为了好看，是为了能测：这几条规则（补 `.md`、拒路径、判重名、四种提交
// 信息的措辞）正是 #26 验收判据里逐条点名的那几条，而它们全都不碰 DOM。
// 渲染与网络留在 main.js —— 那里没法单测，所以不要把规则也搬进去。

/** 父目录。根下的文件返回 ''。 */
export function dirOf(path) {
  const i = String(path).lastIndexOf('/');
  return i < 0 ? '' : String(path).slice(0, i);
}

/** 文件名（含后缀）。 */
export function baseOf(path) {
  const s = String(path);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/** 拼路径，避免根目录拼出 `/名字` 这种开头带斜杠的东西。 */
export function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

const MD = '.md';
const HAS_EXT_RE = /\.[^./\\]+$/;

/**
 * 校验并规范化「新建 / 重命名」的输入。
 *
 * 只收名字，不收路径——所以任何斜杠都被拒掉，而不是自作聪明地当成目录去用。
 * 没有后缀就补 `.md`；已经有后缀的原样留着（`.png` 之类不该被改成 `.md`）。
 *
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
export function normalizeNewName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: '名字不能空着' };
  if (s.includes('/') || s.includes('\\')) {
    return { ok: false, error: '只填名字就行，放哪儿由当前目录决定' };
  }
  if (s === '.' || s === '..') return { ok: false, error: '这不是个能用的名字' };
  // `笔记.` 这种尾巴上带点的，按「没写后缀」算，不然会拼出 `笔记..md`
  const bare = s.endsWith('.') ? s.slice(0, -1) : s;
  if (!bare) return { ok: false, error: '名字不能空着' };
  const name = HAS_EXT_RE.test(bare) ? bare : bare + MD;
  return { ok: true, name };
}

/**
 * 目标目录里是不是已经有这个名字了。
 *
 * **大小写不敏感**：Gitee 那边（Linux）`Foo.md` 与 `foo.md` 可以并存，但这台电脑上
 * 拉下来就会打架——笔记本身是在 Windows 上本地编辑的，所以这里按同一个名字拦。
 *
 * `except` 用于重命名：改的正是自己时，不该被自己拦下。
 */
export function hasName(entries, name, { except = null } = {}) {
  const target = String(name).toLowerCase();
  return (entries || []).some((e) => {
    const p = e.path || e.name || '';
    if (except && p === except) return false;
    return baseOf(p).toLowerCase() === target;
  });
}

/** 重命名后的新路径：同目录，换名字。 */
export function renameTarget(oldPath, name) {
  return joinPath(dirOf(oldPath), name);
}

/** 移动后的新路径：换目录，名字不动。 */
export function moveTarget(oldPath, targetDir) {
  return joinPath(targetDir, baseOf(oldPath));
}

/** 去掉 `.md` 后的名字，用于重命名弹窗里的预填。非 `.md` 原样返回。 */
export function stemOf(path) {
  const b = baseOf(path);
  return b.toLowerCase().endsWith(MD) ? b.slice(0, -MD.length) : b;
}

/**
 * 提交信息的唯一出处。
 *
 * 格式是「手机端：动词 + 路径」——翻 git 历史时一眼看出这次改动是从手机上下手的，
 * 以及动的是哪一篇。冲突合并与另存副本套同一个前缀，别让同一批操作有两种口吻。
 */
export const commitMessage = {
  create: (p) => `手机端：新建 ${p}`,
  // 撤销删除也是「新建」这个动词——它确实就是重建。括号里的说明是为了日后翻历史时
  // 能看出这不是一次普通新建，但前缀仍然是那四个动词之一，没有另开一种格式。
  undoDelete: (p) => `手机端：新建 ${p}（撤销删除）`,
  edit: (p) => `手机端：编辑 ${p}`,
  remove: (p) => `手机端：删除 ${p}`,
  rename: (from, to) => `手机端：重命名 ${from} → ${to}`,
  move: (from, to) => `手机端：移动 ${from} → ${to}`,
  merge: (p) => `手机端：合并冲突 ${p}`,
  keepLocal: (p) => `手机端：合并冲突 ${p}（保留本地）`,
  copySheet: (p) => `手机端：另存副本 ${p}`,
};
