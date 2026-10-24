// 配置项的名字，只此一份。
//
// 为什么要单独一个文件：**服务端与部署脚本读的是同一份配置**，名字与「旧名 → 新名」的
// 对应关系一旦各写一份，两份必然漂移——而漂移的样子是「应用说缺 A，脚本说缺 B」，
// 谁也不信谁（见 `docs/adr/0002`）。
//
// 不放在 `providers/` 里：它描述的是**配置**，不是某一家的脾气。

/**
 * 应用自己要用的四项。缺一项应用就起不来。
 * `REPO_PROVIDER` **没有默认值**：默认成 gitee 的话，配了 GitHub 令牌却忘写连哪家的
 * 人会拿到一个指向 Gitee、报「令牌无效」的错误——排查方向被带向完全错的地方
 * （见 [#17 §3](https://github.com/d1cky1990/GitObsidianLite/issues/17)）。
 */
export const REQUIRED_ENV = ['REPO_PROVIDER', 'REPO_TOKEN', 'REPO_OWNER', 'REPO_REPO'];

/** 可选：设了才启用访问密码 */
export const OPTIONAL_ENV = ['APP_PASSWORD'];

/** 能连的仓库平台。与 `providers/index.js` 的工厂表是同一件事，测试守着别漂 */
export const PROVIDER_NAMES = ['gitee', 'github'];

/**
 * 旧名字 → 新名字（#36 硬切，不做兼容运行）。
 *
 * 为什么不留回落：**提示无处显示**。自托管者不会去翻云平台的控制台日志，要让提示可见
 * 就得让服务端把话带回界面、挂一条常驻横幅——那就破了「前端零改动」这条线。所以
 * 「兼容 + 提示」实际只剩两条出路：退化成静默，或者破边界。两条都不划算。
 */
export const LEGACY_ENV = {
  GITEE_TOKEN: 'REPO_TOKEN',
  GITEE_OWNER: 'REPO_OWNER',
  GITEE_REPO: 'REPO_REPO',
};
