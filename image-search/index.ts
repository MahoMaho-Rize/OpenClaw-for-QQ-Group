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
const DANBOORU_BASE = "https://danbooru.donmai.us";
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
/*  Danbooru Image Search (booru tag-based, best for ACG characters)    */
/* ==================================================================== */

interface DanbooruPost {
  id: number;
  file_url?: string;
  large_file_url?: string;
  preview_file_url?: string;
  tag_string: string;
  tag_string_character: string;
  tag_string_copyright: string;
  tag_string_artist: string;
  image_width: number;
  image_height: number;
  source: string;
  rating: string; // g=general, s=sensitive, q=questionable, e=explicit
  file_ext: string;
}

interface DanbooruTag {
  name: string;
  post_count: number;
  category: number; // 0=general, 1=artist, 3=copyright, 4=character, 5=meta
}

/** Use Danbooru autocomplete to find matching tags for a query string */
async function danbooruAutocompleteTags(query: string): Promise<DanbooruTag[]> {
  const url = `${DANBOORU_BASE}/autocomplete.json?search[query]=${encodeURIComponent(query)}&search[type]=tag_query&limit=10`;
  const res = await httpGet(url, { timeout: 10_000 });
  if (res.status !== 200) return [];
  try {
    const arr = JSON.parse(res.data);
    if (!Array.isArray(arr)) return [];
    return arr.map((item: any) => ({
      name: String(item.value || item.label || ""),
      post_count: item.post_count || 0,
      category: item.category || 0,
    })).filter((t: DanbooruTag) => t.name);
  } catch {
    return [];
  }
}

/** Search Danbooru posts by tags. No rating filter — all content returned. */
async function danbooruSearchPosts(tags: string, count: number, page: number = 1): Promise<DanbooruPost[]> {
  const url = `${DANBOORU_BASE}/posts.json?tags=${encodeURIComponent(tags)}&limit=${count}&page=${page}`;
  const res = await httpGet(url, { timeout: 15_000 });
  if (res.status !== 200) return [];
  try {
    const arr = JSON.parse(res.data);
    if (!Array.isArray(arr)) return [];
    return arr as DanbooruPost[];
  } catch {
    return [];
  }
}

/**
 * High-level Danbooru search:
 * 1. Autocomplete each query token to find valid booru tags
 * 2. Search posts using the resolved tags (rating:general,sensitive only)
 * Returns ImageResult[] for consistency with other engines.
 */
async function searchDanbooru(query: string, count: number): Promise<ImageResult[]> {
  // Split query into tokens; try to resolve each to a valid tag
  const tokens = query.split(/[\s,+]+/).filter(Boolean);

  // Strategy: try the full query as a single autocomplete first
  // (works well for romaji names like "hakurei_reimu")
  let resolvedTags: string[] = [];

  // First, try the full query (in case it's already a booru tag like "hakurei_reimu")
  const fullAc = await danbooruAutocompleteTags(query.replace(/\s+/g, "_"));
  if (fullAc.length > 0) {
    // Pick the best match (highest post count, first result)
    resolvedTags.push(fullAc[0].name);
  }

  // If full query didn't match, try each token individually
  if (resolvedTags.length === 0) {
    for (const token of tokens) {
      if (token.length < 2) continue;
      const ac = await danbooruAutocompleteTags(token);
      if (ac.length > 0) {
        // Only add the first (best) match per token
        const bestTag = ac[0].name;
        if (!resolvedTags.includes(bestTag)) {
          resolvedTags.push(bestTag);
        }
      }
    }
  }

  if (resolvedTags.length === 0) {
    console.log(`[image-search] Danbooru: no valid tags found for "${query}"`);
    return [];
  }

  // Danbooru free tier: max 2 tags per search. Keep the most specific ones.
  // Character tags (cat 4) > copyright (cat 3) > general (cat 0)
  const searchTags = resolvedTags.slice(0, 2).join(" ");
  console.log(`[image-search] Danbooru: resolved tags "${searchTags}" from query "${query}"`);

  // Fetch a random page for variety (pages 1-5)
  const randomPage = Math.floor(Math.random() * 5) + 1;
  const posts = await danbooruSearchPosts(searchTags, count * 2, randomPage);

  // Shuffle for variety
  for (let i = posts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [posts[i], posts[j]] = [posts[j], posts[i]];
  }

  return posts
    .filter((p) => (p.file_url || p.large_file_url) && p.file_ext !== "zip" && p.file_ext !== "mp4")
    .slice(0, count)
    .map((p) => {
      const charTags = p.tag_string_character ? p.tag_string_character.split(" ").slice(0, 3).join(", ") : "";
      const copyrightTags = p.tag_string_copyright ? p.tag_string_copyright.split(" ").slice(0, 2).join(", ") : "";
      const artistTag = p.tag_string_artist ? p.tag_string_artist.split(" ")[0] : "";
      const titleParts = [charTags, copyrightTags, artistTag ? `by ${artistTag}` : ""].filter(Boolean);
      return {
        title: titleParts.join(" | ") || (p.tag_string || "").split(" ").slice(0, 5).join(", "),
        image_url: p.large_file_url || p.file_url || "",
        thumbnail_url: p.preview_file_url || "",
        width: p.image_width || undefined,
        height: p.image_height || undefined,
        source: `danbooru #${p.id}`,
      };
    });
}

