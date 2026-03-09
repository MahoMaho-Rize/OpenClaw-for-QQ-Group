import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  JP Shopping Plugin — 日本电商比价搜索 (v2 – direct scraping)       */
/*  Amazon JP / 楽天 / Mercari / 駿河屋 / Animate                      */
/*  Strategy: WARP SOCKS5 → direct platform scraping (HTML + JSON-LD) */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const WARP_HOST = "127.0.0.1";
const WARP_PORT = 40000;

/* ---- SOCKS5 + TLS helper (via Cloudflare WARP) ---- */

function socks5HttpsGet(
  targetHost: string,
  path: string,
  extraHeaders: Record<string, string> = {},
  timeout = REQUEST_TIMEOUT
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(WARP_PORT, WARP_HOST, () => {
      // SOCKS5 greeting: version 5, 1 method, no-auth
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let step = 0;
    sock.on("data", (data) => {
      if (step === 0) {
        // Auth response
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          sock.destroy();
          return reject(new Error("SOCKS5 auth fail"));
        }
        step = 1;
        // CONNECT request (domain-name mode)
        const buf = Buffer.alloc(7 + targetHost.length);
        buf[0] = 0x05; // ver
        buf[1] = 0x01; // CMD: CONNECT
        buf[2] = 0x00; // reserved
        buf[3] = 0x03; // ATYP: domain
        buf[4] = targetHost.length;
        buf.write(targetHost, 5);
        buf.writeUInt16BE(443, 5 + targetHost.length);
        sock.write(buf);
      } else if (step === 1) {
        // CONNECT response
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          sock.destroy();
          return reject(new Error("SOCKS5 connect fail"));
        }
        step = 2;
        // TLS handshake over the proxied TCP socket
        const tlsSock = tls.connect(
          { socket: sock, servername: targetHost },
          () => {
            const req = https.get(
              {
                hostname: targetHost,
                path,
                createConnection: () => tlsSock as any,
                headers: {
                  "User-Agent": USER_AGENT,
                  "Accept-Language": "ja,en;q=0.9",
                  Accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "Accept-Encoding": "gzip, deflate",
                  ...extraHeaders,
                },
                timeout,
              },
              (res) => {
                // Handle redirects (up to 3)
                if (
                  (res.statusCode === 301 ||
                    res.statusCode === 302 ||
                    res.statusCode === 307) &&
                  res.headers.location
                ) {
                  res.resume();
                  tlsSock.destroy();
                  try {
                    const loc = new URL(
                      res.headers.location,
                      `https://${targetHost}`
                    );
                    socks5HttpsGet(
                      loc.hostname,
                      loc.pathname + loc.search,
                      extraHeaders,
                      timeout
                    )
                      .then(resolve)
                      .catch(reject);
                  } catch {
                    reject(new Error(`Bad redirect: ${res.headers.location}`));
                  }
                  return;
                }

                // Decompress if needed
                let stream: NodeJS.ReadableStream = res;
                const enc = res.headers["content-encoding"];
                if (enc === "gzip") {
                  stream = res.pipe(zlib.createGunzip());
                } else if (enc === "deflate") {
                  stream = res.pipe(zlib.createInflate());
                }

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
              reject(new Error("HTTP timeout"));
            });
          }
        );
        tlsSock.on("error", reject);
      }
    });
    sock.on("error", reject);
    sock.setTimeout(timeout, () => {
      sock.destroy();
      reject(new Error("SOCKS5 socket timeout"));
    });
  });
}

/* ---- HTML entity decoder ---- */

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/* ---- Product type ---- */

interface Product {
  platform: string;
  title: string;
  price: string | null;
  url: string;
  rating?: string | null;
  reviews?: string | null;
}

/* ================================================================== */
/*  Amazon JP Scraper                                                  */
/*  WARP SOCKS5 → HTML scraping with i18n-prefs=JPY cookie            */
/* ================================================================== */

