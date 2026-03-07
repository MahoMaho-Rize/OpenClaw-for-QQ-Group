import { Type } from "@sinclair/typebox";
import https from "node:https";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Primary: moegirl.uk mirror (Cloudflare, stable, 0% packet loss)
// Fallback: zh.moegirl.org.cn (official, HK Tencent Cloud, 66% packet loss from this server)
const MIRROR_API = "https://moegirl.uk/api.php";
const MIRROR_BASE = "https://moegirl.uk";
const OFFICIAL_API = "https://zh.moegirl.org.cn/api.php";
const OFFICIAL_BASE = "https://zh.moegirl.org.cn";

// Always show official links to users
const DISPLAY_BASE = "https://zh.moegirl.org.cn";

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

// ── HTTP helper (node:https, IPv4-forced) ────────────────────────────
function httpsGet(url: string, extraHeaders: Record<string, string> = {}, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      family: 4,
      timeout: timeoutMs,
      headers: {
        "User-Agent": UA,
        ...extraHeaders,
      },
    };
    const req = https.get(options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          redirectUrl = `https://${parsedUrl.hostname}${redirectUrl}`;
        }
        httpsGet(redirectUrl, extraHeaders, timeoutMs).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timeout")); });
  });
}

// ── API with mirror fallback ─────────────────────────────────────────
async function mwFetch(params: Record<string, string>): Promise<any> {
  params.format = "json";
  const qs = new URLSearchParams(params).toString();

  // Try mirror first (fast, stable)
  try {
    const raw = await httpsGet(`${MIRROR_API}?${qs}`, {}, 12000);
    return JSON.parse(raw);
  } catch (_mirrorErr) {
    // Fallback to official
    const raw = await httpsGet(`${OFFICIAL_API}?${qs}`, {}, 25000);
    return JSON.parse(raw);
  }
}

async function fetchPageHtml(title: string): Promise<string> {
  const encoded = encodeURIComponent(title);

  // Try mirror first (no Referer needed)
  try {
    return await httpsGet(`${MIRROR_BASE}/${encoded}`, {
      "Accept": "text/html",
      "Accept-Language": "zh-CN,zh;q=0.9",
    }, 15000);
  } catch (_mirrorErr) {
    // Fallback to official (Referer required)
    return httpsGet(`${OFFICIAL_BASE}/${encoded}`, {
      "Referer": `${OFFICIAL_BASE}/`,
      "Accept": "text/html",
      "Accept-Language": "zh-CN,zh;q=0.9",
    }, 25000);
  }
}

function extractTextFromHtml(html: string): string {
  const startMarker = "mw-parser-output";
  let start = html.indexOf(startMarker);
  if (start < 0) return "";
  start = html.indexOf(">", start) + 1;

  let end = html.indexOf('class="printfooter"', start);
  if (end < 0) end = start + 30000;
  let content = html.slice(start, end);

  content = content.replace(/<(script|style)[^>]*>.*?<\/\1>/gs, "");
  content = content.replace(/<div class="(navbox|notice|mw-empty-elt|hatnote)[^"]*"[^>]*>.*?<\/div>/gs, "");
  content = content.replace(/<[^>]+>/g, " ");
  content = content.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  content = content.replace(/\[(\d+|注\s*\d+)\]/g, "");
  content = content.replace(/&#\d+;/g, "");
  content = content.replace(/[ \t]+/g, " ");
  content = content.replace(/\n{3,}/g, "\n\n");
  const lines = content.split("\n").map(l => l.trim()).filter(l => l);
  return lines.join("\n");
}

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

const MoegirlSchema = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("page"),
    Type.Literal("categories"),
  ]),
  keyword: Type.Optional(Type.String({ description: "搜索关键词 (action=search 时必填)" })),
  title: Type.Optional(Type.String({ description: "页面标题 (action=page/categories 时必填)" })),
  limit: Type.Optional(Type.Number({ description: "返回数量限制, 默认5, 最大10" })),
});

const plugin = {
  id: "moegirl",
  name: "Moegirl",
  description: "萌娘百科 (zh.moegirl.org.cn) ACG wiki lookup",

  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "moegirl",
        label: "萌娘百科",
        description: `Search and read articles on 萌娘百科 (Moegirlpedia, zh.moegirl.org.cn), a Chinese ACG encyclopedia covering anime, manga, games, light novels, vocaloid, virtual YouTubers, and more.
Actions:
- search: Search pages by keyword. Returns matching titles and links. Params: keyword (required), limit (default 5, max 10)
- page: Get the full text content of a page. Params: title (required). Use search first to find the exact title.
- categories: Get categories of a page. Params: title (required), limit (default 10)`,
        parameters: MoegirlSchema,

        async execute(_toolCallId: string, params: any) {
          try {
            switch (params.action) {
              case "search": {
                if (!params.keyword) return text("错误: search 需要 keyword 参数");
                const limit = Math.min(params.limit || 5, 10);
                const data = await mwFetch({
                  action: "opensearch",
                  search: params.keyword,
                  limit: String(limit),
                  redirects: "resolve",
                });
                if (!Array.isArray(data) || !data[1]?.length) {
                  return text(`未找到与"${params.keyword}"相关的页面`);
                }
                const titles: string[] = data[1];
                // Replace mirror URLs with official URLs for display
                const lines = titles.map((t: string) => {
                  const url = `${DISPLAY_BASE}/${encodeURIComponent(t)}`;
                  return `- ${t}\n  ${url}`;
                });
                return text(`搜索"${params.keyword}"找到${titles.length}个匹配:\n\n${lines.join("\n")}\n\n提示: 使用 action=page 和 title 参数查看页面内容`);
              }

              case "page": {
                if (!params.title) return text("错误: page 需要 title 参数");
                const html = await fetchPageHtml(params.title);
                const extracted = extractTextFromHtml(html);
                if (!extracted) return text(`无法提取页面"${params.title}"的内容`);
                const truncated = extracted.slice(0, 4000);
                const isTruncated = extracted.length > 4000;
                return text(`## ${params.title}\n\n${truncated}${isTruncated ? "\n\n...(内容过长已截断)" : ""}\n\n链接: ${DISPLAY_BASE}/${encodeURIComponent(params.title)}`);
              }

              case "categories": {
                if (!params.title) return text("错误: categories 需要 title 参数");
                const limit = Math.min(params.limit || 10, 50);
                const data = await mwFetch({
                  action: "query",
                  titles: params.title,
                  prop: "categories",
                  cllimit: String(limit),
                });
                if (data.error) return text(`查询失败: ${data.error.info}`);
                const pages = data.query?.pages;
                if (!pages) return text("页面不存在");
                const page = Object.values(pages)[0] as any;
                if (page.missing !== undefined) return text(`页面"${params.title}"不存在`);
                const cats = page.categories;
                if (!cats?.length) return text(`页面"${page.title}"没有分类`);
                const lines = cats.map((c: any) => `- ${c.title.replace("Category:", "")}`);
                return text(`## ${page.title} — 分类\n\n${lines.join("\n")}\n\n链接: ${DISPLAY_BASE}/${encodeURIComponent(page.title)}`);
              }

              default:
                return text(`未知操作: ${params.action}`);
            }
          } catch (err) {
            return text(`萌娘百科错误: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      { name: "moegirl" },
    );
    console.log("[moegirl] Registered moegirl tool (mirror: moegirl.uk → fallback: zh.moegirl.org.cn)");
  },
};

export default plugin;