/* ==================================================================== */
/*  Plugin entry                                                        */
/* ==================================================================== */

const plugin = {
  id: "image-search",
  name: "Image Search",
  description: "通过Danbooru/Bing/Yandex图片搜索找图，返回图片URL可直接发送到QQ",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "image_search",
      label: "图片搜索",
      description: `图片搜索工具。二次元/ACG角色图片首选 source=danbooru；真人/风景/通用图片用 source=bing。返回图片直链URL。
支持三个搜索引擎，各有优势：
- **danbooru**: 二次元角色图片专用。最大的 Booru 风格图库，用英文/罗马字 tag 搜索（如 hakurei_reimu, akiyama_mizuki）。图片质量极高、标签精确、包含所有评级内容。**ACG 角色首选**。
- **bing**: 适合通用搜索、真人、中文关键词，国内可直连
- **yandex**: 适合动漫/二次元角色、插画，俄系搜索引擎对 ACG 内容覆盖好
- **both**: 同时搜 Bing + Yandex 两个引擎，去重后合并结果

**重要**：搜索到图片后，你应该直接把图片URL用 Markdown 图片格式 ![描述](URL) 发给用户，系统会自动将其转换为QQ图片消息发送。每张图片单独一行。绝对不要把图片URL以纯文本形式暴露给用户。

**ACG角色/人物找图工作流**（必须遵循）：
当用户要求搜索特定动漫/游戏/东方Project/BanG Dream/Love Live/Project SEKAI 等ACG角色的图片时：
1. 先用 moegirl（萌娘百科）或 thbwiki（东方Wiki）或 bangumi 或 fandom 搜索该角色
2. 从搜索结果中确认角色的：正式名称（中/日/英）、所属作品
3. **优先使用 source=danbooru**，query 用角色的英文/罗马字名（姓_名 格式，如 aoba_sayo、toyokawa_fuuka、akiyama_mizuki、hakurei_reimu）。Danbooru 自动补全会匹配最接近的 tag。注意：Danbooru 免费版每次搜索最多2个 tag。
4. 如果 Danbooru 返回结果为空或不满意，再用 source=yandex 或 source=both 补充搜索
例如：用户说"找一张灵梦的图" → 先用 thbwiki 搜索"博丽灵梦" → 确认是东方Project角色 → 用 "hakurei_reimu" 作为 query, source=danbooru 搜图
例如：用户说"找晓山瑞希的图" → 先用 moegirl 确认是 Project SEKAI 角色 → 英文名 Akiyama Mizuki → 用 "akiyama_mizuki" 作为 query, source=danbooru 搜图

**非 ACG 角色**（真人、风景、物品等）不要用 danbooru，用 bing 即可。

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
              Type.Literal("danbooru"),
              Type.Literal("bing"),
              Type.Literal("yandex"),
              Type.Literal("both"),
            ],
            {
              description:
                "搜索引擎：danbooru（ACG角色首选，用英文/罗马字tag，最多2个tag）、bing（通用/真人/中文）、yandex（二次元补充）、both（Bing+Yandex合并）。",
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

        // Search Danbooru
        if (source === "danbooru") {
          try {
            const dbResults = await searchDanbooru(trimmedQuery, count);
            allResults.push(...dedup(dbResults));
            console.log(`[image-search] Danbooru "${trimmedQuery}" → ${dbResults.length} results`);
          } catch (err) {
            const msg = `Danbooru 搜索失败: ${String(err)}`;
            errors.push(msg);
            console.warn(`[image-search] ${msg}`);
          }
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

    console.log("[image-search] Registered image_search tool (Danbooru + Bing + Yandex Images, IPv4)");
  },
};

export default plugin;