async function scrapeAmazonJP(keyword: string, limit = 8): Promise<Product[]> {
  const path = `/s?k=${encodeURIComponent(keyword)}`;
  const res = await socks5HttpsGet("www.amazon.co.jp", path, {
    Cookie: "i18n-prefs=JPY; lc-acbjp=ja_JP",
  });

  if (res.status !== 200 || res.data.length < 5000) return [];

  const html = res.data;
  const products: Product[] = [];

  // Find product blocks via data-asin + data-index
  const blockRegex = /data-asin="(\w{10})"[^>]*data-index="(\d+)"/g;
  const blocks: { asin: string; index: string; start: number }[] = [];
  let bm: RegExpExecArray | null;
  while ((bm = blockRegex.exec(html)) !== null) {
    blocks.push({ asin: bm[1], index: bm[2], start: bm.index });
  }

  const seen = new Set<string>();
  for (let i = 0; i < blocks.length && products.length < limit; i++) {
    const { asin, start } = blocks[i];
    if (seen.has(asin)) continue;
    seen.add(asin);

    const end = i + 1 < blocks.length ? blocks[i + 1].start : start + 15000;
    const block = html.substring(start, Math.min(end, start + 15000));

    // Title: inside <h2> tag
    const h2Match = block.match(/<h2[^>]*>(.*?)<\/h2>/s);
    if (!h2Match) continue;
    const title = stripTags(h2Match[1]);
    if (
      !title ||
      title.length < 5 ||
      /^(次に移動|結果|その他|キーボード|検索結果)/.test(title)
    )
      continue;

    // Price: first a-offscreen inside a-price
    const priceMatch = block.match(
      /<span class="a-price"[^>]*><span class="a-offscreen">(.*?)<\/span>/
    );
    const price = priceMatch ? decodeEntities(priceMatch[1]) : null;

    // Rating
    const ratingMatch = block.match(
      /aria-label="5つ星のうち([\d.]+)"/
    );
    const rating = ratingMatch ? ratingMatch[1] : null;

    // Review count
    const reviewMatch = block.match(
      /aria-label="([\d,]+)件のレビュー"/
    );
    const reviews = reviewMatch ? reviewMatch[1] : null;

    products.push({
      platform: "Amazon JP",
      title: title.substring(0, 120),
      price,
      url: `https://www.amazon.co.jp/dp/${asin}`,
      rating,
      reviews,
    });
  }

  return products;
}

/* ================================================================== */
/*  Rakuten Scraper                                                    */
/*  WARP SOCKS5 → HTML scraping with JSON-LD structured data           */
/* ================================================================== */

async function scrapeRakuten(keyword: string, limit = 8): Promise<Product[]> {
  const path = `/search/mall/${encodeURIComponent(keyword)}/`;
  const res = await socks5HttpsGet("search.rakuten.co.jp", path);

  if (res.status !== 200 || res.data.length < 1000) return [];

  const html = res.data;
  const products: Product[] = [];

  // Extract JSON-LD structured data
  const jsonLdMatch = html.match(
    /application\/ld\+json[^>]*>(.*?)<\/script>/s
  );
  if (!jsonLdMatch) return [];

  try {
    const data = JSON.parse(jsonLdMatch[1]);
    const items = data.itemListElement || [];

    for (
      let i = 0;
      i < items.length && products.length < limit;
      i++
    ) {
      const item = items[i];
      const prod = item.item || item;
      const name = (prod.name || "").trim();
      if (!name) continue;

      const price = prod.offers?.price;
      const url = (prod.url || "").split("?")[0]; // Clean tracking params
      const rating = prod.aggregateRating?.ratingValue;
      const reviewCount = prod.aggregateRating?.reviewCount;

      products.push({
        platform: "楽天市場",
        title: name.substring(0, 120),
        price: price != null ? `￥${Number(price).toLocaleString()}` : null,
        url: url || `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/`,
        rating: rating != null ? String(rating) : null,
        reviews: reviewCount != null ? String(reviewCount) : null,
      });
    }
  } catch {
    // JSON parse failed — fall back to no results
  }

  return products;
}

/* ================================================================== */
/*  Platform definitions (for search URL generation)                   */
/* ================================================================== */

interface ShopPlatform {
  id: string;
  name: string;
  nameJa: string;
  icon: string;
  searchUrl: (keyword: string) => string;
  category: string;
  scrapable: boolean;
}

