// Deno Deploy 入口：静态前端（web/dist）+ /api/* 代理共用 server/src/core.js
// 无外部依赖（不引 jsr/npm），上传体积最小、构建确定性最高。
import { handleApi } from "../server/src/core.js";

const DIST = "web/dist";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function env() {
  return {
    GITEE_TOKEN: Deno.env.get("GITEE_TOKEN") ?? "",
    GITEE_OWNER: Deno.env.get("GITEE_OWNER") ?? "",
    GITEE_REPO: Deno.env.get("GITEE_REPO") ?? "",
    APP_PASSWORD: Deno.env.get("APP_PASSWORD") ?? "",
  };
}

// 仅伺服 dist 内的文件，防目录穿越；SPA 是 hash 路由，只需 index.html + 静态资源
async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel || rel.includes("..") || rel.includes("\\")) {
    return new Response("Bad Request", { status: 400 });
  }
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  try {
    const data = await Deno.readFile(`${DIST}/${rel}`);
    return new Response(data, {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        // index.html 不缓存（保证发版即生效），带 hash 的构建产物缓存一天
        "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=86400",
      },
    });
  } catch (_) {
    return new Response("Not Found", { status: 404 });
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return handleApi(request, env());
  }
  return serveStatic(pathname);
});
