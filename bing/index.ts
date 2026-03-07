import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Bing Web Search Plugin                                             */
/*  Scrapes cn.bing.com search results (no API key needed)             */
/* ------------------------------------------------------------------ */

const BING_BASE = "https://cn.bing.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 15_000;
const FETCH_TIMEOUT = 20_000;

/* ---- HTTP helpers (node:https, IPv4 forced) ---- */

interface HttpResponse {
  status: number;
  data: string;
  url: string;
}

function httpGet(
  url: string,
  opts: { timeout?: number; maxRedirects?: number } = {}
): Promise<HttpResponse> {
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  const maxRedirects = opts.maxRedirects ?? 3;

  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function doRequest(currentUrl: string) {
      const u = new URL(currentUrl);
      const isHttps = u.protocol === "https:";
      const mod = isHttps ? https : http;

      const req = mod.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: u.port || (isHttps ? 443 : 80),
          family: 4,
          timeout,
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Encoding": "gzip, deflate",
          },
        },
        (res) => {
          // Handle redirects
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (++redirectCount > maxRedirects) {
              reject(new Error(`Too many redirects (>${maxRedirects})`));
              return;
            }
            const next = new URL(res.headers.location, currentUrl).href;
            res.resume();
            doRequest(next);
            return;
          }

          // Handle gzip/deflate
          let stream: NodeJS.ReadableStream = res;
          const encoding = res.headers["content-encoding"];
          if (encoding === "gzip") {
            stream = res.pipe(zlib.createGunzip());
          } else if (encoding === "deflate") {
            stream = res.pipe(zlib.createInflate());
          }

          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              data: Buffer.concat(chunks).toString("utf8"),
              url: currentUrl,
            });
          });
          stream.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timeout (${timeout}ms)`));
      });
    }

    doRequest(url);
  });
}

/* ---- HTML parsing helpers ---- */

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&#0?183;/g, "·")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

function stripHtml(s: string): string {
  return decodeHtmlEntities(
    s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[^>]+(>|$)/g, "")
  ).trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---- Search result parsing ---- */

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Extract <ol id="b_results"> block
  const olMatch = html.match(
    /<ol[^>]*id=["']b_results["'][^>]*>([\s\S]*?)<\/ol>/
  );
  if (!olMatch) return results;

  // Match each b_algo item
  const liRegex =
    /<li class="b_algo"[^>]*>([\s\S]*?)(?=<li class="b_algo"|<li class="b_ans"|<li class="b_ad"|<li class="b_pag"|<\/ol>)/g;
  let match: RegExpExecArray | null;

  while ((match = liRegex.exec(olMatch[1])) !== null) {
    const li = match[1];

    // Title + URL: <h2><a href="URL">TITLE</a></h2>
    const titleMatch = li.match(
      /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!titleMatch) continue;

    const url = decodeHtmlEntities(titleMatch[1]);
    const title = stripHtml(titleMatch[2]);

    // Snippet: various patterns
    let snippet = "";

    // Pattern 1: <div class="b_caption"><p>...</p>
    const capMatch = li.match(
      /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/
    );
    if (capMatch) {
      snippet = stripHtml(capMatch[1]);
    }

    // Pattern 2: <p class="b_lineclamp...">
    if (!snippet) {
      const lineMatch = li.match(
        /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/
      );
      if (lineMatch) snippet = stripHtml(lineMatch[1]);
    }

    // Pattern 3: <p class="b_paractl">
    if (!snippet) {
      const paraMatch = li.match(/<p class="b_paractl"[^>]*>([\s\S]*?)<\/p>/);
      if (paraMatch) snippet = stripHtml(paraMatch[1]);
    }

    // Pattern 4: any <p> in the item
    if (!snippet) {
      const anyP = li.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (anyP) snippet = stripHtml(anyP[1]);
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/* ---- Page content fetching ---- */

function extractMainContent(html: string, maxChars: number): string {
  // Try to extract <article> or <main> content first
  let body = "";
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    body = articleMatch[1];
  } else {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) {
      body = mainMatch[1];
    } else {
      // Fallback: extract <body>
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      body = bodyMatch ? bodyMatch[1] : html;
    }
  }

  const text = htmlToText(body);
  if (text.length > maxChars) {
    return text.substring(0, maxChars) + "…（已截断）";
  }
  return text;
}

/* ---- Plugin entry ---- */

const plugin = {
  id: "bing",
  name: "Bing Search",
  description: "Bing web search via cn.bing.com scraping",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "bing",
      label: "Bing Search",
      description: `Bing 网页搜索工具。通过爬取 cn.bing.com 获取搜索结果。