const PLATFORMS: ShopPlatform[] = [
  {
    id: "amazon_jp",
    name: "Amazon JP",
    nameJa: "Amazon.co.jp",
    icon: "🛒",
    searchUrl: (kw) =>
      `https://www.amazon.co.jp/s?k=${encodeURIComponent(kw)}`,
    category: "综合",
    scrapable: true,
  },
  {
    id: "rakuten",
    name: "Rakuten",
    nameJa: "楽天市場",
    icon: "🏪",
    searchUrl: (kw) =>
      `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(kw)}/`,
    category: "综合",
    scrapable: true,
  },
  {
    id: "mercari",
    name: "Mercari",
    nameJa: "メルカリ",
    icon: "🤝",
    searchUrl: (kw) =>
      `https://jp.mercari.com/search?keyword=${encodeURIComponent(kw)}`,
    category: "个人闲置(C2C)",
    scrapable: false,
  },
  {
    id: "surugaya",
    name: "Suruga-ya",
    nameJa: "駿河屋",
    icon: "📦",
    searchUrl: (kw) =>
      `https://www.suruga-ya.jp/search?category=&search_word=${encodeURIComponent(kw)}`,
    category: "中古",
    scrapable: false,
  },
  {
    id: "animate",
    name: "Animate",
    nameJa: "アニメイト",
    icon: "🎌",
    searchUrl: (kw) =>
      `https://www.animate-onlineshop.jp/products/list.php?mode=search&keyword=${encodeURIComponent(kw)}`,
    category: "新品(ACG)",
    scrapable: false,
  },
];

/* ---- Platform resolver ---- */

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

/* ---- Scrape dispatcher ---- */

async function scrapePlatform(
  platformId: string,
  keyword: string,
  limit: number
): Promise<Product[]> {
  switch (platformId) {
    case "amazon_jp":
      return scrapeAmazonJP(keyword, limit);
    case "rakuten":
      return scrapeRakuten(keyword, limit);
    default:
      return [];
  }
}

/* ---- Result text helper ---- */

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

function formatProduct(p: Product, idx: number): string {
  let line = `${idx}. 【${p.platform}】${p.title}`;
  if (p.price) line += `\n   价格: ${p.price}`;
  if (p.rating) {
    line += `  ★${p.rating}`;
    if (p.reviews) line += `(${p.reviews}条评价)`;
  }
  line += `\n   ${p.url}`;
  return line;
}

/* ==================================================================== */

