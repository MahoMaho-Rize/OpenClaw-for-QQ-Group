import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  SearXNG Search Plugin                                              */
/*  Queries local SearXNG instance (meta search engine)                */
/*  Default search tool for 丰川祥子                                    */
/* ------------------------------------------------------------------ */

const SEARXNG_BASE = "http://127.0.0.1:8888";
const REQUEST_TIMEOUT = 20_000;
const FETCH_TIMEOUT = 25_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ---- HTTP helpers (IPv4 forced) ---- */

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
  const maxRedirects = opts.maxRedirects ?? 5;

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
            Accept: "application/json, text/html;q=0.9, */*;q=0.8",
            "Accept-Encoding": "gzip, deflate",
          },
        },
        (res) => {
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

/* ---- HTML helpers for fetch ---- */

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
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

function extractMainContent(html: string, maxChars: number): string {
  let body = "";
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    body = articleMatch[1];
  } else {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) {
      body = mainMatch[1];
    } else {
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

/* ---- SearXNG result types ---- */

interface SearXNGResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  category: string;
  score?: number;
  publishedDate?: string;
  img_src?: string;
  thumbnail?: string;
}

interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  answers: string[];
  infoboxes: Array<{
    infobox: string;
    content: string;
    urls: Array<{ title: string; url: string }>;
  }>;
  suggestions: string[];
}

/* ---- Plugin ---- */

