import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  JP Shopping Plugin — 日本电商比价搜索                                */
/*  Amazon JP / 骏河屋 / Mercari / 乐天 / Animate                      */
/*  Strategy: search URL generation + SearXNG (google,bing) scraping    */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function httpGet(
  url: string,
  timeout = REQUEST_TIMEOUT
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        family: 4,
        timeout,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Encoding": "gzip, deflate",
          Accept: "text/html,application/xhtml+xml,application/json",
          "Accept-Language": "ja,en;q=0.9,zh-CN;q=0.8",
        },
      },
      (res) => {
        // Follow redirects
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          const loc = res.headers.location.startsWith("http")
            ? res.headers.location
            : `${u.protocol}//${u.hostname}${res.headers.location}`;
          httpGet(loc, timeout).then(resolve).catch(reject);
          res.resume();
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = res.headers["content-encoding"];
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            data: Buffer.concat(chunks).toString("utf8"),
          })
        );
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout ${timeout}ms`));
    });
  });
}

/* ---- Platform definitions ---- */

interface ShopPlatform {
  id: string;
  name: string;
  nameJa: string;
  icon: string;
  searchUrl: (keyword: string) => string;
  bingSiteFilter: string;
  category: string; // 'new' | 'used' | 'c2c' | 'general'
}

const PLATFORMS: ShopPlatform[] = [
  {
    id: "amazon_jp",
    name: "Amazon JP",
    nameJa: "Amazon.co.jp",
    icon: "🛒",
    searchUrl: (kw) =>
      `https://www.amazon.co.jp/s?k=${encodeURIComponent(kw)}`,
    bingSiteFilter: "site:amazon.co.jp",
    category: "general",
  },
  {
    id: "rakuten",
    name: "Rakuten",
    nameJa: "楽天市場",
    icon: "🏪",
    searchUrl: (kw) =>
      `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(kw)}/`,
    bingSiteFilter: "site:item.rakuten.co.jp",
    category: "general",
  },
  {
    id: "surugaya",
    name: "Suruga-ya",
    nameJa: "駿河屋",
    icon: "📦",
    searchUrl: (kw) =>
      `https://www.suruga-ya.jp/search?category=&search_word=${encodeURIComponent(kw)}`,
    bingSiteFilter: "site:suruga-ya.jp",
    category: "used",
  },
  {
    id: "mercari",
    name: "Mercari",
    nameJa: "メルカリ",
    icon: "🤝",
    searchUrl: (kw) =>
      `https://jp.mercari.com/search?keyword=${encodeURIComponent(kw)}`,
    bingSiteFilter: "site:jp.mercari.com",
    category: "c2c",
  },
  {
    id: "animate",
    name: "Animate",
    nameJa: "アニメイト",
    icon: "🎌",
    searchUrl: (kw) =>
      `https://www.animate-onlineshop.jp/products/list.php?mode=search&keyword=${encodeURIComponent(kw)}`,
    bingSiteFilter: "site:animate-onlineshop.jp",
    category: "new",
  },
];

const PLATFORM_MAP: Record<string, ShopPlatform> = {};
for (const p of PLATFORMS) {
  PLATFORM_MAP[p.id] = p;
  PLATFORM_MAP[p.name.toLowerCase()] = p;
  PLATFORM_MAP[p.nameJa] = p;
}
// Aliases
PLATFORM_MAP["亚马逊"] = PLATFORM_MAP["amazon_jp"];
PLATFORM_MAP["日亚"] = PLATFORM_MAP["amazon_jp"];
PLATFORM_MAP["amazon"] = PLATFORM_MAP["amazon_jp"];
PLATFORM_MAP["骏河屋"] = PLATFORM_MAP["surugaya"];
PLATFORM_MAP["駿河屋"] = PLATFORM_MAP["surugaya"];
PLATFORM_MAP["suruga"] = PLATFORM_MAP["surugaya"];
PLATFORM_MAP["乐天"] = PLATFORM_MAP["rakuten"];
PLATFORM_MAP["楽天"] = PLATFORM_MAP["rakuten"];
PLATFORM_MAP["煤炉"] = PLATFORM_MAP["mercari"];
PLATFORM_MAP["メルカリ"] = PLATFORM_MAP["mercari"];
PLATFORM_MAP["animate"] = PLATFORM_MAP["animate"];
PLATFORM_MAP["アニメイト"] = PLATFORM_MAP["animate"];