const plugin = {
  id: "jp-shopping",
  name: "JP Shopping",
  description:
    "日本电商搜索 — Amazon JP/楽天/Mercari/駿河屋/Animate 比价查询",

  register(api: OpenClawPluginApi) {
    /* ================================================================ */
    /* Tool 1: jp_search — cross-platform product search                */
    /* ================================================================ */
    api.registerTool({
      name: "jp_search",
      label: "日本电商搜索",
      description: `在日本电商平台搜索商品。直接抓取 Amazon JP 和乐天的商品数据（标题、价格、链接），并提供 Mercari/骏河屋/Animate 的搜索直链。
支持平台：Amazon JP（日亚）、楽天（乐天）、駿河屋（骏河屋）、メルカリ（Mercari/煤炉）、アニメイト（Animate）。

使用场景：
- "在日本买高达模型哪里便宜"
- "骏河屋搜一下初音未来手办"
- "日亚上这个多少钱"
- "帮我搜一下日本的XX商品"
- "日本代购XX多少钱"

关键词建议使用日文/英文，如 ガンダム、hatsune miku figure。`,
      parameters: Type.Object({
        keyword: Type.String({
          description:
            "搜索关键词（日文/英文效果最佳，如 ガンダム、hatsune miku figure）",
        }),
        platform: Type.Optional(
          Type.String({
            description:
              "指定平台（amazon/rakuten/surugaya/mercari/animate 或中文别名）。不指定则搜索全部平台",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const keyword = String(params.keyword || "").trim();
        if (!keyword) return text("请提供搜索关键词");

        /* Determine which platforms to search */
        let platforms: ShopPlatform[];
        if (params.platform) {
          const p = resolvePlatform(String(params.platform));
          if (!p)
            return text(
              `未知平台 "${params.platform}"。支持：amazon/rakuten/surugaya/mercari/animate`
            );
          platforms = [p];
        } else {
          platforms = PLATFORMS;
        }

        /* Generate search URLs for all platforms */
        const searchLinks = platforms
          .map((p) => `${p.icon} ${p.nameJa} (${p.category}): ${p.searchUrl(keyword)}`)
          .join("\n");

        /* Scrape scrapable platforms in parallel */
        const scrapable = platforms.filter((p) => p.scrapable);
        let allProducts: Product[] = [];

        if (scrapable.length > 0) {
          const results = await Promise.allSettled(
            scrapable.map((p) => scrapePlatform(p.id, keyword, 6))
          );
          for (const r of results) {
            if (r.status === "fulfilled") {
              allProducts = allProducts.concat(r.value);
            }
          }
        }

        /* Format output */
        let output = `🔍 "${keyword}" 日本电商搜索结果\n\n`;

        if (allProducts.length > 0) {
          output += `📦 搜索到 ${allProducts.length} 件商品:\n\n`;
          allProducts.forEach((p, i) => {
            output += formatProduct(p, i + 1) + "\n\n";
          });
        } else {
          output += "⚠️ 未能从可抓取平台获取商品数据，请点击下方搜索链接直接查看。\n\n";
        }

        output += `🔗 各平台搜索直链:\n${searchLinks}\n\n`;

        // Note which platforms have no scraping
        const unscrape = platforms.filter((p) => !p.scrapable);
        if (unscrape.length > 0) {
          output += `💡 ${unscrape.map((p) => p.nameJa).join("、")} 暂不支持自动抓取，请点击链接查看。\n`;
        }

        output += "\n数据来源：Amazon.co.jp / 楽天市場（直接抓取）";

        return text(output);
      },
    });

    /* ================================================================ */
    /* Tool 2: jp_price_compare — quick price comparison                */
    /* ================================================================ */
    api.registerTool({
      name: "jp_price_compare",
      label: "日本比价",
      description: `对比商品在 Amazon JP 和乐天市场的价格。直接抓取两大平台的商品数据进行比较，并提供其他平台搜索链接。

使用场景：
- "这个手办在日本各平台分别多少钱"
- "对比一下日亚和乐天上的价格"
- "找日本最便宜的渠道买XX"`,
      parameters: Type.Object({
        keyword: Type.String({
          description: "商品关键词（尽量精确，如型号/品名）",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const keyword = String(params.keyword || "").trim();
        if (!keyword) return text("请提供商品关键词");

        /* Scrape Amazon + Rakuten in parallel */
        const [amazonResult, rakutenResult] = await Promise.allSettled([
          scrapeAmazonJP(keyword, 5),
          scrapeRakuten(keyword, 5),
        ]);

        const amazonProducts =
          amazonResult.status === "fulfilled" ? amazonResult.value : [];
        const rakutenProducts =
          rakutenResult.status === "fulfilled" ? rakutenResult.value : [];

        let output = `💰 "${keyword}" 日本比价结果\n\n`;

        // Amazon section
        output += `🛒 Amazon.co.jp:\n`;
        if (amazonProducts.length > 0) {
          for (const p of amazonProducts) {
            const r = p.rating ? ` ★${p.rating}` : "";
            const rv = p.reviews ? `(${p.reviews}条评价)` : "";
            output += `  · ${p.title.substring(0, 60)}\n    ${p.price || "价格未知"}${r}${rv}\n    ${p.url}\n`;
          }
        } else {
          output += `  未获取到商品数据\n`;
        }

        output += `\n🏪 楽天市場:\n`;
        if (rakutenProducts.length > 0) {
          for (const p of rakutenProducts) {
            const r = p.rating ? ` ★${p.rating}` : "";
            const rv = p.reviews ? `(${p.reviews}条评价)` : "";
            output += `  · ${p.title.substring(0, 60)}\n    ${p.price || "价格未知"}${r}${rv}\n    ${p.url}\n`;
          }
        } else {
          output += `  未获取到商品数据\n`;
        }

        // Price comparison summary
        const allPrices: { platform: string; price: number; title: string }[] =
          [];
        for (const p of [...amazonProducts, ...rakutenProducts]) {
          if (p.price) {
            const numStr = p.price.replace(/[^\d]/g, "");
            const num = parseInt(numStr, 10);
            if (num > 0 && num < 10_000_000) {
              allPrices.push({
                platform: p.platform,
                price: num,
                title: p.title.substring(0, 40),
              });
            }
          }
        }

        if (allPrices.length >= 2) {
          allPrices.sort((a, b) => a.price - b.price);
          const cheapest = allPrices[0];
          output += `\n📊 最低价: ￥${cheapest.price.toLocaleString()} @ ${cheapest.platform}\n`;
          output += `   "${cheapest.title}"\n`;
        }

        // Other platform links
        output += `\n🔗 其他平台:\n`;
        for (const p of PLATFORMS.filter((p) => !p.scrapable)) {
          output += `  ${p.icon} ${p.nameJa}: ${p.searchUrl(keyword)}\n`;
        }

        output += `\n💡 价格仅供参考，以各平台实际页面为准。\n`;
        output += `数据来源：Amazon.co.jp / 楽天市場（直接抓取）`;

        return text(output);
      },
    });

    console.log(
      "[jp-shopping] Registered jp_search + jp_price_compare (v2 direct scraping)"
    );
  },
};

export default plugin;