const plugin = {
  id: "searxng",
  name: "SearXNG Search",
  description: "SearXNG meta search engine - default web search",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "web_search",
      label: "网页搜索",
      description: `【默认搜索工具】SearXNG 元搜索引擎，聚合 Google、Bing、DuckDuckGo、Wikipedia 等多个搜索引擎结果。
支持三种操作：
- search: 搜索关键词，返回聚合结果（标题、URL、摘要、来源引擎）
- fetch: 获取指定 URL 的页面正文内容（用于深度阅读搜索结果）
- suggest: 获取搜索建议/相关搜索词

适用场景：任何需要搜索网络信息的场景。中英日文搜索均可。
可指定搜索类别：general（通用）、news（新闻）、images（图片）、science（学术）、videos（视频）、it（技术）、music（音乐）。
注意：对于东方Project、动漫、番剧等垂直领域，建议优先使用专用工具（thbwiki、moegirl、bangumi、fandom），搜索引擎作为通用补充。`,
      parameters: Type.Object({
        action: Type.Union(
          [
            Type.Literal("search"),
            Type.Literal("fetch"),
            Type.Literal("suggest"),
          ],
          {
            description:
              "操作类型：search（搜索）、fetch（获取页面内容）、suggest（搜索建议）",
          }
        ),
        query: Type.Optional(
          Type.String({
            description:
              "搜索关键词（action=search/suggest 时必填）。支持中英日文。",
          })
        ),
        url: Type.Optional(
          Type.String({
            description: "要获取内容的网页 URL（action=fetch 时必填）",
          })
        ),
        categories: Type.Optional(
          Type.String({
            description:
              "搜索类别，逗号分隔。可选：general, news, images, science, videos, it, music。默认 general",
          })
        ),
        language: Type.Optional(
          Type.String({
            description:
              "搜索语言代码。如 zh-CN（中文）、en（英文）、ja（日文）、all（所有语言）。默认自动",
          })
        ),
        time_range: Type.Optional(
          Type.String({
            description:
              "时间范围筛选。可选：day（一天内）、week（一周内）、month（一个月内）、year（一年内）。默认不限",
          })
        ),
        count: Type.Optional(
          Type.Number({
            description: "搜索结果数量（默认 10，最大 30）",
          })
        ),
        page: Type.Optional(
          Type.Number({
            description: "页码（默认 1）",
          })
        ),
        max_chars: Type.Optional(
          Type.Number({
            description: "fetch 操作返回的最大字符数（默认 8000）",
          })
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>
      ) => {
        const action = params.action as string;

        /* ---- SEARCH ---- */
        if (action === "search") {
          const query = params.query as string | undefined;
          if (!query || !query.trim()) {
            return { error: "search 操作需要提供 query 参数" };
          }

          const categories = (params.categories as string) || "general";
          const language = (params.language as string) || "";
          const timeRange = (params.time_range as string) || "";
          const page = Math.max((params.page as number) || 1, 1);

          const searchParams = new URLSearchParams({
            q: query.trim(),
            format: "json",
            categories,
            pageno: String(page),
          });
          if (language) searchParams.set("language", language);
          if (timeRange) searchParams.set("time_range", timeRange);

          const searchUrl = `${SEARXNG_BASE}/search?${searchParams.toString()}`;

          try {
            const res = await httpGet(searchUrl, { timeout: REQUEST_TIMEOUT });
            if (res.status !== 200) {
              return {
                error: `SearXNG 返回 HTTP ${res.status}`,
                query,
              };
            }

            let data: SearXNGResponse;
            try {
              data = JSON.parse(res.data);
            } catch {
              return { error: "SearXNG 返回了非 JSON 数据", query };
            }

            const count = Math.min(
              Math.max((params.count as number) || 10, 1),
              30
            );
            const results = data.results.slice(0, count);

            if (results.length === 0 && data.answers.length === 0) {
              return {
                query,
                results: [],
                suggestions: data.suggestions || [],
                message: "未找到相关结果",
              };
            }

            console.log(
              `[searxng] search "${query}" → ${results.length} results, ${data.answers.length} answers`
            );

            const response: Record<string, unknown> = {
              query,
              result_count: results.length,
              results: results.map((r, i) => {
                const item: Record<string, unknown> = {
                  index: i + 1,
                  title: r.title,
                  url: r.url,
                  snippet: r.content || "",
                  engine: r.engine,
                };
                if (r.publishedDate) item.date = r.publishedDate;
                if (r.img_src) item.image = r.img_src;
                if (r.thumbnail) item.thumbnail = r.thumbnail;
                return item;
              }),
              数据来源: "SearXNG 元搜索引擎（聚合 Google/Bing/DuckDuckGo 等）",
            };

            if (data.answers.length > 0) {
              response.answers = data.answers;
            }
            if (data.infoboxes && data.infoboxes.length > 0) {
              response.infoboxes = data.infoboxes.map((ib) => ({
                title: ib.infobox,
                content: ib.content,
                urls: ib.urls,
              }));
            }
            if (data.suggestions && data.suggestions.length > 0) {
              response.suggestions = data.suggestions;
            }

            return response;
          } catch (err) {
            return { error: `搜索失败: ${String(err)}`, query };
          }
        }

        /* ---- FETCH ---- */
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
              return {
                url,
                content: "",
                message: "页面内容为空或无法提取",
              };
            }

            console.log(
              `[searxng] fetch "${url}" → ${content.length} chars`
            );

            return { url, content_length: content.length, content };
          } catch (err) {
            return { error: `获取页面失败: ${String(err)}`, url };
          }
        }

        /* ---- SUGGEST ---- */
        if (action === "suggest") {
          const query = params.query as string | undefined;
          if (!query || !query.trim()) {
            return { error: "suggest 操作需要提供 query 参数" };
          }

          // SearXNG autocomplete endpoint
          const suggestUrl = `${SEARXNG_BASE}/autocompleter?q=${encodeURIComponent(query.trim())}`;

          try {
            const res = await httpGet(suggestUrl, { timeout: 10_000 });
            if (res.status !== 200) {
              return {
                error: `SearXNG autocomplete 返回 HTTP ${res.status}`,
                query,
              };
            }

            let suggestions: string[];
            try {
              suggestions = JSON.parse(res.data);
            } catch {
              return { error: "SearXNG autocomplete 返回了非 JSON 数据", query };
            }

            return {
              query,
              suggestions,
              数据来源: "SearXNG 搜索建议",
            };
          } catch (err) {
            return { error: `获取搜索建议失败: ${String(err)}`, query };
          }
        }

        return {
          error: `未知操作: ${action}，支持 search、fetch、suggest`,
        };
      },
    });

    console.log(
      "[searxng] Registered web_search tool (SearXNG meta search, default)"
    );
  },
};

export default plugin;
