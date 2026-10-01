// ```tasks 查询块（#15 定稿 → #28 落地）。
//
// 手机端**不执行**查询——那需要先把全库正文搬到手机上（见 #10 的雾区）。所以这里
// 只做一件诚实的事：把它渲染成一句安静的说明，外加可展开的原文。
//
// 三条底线：不执行、不假装执行、不对特定文件特例处理。原文用原生 `<details>` 折叠，
// 不引入脚本——手机上点开/收起是浏览器自带的行为，不需要我们写一行 JS。

/** 说明文案——写在这里，改文案不碰渲染逻辑。 */
export const QUERY_NOTE = '这是 Obsidian 的任务查询，手机端不执行';

/**
 * 把 ```tasks 围栏块换成占位说明。其他语言的代码块原样走既有渲染，不受影响。
 *
 * 信息串只取第一个词来判断（`tasks` 后面可能还跟着别的东西），并且大小写不敏感。
 */
export function installTasksQueryRule(md) {
  const esc = md.utils.escapeHtml;
  const base = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = String(token.info || '').trim().split(/[ \t]+/)[0].toLowerCase();
    if (lang !== 'tasks') return base(tokens, idx, options, env, self);
    return '<details class="tasks-query"><summary>' + esc(QUERY_NOTE) + '</summary>' +
      '<pre><code>' + esc(token.content) + '</code></pre></details>\n';
  };
}