function resolvePlatform(input: string): ShopPlatform | null {
  const key = input.trim().toLowerCase();
  return PLATFORM_MAP[key] || PLATFORM_MAP[input.trim()] || null;
}

/* ---- SearXNG search helper ---- */

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searxngSearch(query: string, count = 8): Promise<SearchResult[]> {
  try {
    const url = `http://127.0.0.1:8888/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing&pageno=1`;
    const res = await httpGet(url);
    if (res.status !== 200) return [];

    const json = JSON.parse(res.data);
    if (!json.results || !Array.isArray(json.results)) return [];

    const results: SearchResult[] = json.results
      .slice(0, count)
      .map((r: { title?: string; url?: string; content?: string }) => ({
        title: (r.title || "").trim(),
        url: (r.url || "").trim(),
        snippet: (r.content || "").trim(),
      }))
      .filter((r: SearchResult) => r.title && r.url);

    return results;
  } catch {
    return [];
  }
}

/* ---- Price extraction helper ---- */

function extractPrices(text: string): string[] {
  const patterns = [
    /([0-9,]+)\s*円/g,
    /¥\s*([0-9,]+)/g,
    /JPY\s*([0-9,]+)/g,
  ];
  const prices: string[] = [];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(text)) !== null) {
      const val = m[1].replace(/,/g, "");
      const num = parseInt(val, 10);
      if (num >= 10 && num <= 10_000_000) {
        prices.push(`¥${num.toLocaleString()}`);
      }
    }
  }
  return [...new Set(prices)].slice(0, 5);
}

/* ==================================================================== */

