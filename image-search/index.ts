import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Image Search Plugin                                                */
/*  Searches for images via Bing Image Search (cn.bing.com scraping)   */
/*  Returns image URLs that can be sent as [CQ:image] in QQ            */
/* ------------------------------------------------------------------ */

const BING_BASE = "https://cn.bing.com";
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

/* ---- Image result parsing ---- */

interface ImageResult {
  title: string;
  thumbnail_url: string;
  source_url: string;
  width?: number;
  height?: number;
  host?: string;
}

function parseBingImageResults(html: string): ImageResult[] {
  const results: ImageResult[] = [];

  // Bing Images puts image data in JSON blobs within data attributes
  // Pattern 1: m="" attribute in <a> tags containing JSON with murl (media URL)
  const mAttrRegex = /class="iusc"[^>]*m="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = mAttrRegex.exec(html)) !== null) {
    try {
      const decoded = decodeHtmlEntities(match[1]);
      const data = JSON.parse(decoded);
      if (data.murl) {
        results.push({
          title: data.t || "",
          thumbnail_url: data.turl || "",
          source_url: data.murl,
          width: data.mw || undefined,
          height: data.mh || undefined,
          host: data.desc || "",
        });
      }
    } catch { /* skip parse errors */ }
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
            thumbnail_url: data.turl || "",
            source_url: data.murl,
            width: data.mw || undefined,
            height: data.mh || undefined,
            host: data.purl ? new URL(data.purl).hostname : "",
          });
        }
      } catch { /* skip */ }
    }
  }

  // Pattern 3: Extract from img tags with src pointing to Bing thumbnail
  if (results.length === 0) {
    const imgRegex = /<img[^>]*class="[^"]*mimg[^"]*"[^>]*src="([^"]+)"[^>]*>/g;
    while ((match = imgRegex.exec(html)) !== null) {
      const thumbUrl = decodeHtmlEntities(match[1]);
      if (thumbUrl.startsWith("http")) {
        results.push({
          title: "",
          thumbnail_url: thumbUrl,
          source_url: thumbUrl,
        });
      }
    }
  }

  return results;
}

/* ---- Plugin entry ---- */

const plugin = {
  id: "image-search",
  name: "Image Search",
  description: "通过Bing图片搜索找图，返回图片URL可直接发送到QQ",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "image_search",
      label: "图片搜索",
      description: `通过 Bing 图片搜索找图片。返回图片的直链URL。

**重要**：搜索到图片后，你应该直接把图片URL用 Markdown 图片格式 ![描述](URL) 发给用户，系统会自动将其转换为QQ图片消息发送。每张图片单独一行。

参数说明：
- query: 搜索关键词（必填），支持中英文
- count: 返回数量（默认5，最大20）
- size: 图片尺寸筛选 - small/medium/large/wallpaper（可选）

使用场景：
- 用户说"找一张xxx的图"、"搜一下xxx图片"
- 用户想看某个角色、场景、物品的图片
- 用户要求发送特定主题的图片`,
      parameters: Type.Object({
        query: Type.String({
          description: "图片搜索关键词，中英文均可",
        }),
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

        const count = Math.min(Math.max(Number(params.count) || 5, 1), 20);
        const size = params.size as string | undefined;

        // Build Bing Image search URL
        let searchUrl = `${BING_BASE}/images/search?q=${encodeURIComponent(query.trim())}&count=${Math.min(count * 2, 50)}&FORM=HDRSC2`;

        // Add size filter
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

        try {
          const res = await httpGet(searchUrl);
          if (res.status !== 200) {
            return { error: `Bing 返回 HTTP ${res.status}`, query };
          }

          const allResults = parseBingImageResults(res.data);
          if (allResults.length === 0) {
            return { query, results: [], message: "未找到相关图片" };
          }

          // Filter to requested count, prefer results with valid source URLs
          const results = allResults
            .filter((r) => r.source_url && r.source_url.startsWith("http"))
            .slice(0, count);

          console.log(`[image-search] "${query}" → ${allResults.length} raw, ${results.length} returned`);

          return {
            query,
            result_count: results.length,
            results: results.map((r, i) => ({
              index: i + 1,
              title: r.title || "无标题",
              image_url: r.source_url,
              thumbnail_url: r.thumbnail_url || undefined,
              dimensions: r.width && r.height ? `${r.width}x${r.height}` : undefined,
              source: r.host || undefined,
            })),
            hint: "将 image_url 以 Markdown 图片格式 ![title](image_url) 发送给用户，系统会自动转为QQ图片。",
          };
        } catch (err) {
          return { error: `图片搜索失败: ${String(err)}`, query };
        }
      },
    });

    console.log("[image-search] Registered image_search tool (Bing Images, IPv4)");
  },
};

export default plugin;
