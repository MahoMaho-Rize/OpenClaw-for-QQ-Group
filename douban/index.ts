import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Douban Search Plugin                                               */
/*  Uses Douban suggest API to search books and movies                  */
/* ------------------------------------------------------------------ */

const BOOK_SUGGEST_API = "https://book.douban.com/j/subject_suggest";
const MOVIE_SUGGEST_API = "https://movie.douban.com/j/subject_suggest";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 15_000;

/* ---- HTTP helper (node:https, IPv4 forced) ---- */

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
            Accept: "application/json, text/plain, */*",
            "Accept-Encoding": "gzip, deflate",
            Referer: "https://www.douban.com/",
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

/* ---- Douban suggest API types ---- */

interface DoubanSuggestItem {
  title: string;
  url: string;
  pic: string;
  author_name?: string;
  year?: string;
  type: string;
  id: string;
}

interface FormattedResult {
  title: string;
  year: string;
  author_or_director: string;
  rating: string;
  cover: string;
  douban_url: string;
  type: string;
}

/* ---- Suggest API fetching ---- */

async function fetchSuggest(
  apiUrl: string,
  query: string
): Promise<DoubanSuggestItem[]> {
  const url = `${apiUrl}?q=${encodeURIComponent(query)}`;
  const res = await httpGet(url);
  if (res.status !== 200) {
    throw new Error(`豆瓣 API 返回 HTTP ${res.status}`);
  }
  const data = JSON.parse(res.data);
  if (!Array.isArray(data)) return [];
  return data;
}

function formatItem(item: DoubanSuggestItem, category: string): FormattedResult {
  return {
    title: item.title || "未知",
    year: item.year || "未知",
    author_or_director: item.author_name || "未知",
    rating: "",
    cover: item.pic || "",
    douban_url: item.url || `https://www.douban.com/subject/${item.id}/`,
    type: category,
  };
}

function formatResultText(results: FormattedResult[]): string {
  if (!results.length) return "未找到相关结果";

  const lines = results.map((r, i) => {
    const typeLabel = r.type === "book" ? "📚 书籍" : "🎬 影视";
    const parts = [
      `${i + 1}. [${typeLabel}] ${r.title}`,
      `   年份: ${r.year}`,
      `   ${r.type === "book" ? "作者" : "导演/主演"}: ${r.author_or_director}`,
    ];
    if (r.cover) parts.push(`   封面: ${r.cover}`);
    parts.push(`   链接: ${r.douban_url}`);
    return parts.join("\n");
  });

  return lines.join("\n\n");
}

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

/* ---- Plugin entry ---- */

const DoubanSearchSchema = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  type: Type.Optional(
    Type.Union(
      [Type.Literal("book"), Type.Literal("movie"), Type.Literal("all")],
      {
        description:
          '搜索类型：book（仅搜书籍）、movie（仅搜影视）、all（同时搜索书籍和影视）。默认 all',
      }
    )
  ),
});

const plugin = {
  id: "douban",
  name: "Douban",
  description: "豆瓣书影搜索（Douban book & movie search via suggest API）",

  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "douban_search",
        label: "豆瓣搜索",
        description: `豆瓣书影搜索工具。通过豆瓣 Suggest API 搜索书籍和电影/电视剧。
返回信息包括：标题、年份、作者/导演、封面图片链接、豆瓣链接。
支持三种搜索类型：
- book: 仅搜索豆瓣读书
- movie: 仅搜索豆瓣电影
- all: 同时搜索豆瓣读书和豆瓣电影（默认）

适用场景：查找书籍或影视作品信息、获取豆瓣链接、了解作品基本信息。`,
        parameters: DoubanSearchSchema,

        async execute(_toolCallId: string, params: any) {
          try {
            const query = (params.query as string)?.trim();
            if (!query) return text("错误: 请提供搜索关键词");

            const searchType = (params.type as string) || "all";
            const allResults: FormattedResult[] = [];

            if (searchType === "book" || searchType === "all") {
              try {
                const books = await fetchSuggest(BOOK_SUGGEST_API, query);
                allResults.push(...books.map((b) => formatItem(b, "book")));
                console.log(`[douban] book search "${query}" → ${books.length} results`);
              } catch (err) {
                if (searchType === "book") {
                  return text(`豆瓣读书搜索失败: ${err instanceof Error ? err.message : String(err)}`);
                }
                console.warn(`[douban] book search failed: ${err}`);
              }
            }

            if (searchType === "movie" || searchType === "all") {
              try {
                const movies = await fetchSuggest(MOVIE_SUGGEST_API, query);
                allResults.push(...movies.map((m) => formatItem(m, "movie")));
                console.log(`[douban] movie search "${query}" → ${movies.length} results`);
              } catch (err) {
                if (searchType === "movie") {
                  return text(`豆瓣电影搜索失败: ${err instanceof Error ? err.message : String(err)}`);
                }
                console.warn(`[douban] movie search failed: ${err}`);
              }
            }

            if (allResults.length === 0) {
              return text(`未找到与"${query}"相关的结果`);
            }

            const typeLabel =
              searchType === "book"
                ? "豆瓣读书"
                : searchType === "movie"
                  ? "豆瓣电影"
                  : "豆瓣读书+电影";

            const header = `搜索"${query}"（${typeLabel}），共找到 ${allResults.length} 个结果:\n\n`;
            return text(header + formatResultText(allResults));
          } catch (err) {
            return text(`豆瓣搜索错误: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      { name: "douban" },
    );

    console.log("[douban] Registered douban_search tool (book.douban.com + movie.douban.com suggest API, IPv4)");
  },
};

export default plugin;
