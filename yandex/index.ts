import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/*  Yandex Reverse Image Search Plugin                                 */
/*  Upload image → Yandex CBIR → tags + matching sites                 */
/*  Useful for identifying characters, artwork, objects, locations     */
/* ------------------------------------------------------------------ */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 25_000;

/* ---- HTTP helpers ---- */

interface HttpResponse {
  status: number;
  data: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  finalUrl: string;
}

function httpGetBuffer(
  url: string,
  opts: { timeout?: number } = {}
): Promise<{ status: number; data: Buffer }> {
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function doReq(u: string) {
      const parsed = new URL(u);
      const isHttps = parsed.protocol === "https:";
      const mod = isHttps ? https : http;
      const req = mod.get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          port: parsed.port || (isHttps ? 443 : 80),
          family: 4,
          timeout,
          headers: { "User-Agent": USER_AGENT },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (++redirects > 5) {
              reject(new Error("Too many redirects"));
              return;
            }
            res.resume();
            doReq(new URL(res.headers.location, u).href);
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) })
          );
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Timeout (${timeout}ms)`));
      });
    }
    doReq(url);
  });
}

function httpPost(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
  opts: { timeout?: number } = {}
): Promise<{ status: number; data: string; resHeaders: Record<string, string | string[] | undefined> }> {
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    let redirects = 0;

    function doReq(u: string) {
      const p = new URL(u);
      const req = https.request(
        {
          hostname: p.hostname,
          path: p.pathname + p.search,
          method: "POST",
          family: 4,
          timeout,
          headers: {
            ...headers,
            "Content-Length": String(body.length),
            "User-Agent": USER_AGENT,
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate",
            Origin: "https://yandex.ru",
            Referer: "https://yandex.ru/images/",
          },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (++redirects > 5) {
              reject(new Error("Too many redirects"));
              return;
            }
            res.resume();
            // Follow redirect as GET
            doReq(new URL(res.headers.location, u).href);
            return;
          }
          let stream: NodeJS.ReadableStream = res;
          const encoding = res.headers["content-encoding"];
          if (encoding === "gzip")
            stream = res.pipe(zlib.createGunzip());
          else if (encoding === "deflate")
            stream = res.pipe(zlib.createInflate());

          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              data: Buffer.concat(chunks).toString("utf8"),
              resHeaders: res.headers as Record<string, string | string[] | undefined>,
            })
          );
          stream.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Timeout (${timeout}ms)`));
      });
      req.write(body);
      req.end();
    }

    doReq(url);
  });
}

/* ---- Yandex CBIR parsing ---- */

interface CbirTag {
  text: string;
  url?: string;
}

interface CbirSite {
  title: string;
  url: string;
  description: string;
  domain?: string;
}

interface YandexResult {
  tags: CbirTag[];
  sites: CbirSite[];
  siteCount: number;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseYandexResponse(html: string): YandexResult {
  const result: YandexResult = { tags: [], sites: [], siteCount: 0 };

  // Extract data-state attributes containing initialState
  const dataStates = html.match(/data-state="([^"]+)"/g) || [];
  for (const ds of dataStates) {
    const raw = ds.slice('data-state="'.length, -1);
    const decoded = decodeHtmlEntities(raw);
    if (!decoded.includes("initialState")) continue;

    try {
      const obj = JSON.parse(decoded);
      const state = obj.initialState;
      if (!state) continue;

      // Tags - what Yandex thinks the image depicts
      const tags = state.cbirTags?.tags;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          if (t && typeof t.text === "string") {
            result.tags.push({ text: t.text, url: t.url });
          }
        }
      }

      // Sites - pages containing this image
      const sites = state.cbirSites?.sites || state.cbirSitesList?.sites || [];
      if (Array.isArray(sites)) {
        result.siteCount = state.cbirSites?.sites?.length ?? sites.length;
        for (const s of sites.slice(0, 15)) {
          if (s && typeof s.url === "string") {
            // Clean yandex tracking params
            let cleanUrl = s.url;
            try {
              const u = new URL(cleanUrl);
              u.searchParams.delete("utm_medium");
              u.searchParams.delete("utm_source");
              cleanUrl = u.href;
            } catch {}
            result.sites.push({
              title: (s.title || "").trim(),
              url: cleanUrl,
              description: (s.description || "").trim(),
              domain: s.domain || "",
            });
          }
        }
      }

      break; // Only need first initialState
    } catch {
      // JSON parse failed, skip
    }
  }

  return result;
}

/* ---- Image loading ---- */

