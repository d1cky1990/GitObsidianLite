// Gitee 后端代理的 API 封装
const AUTH_KEY = 'appPassword';

// 服务端配置了 APP_PASSWORD 时，所有请求带头；<img src=/api/raw> 走 cookie（服务端种）
function authHeaders() {
  const pw = localStorage.getItem(AUTH_KEY);
  return pw ? { 'X-Auth': pw } : {};
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401 && data.auth) {
      // 密码缺失/错误 → 通知弹密码框
      window.dispatchEvent(new CustomEvent('need-password'));
      const err = new Error('需要访问密码');
      err.status = 401;
      err.auth = true;
      throw err;
    }
    const err = new Error(data.error || `请求失败 (${resp.status})`);
    err.status = resp.status;
    err.conflict = data.conflict;
    err.remote = data.remote;
    err.exists = data.exists;      // 新建撞名
    err.notFound = data.notFound;  // 要动的东西已经不在了
    throw err;
  }
  return data;
}

export const listDir = (path = '') => api(`/api/tree?path=${encodeURIComponent(path)}`);
export const listTree = () => api('/api/tree/recursive');
export const listHead = () => api('/api/head');
export const readFile = (path) => api(`/api/file?path=${encodeURIComponent(path)}`);

// 写：**带 sha 是改，不带 sha 是建**。这个区分由服务端翻译成 Gitee 的两个端点
// （PUT / POST），浏览器不必知道——但「建新文件不能带 sha」这条得守住。
// 提交信息不给默认值：四种动作各有各的措辞，默认值只会让某一处悄悄漏掉前缀。
export const writeFile = (path, content, sha, message) =>
  api('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, sha, message }),
  });

export const createFile = (path, content, message) => writeFile(path, content, undefined, message);

export const deleteFile = (path, sha, message) =>
  api('/api/file', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, sha, message }),
  });

export const rawUrl = (path) => `/api/raw?path=${encodeURIComponent(path)}`;