const plugin = {
  id: "jp-shopping",
  name: "JP Shopping",
  description:
    "日本电商搜索 — Amazon JP/骏河屋/Mercari/乐天/Animate 比价查询",

  register(api: OpenClawPluginApi) {
    /* ================================================================ */
    /* Tool 1: jp_search — cross-platform product search                */
    /* ================================================================ */
    api.registerTool({
      name: "jp_search",
      label: "日本电商搜索",
      description: `在日本电商平台搜索商品，返回各平台搜索链接和搜索引擎抓取到的商品摘要。
支持平台：Amazon JP（日亚）、楽天（乐天）、駿河屋（骏河屋）、メルカリ（Mercari）、アニメイト（Animate）。

使用场景：
- "在日本买高达模型哪里便宜"
- "骏河屋搜一下初音未来手办"
- "日亚上这个多少钱"
- "帮我搜一下日本的XX商品"
- "日本代购XX多少钱"

返回各平台的搜索直链（用户可直接点击）+ 搜索引擎搜到的商品信息和价格。`,
      parameters: Type.Object({
        keyword: Type.String({
          description:
            "搜索关键词（日文/英文效果最佳，如 ガンダム、hatsune miku figure）",
        }),
        platform: Type.Optional(
          Type.String({
            description:
              "指定平台筛选（amazon/rakuten/surugaya/mercari/animate）。不指定则搜索全部5个平台",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const keyword = String(params.keyword || "").trim();
        if (!keyword) return { error: "请提供搜索关键词" };

        /* Determine which platforms to search */
        let platforms: ShopPlatform[];
        if (params.platform) {
          const p = resolvePlatform(String(params.platform));
          if (!p)
            return {
              error: `未知平台 "${params.platform}"。支持：amazon/rakuten/surugaya/mercari/animate`,
            };
          platforms = [p];
        } else {
          platforms = PLATFORMS;
        }

        /* Generate search URLs for all platforms */
        const searchLinks = platforms.map((p) => ({
          platform: `${p.icon} ${p.nameJa} (${p.name})`,
          category:
            p.category === "new"
              ? "新品"
              : p.category === "used"
                ? "中古"
                : p.category === "c2c"
                  ? "个人闲置"
                  : "综合",
          url: p.searchUrl(keyword),
        }));

        /* Use SearXNG to search for actual product data across selected platforms */
        const searchQueries = platforms.map((p) =>
          searxngSearch(`${keyword} ${p.bingSiteFilter}`, 4)
        );

        let searchResults: { platform: string; results: SearchResult[] }[];
        try {
          const allResults = await Promise.all(searchQueries);
          searchResults = platforms.map((p, i) => ({
            platform: p.name,
            results: allResults[i],
          }));
        } catch {
          searchResults = [];
        }

        /* Format results into product summaries */
        const productHits: any[] = [];
        for (const br of searchResults) {
          for (const r of br.results) {
            // Skip non-product pages
            if (
              r.url.includes("/help") ||
              r.url.includes("/about") ||
              r.url.includes("/guide")
            )
              continue;
            const prices = extractPrices(r.title + " " + r.snippet);
            productHits.push({
              platform: br.platform,
              title: r.title.slice(0, 80),
              price: prices.length > 0 ? prices[0] : null,
              url: r.url,
              snippet: r.snippet.slice(0, 120) || undefined,
            });
          }
        }

        // Limit total hits
        const topHits = productHits.slice(0, 12);

        return {
          keyword,
          search_links: searchLinks,
          product_results: topHits.length > 0 ? topHits : undefined,
          result_count: topHits.length,
          note:
            topHits.length > 0
              ? "以上为搜索引擎搜索到的商品摘要，点击搜索链接可查看完整列表"
              : "未能通过搜索引擎搜索到具体商品信息，请点击上方搜索链接直接查看",
          数据来源: "SearXNG",
        };
      },
    });

    /* ================================================================ */
    /* Tool 2: jp_price_compare — quick price comparison                */
    /* ================================================================ */
    api.registerTool({
      name: "jp_price_compare",
      label: "日本比价",
      description: `对比商品在多个日本电商平台的价格。通过搜索引擎搜索各平台上的价格信息。

使用场景：
- "这个手办在日本各平台分别多少钱"
- "对比一下骏河屋和Amazon JP上的价格"
- "找日本最便宜的渠道买XX"`,
      parameters: Type.Object({
        keyword: Type.String({
          description: "商品关键词（尽量精确，如型号/品名）",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const keyword = String(params.keyword || "").trim();
        if (!keyword) return { error: "请提供商品关键词" };

        /* Search each platform via SearXNG in parallel */
        const searches = PLATFORMS.map(async (p) => {
          const results = await searxngSearch(
            `${keyword} ${p.bingSiteFilter} 円`,
            5
          );
          const items: any[] = [];
          for (const r of results) {
            const prices = extractPrices(r.title + " " + r.snippet);
            if (prices.length > 0 || r.title.length > 10) {
              items.push({
                title: r.title.slice(0, 60),
                price: prices[0] || "价格未知",
                url: r.url,
              });
            }
          }
          return {
            platform: `${p.icon} ${p.nameJa}`,
            type:
              p.category === "new"
                ? "新品"
                : p.category === "used"
                  ? "中古"
                  : p.category === "c2c"
                    ? "个人闲置"
                    : "综合",
            search_url: p.searchUrl(keyword),
            items: items.slice(0, 3),
          };
        });

        try {
          const comparisons = await Promise.all(searches);
          return {
            keyword,
            comparison: comparisons,
            tip: "价格仅供参考，实际以各平台页面为准。点击链接查看完整结果。",
            数据来源: "SearXNG",
          };
        } catch (err) {
          return { error: `比价查询失败: ${String(err)}` };
        }
      },
    });

    console.log(
      "[jp-shopping] Registered jp_search + jp_price_compare tools"
    );
  },
};

export default plugin;