function guessContentType(buf: Buffer, filename: string): string {
  // Check magic bytes
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  // Fallback to extension
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function loadImage(
  source: string
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  // Local file path
  if (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("file://")
  ) {
    const filePath = source.startsWith("file://")
      ? source.slice(7)
      : source;
    const buf = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    return { buffer: buf, filename, contentType: guessContentType(buf, filename) };
  }

  // Base64 data URL
  if (source.startsWith("data:image/")) {
    const match = source.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (match) {
      const buf = Buffer.from(match[2], "base64");
      const ext = match[1].split("/")[1] || "jpg";
      return { buffer: buf, filename: `image.${ext}`, contentType: match[1] };
    }
  }

  // HTTP(S) URL - download
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const resp = await httpGetBuffer(source, { timeout: REQUEST_TIMEOUT });
    if (resp.status !== 200) {
      throw new Error(`Image download failed: HTTP ${resp.status}`);
    }
    const filename = path.basename(new URL(source).pathname) || "image.jpg";
    return {
      buffer: resp.data,
      filename,
      contentType: guessContentType(resp.data, filename),
    };
  }

  throw new Error(
    `Unsupported image source: ${source.substring(0, 50)}... (expected local path, URL, or data URI)`
  );
}

/* ---- Yandex upload ---- */

async function searchByImage(imageBuffer: Buffer, filename: string, contentType: string): Promise<YandexResult> {
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2, 15);

  const headerPart = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="upfile"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([headerPart, imageBuffer, footerPart]);

  const resp = await httpPost(
    "https://yandex.ru/images/search?rpt=imageview&cbir_page=sites",
    body,
    {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Accept: "text/html,application/xhtml+xml",
    },
    { timeout: 30_000 }
  );

  if (resp.status !== 200) {
    throw new Error(`Yandex returned HTTP ${resp.status}`);
  }

  return parseYandexResponse(resp.data);
}

/* ---- Plugin entry ---- */

const plugin = {
  id: "yandex",
  name: "Yandex Image Search",
  description: "Reverse image search via Yandex CBIR",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "yandex",
      label: "Yandex Image Search",
      description: `以图搜图工具，通过 Yandex 图片搜索识别图片中的人物、角色、物品、地点等。
上传图片后返回：
- tags: Yandex 对图片内容的识别标签（如角色名、作品名、物品名）
- sites: 包含相同或相似图片的网页列表（标题、URL、描述）

适用场景：
- 用户发送图片询问"这是谁"、"这是什么"
- 识别动漫/游戏角色（如东方Project、原神等）
- 查找图片出处、原始来源
- 识别现实中的人物、地标、商品

输入：图片的本地路径（如 /tmp/openclaw/media/xxx.jpg）、HTTP(S) URL、或 data:image/... base64

注意：图片文件需要大于 1KB 才能获得有效结果。`,
      parameters: Type.Object({
        image: Type.String({
          description:
            "图片来源：本地文件路径（/path/to/image.jpg）、HTTP(S) URL、或 data:image base64。QQ 消息中的图片会自动保存到本地路径，请使用该路径。",
        }),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const imageSource = params.image as string;
        if (!imageSource || !imageSource.trim()) {
          return { error: "需要提供 image 参数（图片路径或 URL）" };
        }

        try {
          // Load image
          console.log(`[yandex] Loading image: ${imageSource.substring(0, 100)}`);
          const { buffer, filename, contentType } = await loadImage(imageSource.trim());

          if (buffer.length < 1000) {
            return {
              error: `图片太小（${buffer.length} 字节），Yandex 无法识别。需要大于 1KB 的图片。`,
              image: imageSource,
            };
          }

          console.log(
            `[yandex] Uploading ${filename} (${(buffer.length / 1024).toFixed(1)}KB, ${contentType}) to Yandex...`
          );

          // Search
          const result = await searchByImage(buffer, filename, contentType);

          console.log(
            `[yandex] Result: ${result.tags.length} tags, ${result.sites.length}/${result.siteCount} sites`
          );

          const response: Record<string, unknown> = {
            image: imageSource,
            image_size_kb: Math.round(buffer.length / 1024),
          };

          if (result.tags.length > 0) {
            response.tags = result.tags.map((t) => t.text);
            response.tag_count = result.tags.length;
          } else {
            response.tags = [];
            response.tag_message = "Yandex 未能识别图片内容标签";
          }

          if (result.sites.length > 0) {
            response.matching_sites = result.sites.map((s, i) => ({
              index: i + 1,
              title: s.title,
              url: s.url,
              description: s.description,
              domain: s.domain,
            }));
            response.total_sites_found = result.siteCount;
          } else {
            response.matching_sites = [];
            response.site_message = "未找到包含此图片的网页";
          }

          return response;
        } catch (err) {
          return {
            error: `以图搜图失败: ${String(err)}`,
            image: imageSource,
          };
        }
      },
    });

    console.log(
      "[yandex] Registered yandex tool (reverse image search, yandex.ru CBIR)"
    );
  },
};

export default plugin;
