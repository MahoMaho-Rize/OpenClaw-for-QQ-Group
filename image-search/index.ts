import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Image Search Plugin                                                */
/*  Searches for images via Bing & Yandex Image Search (scraping)      */
/*  Returns image URLs that can be sent as [CQ:image] in QQ            */
/* ------------------------------------------------------------------ */

const BING_BASE = "https://cn.bing.com";
const YANDEX_BASE = "https://yandex.ru";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 15_000;

/* ---- HTTP helper (IPv4) ---- */

interface HttpResponse {
  status: number;
  data: string;
  url: string;
}

function httpGet(
  url: string,
  opts: { timeout?: number; maxRedirects?: number; headers?: Record<string, string> } = {}
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
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ru;q=0.7",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Encoding": "gzip, deflate",
            ...(opts.headers || {}),
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

/* ---- HTML entity decoding ---- */

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

/* ---- Unified image result ---- */

interface ImageResult {
  title: string;
  image_url: string;
  thumbnail_url: string;
  width?: number;
  height?: number;
  source?: string;
}

/* ==================================================================== */
/*  Bing Image Search                                                   */
/* ==================================================================== */

function parseBingImageResults(html: string): ImageResult[] {
  const results: ImageResult[] = [];

  // Pattern 1: m="" attribute in <a class="iusc"> containing JSON with murl
  const mAttrRegex = /class="iusc"[^>]*m="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = mAttrRegex.exec(html)) !== null) {
    try {
      const decoded = decodeHtmlEntities(match[1]);
      const data = JSON.parse(decoded);
      if (data.murl) {
        results.push({
          title: data.t || "",
          image_url: data.murl,
          thumbnail_url: data.turl || "",
          width: data.mw || undefined,
          height: data.mh || undefined,
          source: data.desc || "",
        });
      }
    } catch { /* skip */ }
  }

  // Pattern 2: data-m attribute (newer Bing layout)
  if (results.length === 0) {
    const dataMRegex = /data-m="([^"]*)"/g;
    while ((match = dataMRegex.exec(html)) !== null) {
      try {
        const decoded = decodeHtmlEntities(match[1]);
        const data = JSON.parse(decoded);
        if (data.murl) {
          results.push({
            title: data.t || data.desc || "",
            image_url: data.murl,
            thumbnail_url: data.turl || "",
            width: data.mw || undefined,
            height: data.mh || undefined,
            source: data.purl ? new URL(data.purl).hostname : "",
          });
        }
      } catch { /* skip */ }
    }
  }

  // Pattern 3: img.mimg tags
  if (results.length === 0) {
    const imgRegex = /<img[^>]*class="[^"]*mimg[^"]*"[^>]*src="([^"]+)"[^>]*>/g;
    while ((match = imgRegex.exec(html)) !== null) {
      const thumbUrl = decodeHtmlEntities(match[1]);
      if (thumbUrl.startsWith("http")) {
        results.push({
          title: "",
          image_url: thumbUrl,
          thumbnail_url: thumbUrl,
        });
      }
    }
  }

  return results;
}

async function searchBing(query: string, count: number, size?: string): Promise<ImageResult[]> {
  let searchUrl = `${BING_BASE}/images/search?q=${encodeURIComponent(query)}&count=${Math.min(count * 2, 50)}&FORM=HDRSC2`;

  if (size) {
    const sizeMap: Record<string, string> = {
      small: "filterui:imagesize-small",
      medium: "filterui:imagesize-medium",
      large: "filterui:imagesize-large",
      wallpaper: "filterui:imagesize-wallpaper",
    };
    if (sizeMap[size]) {
      searchUrl += `&qft=+${sizeMap[size]}`;
    }
  }

  const res = await httpGet(searchUrl);
  if (res.status !== 200) {
    throw new Error(`Bing HTTP ${res.status}`);
  }

  return parseBingImageResults(res.data)
    .filter((r) => r.image_url && r.image_url.startsWith("http"))
    .slice(0, count);
}

/* ==================================================================== */
/*  Yandex Image Search (keyword-based, NOT reverse image)              */
/* ==================================================================== */