支持两种操作：
- search: 搜索关键词，返回标题、URL、摘要列表
- fetch: 获取指定 URL 的页面正文内容（用于深度阅读搜索结果）

适用场景：需要搜索最新信息、新闻、事件，查找特定网站或资源，获取网页正文内容。中英文搜索均可。
注意：对于东方Project、动漫、番剧等垂直领域，建议优先使用专用工具（thbwiki、moegirl、bangumi、fandom），Bing 搜索作为通用补充。`,
      parameters: Type.Object({
        action: Type.Union(
          [Type.Literal("search"), Type.Literal("fetch")],
          {
            description:
              "操作类型：search（搜索）或 fetch（获取页面内容）",
          }
        ),
        query: Type.Optional(
          Type.String({
            description:
              "搜索关键词（action=search 时必填）。支持中英文，可用 Bing 搜索语法如 site:xxx.com",
          })
        ),
        url: Type.Optional(
          Type.String({
            description:
              "要获取内容的网页 URL（action=fetch 时必填）",
          })
        ),
        count: Type.Optional(
          Type.Number({
            description: "搜索结果数量（默认 10，最大 30）",
          })
        ),
        max_chars: Type.Optional(
          Type.Number({
            description:
              "fetch 操作返回的最大字符数（默认 8000）",
          })
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const action = params.action as string;

        if (action === "search") {
          const query = params.query as string | undefined;
          if (!query || !query.trim()) {
            return { error: "search 操作需要提供 query 参数" };
          }

          const count = Math.min(Math.max((params.count as number) || 10, 1), 30);
          const searchUrl = `${BING_BASE}/search?q=${encodeURIComponent(query.trim())}&count=${count}`;

          try {
            const res = await httpGet(searchUrl, { timeout: REQUEST_TIMEOUT });
            if (res.status !== 200) {
              return { error: `Bing 返回 HTTP ${res.status}`, query };
            }

            const results = parseBingResults(res.data);
            if (results.length === 0) {
              return { query, results: [], message: "未找到相关结果" };
            }

            console.log(`[bing] search "${query}" → ${results.length} results`);

            return {
              query,
              result_count: results.length,
              results: results.map((r, i) => ({
                index: i + 1,
                title: r.title,
                url: r.url,
                snippet: r.snippet,
              })),
            };
          } catch (err) {
            return { error: `搜索失败: ${String(err)}`, query };
          }
        }

        if (action === "fetch") {
          const url = params.url as string | undefined;
          if (!url || !url.trim()) {
            return { error: "fetch 操作需要提供 url 参数" };
          }

          const maxChars = Math.min(
            Math.max((params.max_chars as number) || 8000, 500),
            30000
          );

          try {
            const res = await httpGet(url.trim(), { timeout: FETCH_TIMEOUT });
            if (res.status !== 200) {
              return { error: `页面返回 HTTP ${res.status}`, url };
            }

            const content = extractMainContent(res.data, maxChars);
            if (!content || content.length < 20) {
              return { url, content: "", message: "页面内容为空或无法提取" };
            }

            console.log(`[bing] fetch "${url}" → ${content.length} chars`);

            return { url, content_length: content.length, content };
          } catch (err) {
            return { error: `获取页面失败: ${String(err)}`, url };
          }
        }

        return { error: `未知操作: ${action}，支持 search 和 fetch` };
      },
    });

    console.log("[bing] Registered bing tool (cn.bing.com scraper, IPv4)");
  },
};

export default plugin;