function parseYandexImageResults(html: string): ImageResult[] {
  const results: ImageResult[] = [];

  // Yandex Images stores data in data-bem or serp-item__link JSON blobs
  // Pattern 1: serp-item with data-bem containing image info
  const serpItemRegex = /data-bem='(\{[^']*?"serp-item"[^']*?\})'/g;
  let match: RegExpExecArray | null;

  while ((match = serpItemRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const item = data["serp-item"];
      if (item) {
        const preview = item.preview?.[0];
        const imgUrl = preview?.url || item.img_href || item.origImg?.url;
        const thumb = item.thumb?.url || preview?.url;
        if (imgUrl) {
          // Ensure absolute URL
          const absUrl = imgUrl.startsWith("//") ? `https:${imgUrl}` : imgUrl;
          const absThumb = thumb ? (thumb.startsWith("//") ? `https:${thumb}` : thumb) : "";
          results.push({
            title: item.snippet?.title || item.title || "",
            image_url: absUrl,
            thumbnail_url: absThumb,
            width: preview?.w || item.origImg?.w || undefined,
            height: preview?.h || item.origImg?.h || undefined,
            source: item.snippet?.domain || item.source || "",
          });
        }
      }
    } catch { /* skip */ }
  }

  // Pattern 2: data-state with initialState containing image data
  if (results.length === 0) {
    const dataStateRegex = /data-state="([^"]*)"/g;
    while ((match = dataStateRegex.exec(html)) !== null) {
      try {
        const decoded = decodeHtmlEntities(match[1]);
        if (!decoded.includes("initialState")) continue;
        const obj = JSON.parse(decoded);
        const state = obj.initialState;
        if (!state) continue;

        // Try to get images from search results in state
        const serpList = state.serpList?.items?.entities || {};
        for (const key of Object.keys(serpList)) {
          const entity = serpList[key];
          if (!entity) continue;
          const origUrl = entity.origUrl || entity.viewerData?.dups?.[0]?.origUrl;
          const thumb = entity.thumbUrl || entity.viewerData?.dups?.[0]?.thumbUrl;
          if (origUrl) {
            results.push({
              title: entity.snippet?.title || entity.alt || "",
              image_url: origUrl.startsWith("//") ? `https:${origUrl}` : origUrl,
              thumbnail_url: thumb ? (thumb.startsWith("//") ? `https:${thumb}` : thumb) : "",
              width: entity.origWidth || entity.width || undefined,
              height: entity.origHeight || entity.height || undefined,
              source: entity.snippet?.domain || entity.sourceDomain || "",
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  // Pattern 3: simple regex fallback — extract origUrl from JSON-like blobs
  if (results.length === 0) {
    const origUrlRegex = /"origUrl"\s*:\s*"(https?:\/\/[^"]+)"/g;
    const seen = new Set<string>();
    while ((match = origUrlRegex.exec(html)) !== null) {
      const url = match[1];
      if (!seen.has(url) && !url.includes("yandex") && !url.includes("avatars.mds")) {
        seen.add(url);
        results.push({
          title: "",
          image_url: url,
          thumbnail_url: "",
        });
      }
    }
  }

  return results;
}

async function searchYandex(query: string, count: number, size?: string): Promise<ImageResult[]> {
  let searchUrl = `${YANDEX_BASE}/images/search?text=${encodeURIComponent(query)}&noreask=1`;

  if (size) {
    const sizeMap: Record<string, string> = {
      small: "small",
      medium: "medium",
      large: "large",
      wallpaper: "wallpaper",
    };
    if (sizeMap[size]) {
      searchUrl += `&isize=${sizeMap[size]}`;
    }
  }

  const res = await httpGet(searchUrl, {
    headers: {
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      Referer: "https://yandex.ru/images/",
    },
  });

  if (res.status !== 200) {
    throw new Error(`Yandex HTTP ${res.status}`);
  }

  return parseYandexImageResults(res.data)
    .filter((r) => r.image_url && r.image_url.startsWith("http"))
    .slice(0, count);
}

/* ==================================================================== */
/*  Plugin entry                                                        */
/* ==================================================================== */

const plugin = {
  id: "image-search",
  name: "Image Search",
  description: "通过Bing/Yandex图片搜索找图，返回图片URL可直接发送到QQ",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "image_search",
      label: "图片搜索",
      description: `通过 Bing 或 Yandex 图片搜索找图片。返回图片的直链URL。
支持两个搜索引擎，各有优势：
- **bing**: 适合通用搜索、中文关键词，国内可直连
- **yandex**: 适合动漫/二次元角色、插画，俄系搜索引擎对 ACG 内容覆盖好
- **both**: 同时搜两个引擎，去重后合并结果（推荐用于找不到图的情况）

**重要**：搜索到图片后，你应该直接把图片URL用 Markdown 图片格式 ![描述](URL) 发给用户，系统会自动将其转换为QQ图片消息发送。每张图片单独一行。绝对不要把图片URL以纯文本形式暴露给用户。

**ACG角色/人物找图工作流**（必须遵循）：
当用户要求搜索特定动漫/游戏/东方Project等ACG角色的图片时，你必须先使用以下工具确认角色信息，再来搜图：
1. 先用 moegirl（萌娘百科）或 thbwiki（东方Wiki）或 bangumi 或 fandom 搜索该角色
2. 从搜索结果中确认角色的：正式名称（中/日/英）、所属作品、外貌特征等
3. 用确认后的准确名称（建议用日文或英文原名）作为 query 调用本工具搜图
4. 二次元角色搜图建议使用 source=yandex 或 source=both
例如：用户说"找一张灵梦的图" → 先用 thbwiki 搜索"博丽灵梦" → 确认是东方Project角色 → 用 "博麗霊夢 touhou" 作为 query, source=yandex 搜图

使用场景：
- 用户说"找一张xxx的图"、"搜一下xxx图片"
- 用户想看某个角色、场景、物品的图片
- 用户要求发送特定主题的图片`,
      parameters: Type.Object({
        query: Type.String({
          description: "图片搜索关键词，中英文均可",
        }),
        source: Type.Optional(
          Type.Union(
            [
              Type.Literal("bing"),
              Type.Literal("yandex"),
              Type.Literal("both"),
            ],
            {
              description:
                "搜索引擎：bing（默认）、yandex、both（同时搜索两个引擎）。二次元/ACG 内容推荐 yandex 或 both。",
            }
          )
        ),
        count: Type.Optional(
          Type.Number({
            description: "返回图片数量（默认5，最大20）",
          })
        ),
        size: Type.Optional(
          Type.Union(
            [
              Type.Literal("small"),
              Type.Literal("medium"),
              Type.Literal("large"),
              Type.Literal("wallpaper"),
            ],
            { description: "图片尺寸筛选" }
          )
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const query = params.query as string | undefined;
        if (!query || !query.trim()) {
          return { error: "需要提供 query 参数（搜索关键词）" };
        }

        const trimmedQuery = query.trim();
        const count = Math.min(Math.max(Number(params.count) || 5, 1), 20);
        const size = params.size as string | undefined;
        const source = (params.source as string) || "bing";

        const allResults: ImageResult[] = [];
        const errors: string[] = [];
        const seenUrls = new Set<string>();

        function dedup(items: ImageResult[]): ImageResult[] {
          const out: ImageResult[] = [];
          for (const r of items) {
            if (!seenUrls.has(r.image_url)) {
              seenUrls.add(r.image_url);
              out.push(r);
            }
          }
          return out;
        }

        // Search Bing
        if (source === "bing" || source === "both") {
          try {
            const bingResults = await searchBing(trimmedQuery, source === "both" ? Math.ceil(count * 0.6) : count, size);
            allResults.push(...dedup(bingResults));
            console.log(`[image-search] Bing "${trimmedQuery}" → ${bingResults.length} results`);
          } catch (err) {
            const msg = `Bing 搜索失败: ${String(err)}`;
            errors.push(msg);
            console.warn(`[image-search] ${msg}`);
          }
        }

        // Search Yandex
        if (source === "yandex" || source === "both") {
          try {
            const yandexResults = await searchYandex(trimmedQuery, source === "both" ? Math.ceil(count * 0.6) : count, size);
            allResults.push(...dedup(yandexResults));
            console.log(`[image-search] Yandex "${trimmedQuery}" → ${yandexResults.length} results`);
          } catch (err) {
            const msg = `Yandex 搜索失败: ${String(err)}`;
            errors.push(msg);
            console.warn(`[image-search] ${msg}`);
          }
        }

        // Trim to count
        const finalResults = allResults.slice(0, count);

        if (finalResults.length === 0) {
          return {
            query: trimmedQuery,
            source,
            results: [],
            message: errors.length > 0
              ? `未找到图片。错误: ${errors.join("; ")}`
              : "未找到相关图片",
          };
        }

        return {
          query: trimmedQuery,
          source,
          result_count: finalResults.length,
          results: finalResults.map((r, i) => ({
            index: i + 1,
            title: r.title || "无标题",
            image_url: r.image_url,
            thumbnail_url: r.thumbnail_url || undefined,
            dimensions: r.width && r.height ? `${r.width}x${r.height}` : undefined,
            from: r.source || undefined,
          })),
          ...(errors.length > 0 ? { warnings: errors } : {}),
          hint: "将 image_url 以 Markdown 图片格式 ![title](image_url) 发送给用户，系统会自动转为QQ图片。",
        };
      },
    });

    console.log("[image-search] Registered image_search tool (Bing + Yandex Images, IPv4)");
  },
};

export default plugin;
