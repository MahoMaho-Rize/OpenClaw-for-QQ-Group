import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  URL Reader Plugin                                                   */
/*  Fetches and extracts readable content from any URL                  */
/*  Returns clean text for the model to summarize or analyze            */
/* ------------------------------------------------------------------ */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 20_000;

/* ---- HTTP helper ---- */

interface HttpResponse {
  status: number;
  data: string;
  url: string;
  contentType: string;
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
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
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
          let totalSize = 0;
          const maxSize = 5 * 1024 * 1024; // 5MB max

          stream.on("data", (c: Buffer) => {
            totalSize += c.length;
            if (totalSize <= maxSize) chunks.push(c);
          });
          stream.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              data: Buffer.concat(chunks).toString("utf8"),
              url: currentUrl,
              contentType: res.headers["content-type"] || "",
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

/* ---- HTML text extraction ---- */

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
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<\/th>/gi, "\t")
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

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : "";
}

function extractMetaDescription(html: string): string {
  const m = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*?)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([^"']*?)["'][^>]*name=["']description["'][^>]*>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : "";
}

function extractMainContent(html: string, maxChars: number): string {
  // Try priority extraction: article > main > body
  let body = "";

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    body = articleMatch[1];
  } else {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) {
      body = mainMatch[1];
    } else {
      // Try content div patterns common in Chinese sites
      const contentPatterns = [
        /<div[^>]*class="[^"]*(?:article|content|post|entry|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*id="[^"]*(?:article|content|post|entry|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      ];
      for (const pattern of contentPatterns) {
        const m = html.match(pattern);
        if (m && m[1].length > 200) {
          body = m[1];
          break;
        }
      }
      if (!body) {
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        body = bodyMatch ? bodyMatch[1] : html;
      }
    }
  }

  const text = htmlToText(body);
  if (text.length > maxChars) {
    return text.substring(0, maxChars) + "\n…（内容已截断）";
  }
  return text;
}

/* ---- JSON formatting ---- */

function formatJson(data: string, maxChars: number): string {
  try {
    const parsed = JSON.parse(data);
    const formatted = JSON.stringify(parsed, null, 2);
    if (formatted.length > maxChars) {
      return formatted.substring(0, maxChars) + "\n…（JSON已截断）";
    }
    return formatted;
  } catch {
    if (data.length > maxChars) {
      return data.substring(0, maxChars) + "\n…（内容已截断）";
    }
    return data;
  }
}

/* ---- Plugin entry ---- */

const plugin = {
  id: "url-reader",
  name: "URL Reader",
  description: "获取任意URL的网页内容，提取正文用于摘要分析",

  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "url_reader",
      label: "URL阅读器",
      description: `获取任意URL的网页内容并提取正文文本。适用于：
- 用户分享了一个链接，需要总结/分析内容
- 需要阅读某个网页的详细信息
- 需要提取文章、博客、新闻的正文

支持 HTML 网页和 JSON API 响应。自动提取页面标题、描述和正文内容。
对于搜索需求请使用 bing 工具，本工具仅用于读取已知 URL 的内容。`,
      parameters: Type.Object({
        url: Type.String({
          description: "要读取的网页 URL（必须是完整的 http/https URL）",
        }),
        max_chars: Type.Optional(
          Type.Number({
            description: "返回的最大字符数（默认 15000，最大 50000）",
          })
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const url = params.url as string | undefined;
        if (!url || !url.trim()) {
          return { error: "需要提供 url 参数" };
        }

        const trimmedUrl = url.trim();
        if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
          return { error: "URL 必须以 http:// 或 https:// 开头", url: trimmedUrl };
        }

        const maxChars = Math.min(
          Math.max(Number(params.max_chars) || 15000, 500),
          50000
        );

        try {
          const res = await httpGet(trimmedUrl);

          if (res.status !== 200) {
            return { error: `HTTP ${res.status}`, url: trimmedUrl };
          }

          const ct = res.contentType.toLowerCase();
          const isJson = ct.includes("application/json") || ct.includes("+json");
          const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
          const isText = ct.includes("text/");

          if (isJson) {
            const content = formatJson(res.data, maxChars);
            console.log(`[url-reader] JSON ${trimmedUrl} → ${content.length} chars`);
            return {
              url: res.url,
              content_type: "json",
              content_length: content.length,
              content,
            };
          }

          if (isHtml || (!isText && !isJson)) {
            // Treat as HTML
            const title = extractTitle(res.data);
            const description = extractMetaDescription(res.data);
            const content = extractMainContent(res.data, maxChars);

            if (!content || content.length < 20) {
              return { url: res.url, title, description, content: "", message: "页面内容为空或无法提取正文" };
            }

            console.log(`[url-reader] HTML ${trimmedUrl} → "${title}" ${content.length} chars`);

            return {
              url: res.url,
              content_type: "html",
              title: title || undefined,
              description: description || undefined,
              content_length: content.length,
              content,
            };
          }

          // Plain text
          let content = res.data;
          if (content.length > maxChars) {
            content = content.substring(0, maxChars) + "\n…（内容已截断）";
          }
          console.log(`[url-reader] text ${trimmedUrl} → ${content.length} chars`);
          return {
            url: res.url,
            content_type: "text",
            content_length: content.length,
            content,
          };
        } catch (err) {
          return { error: `获取页面失败: ${String(err)}`, url: trimmedUrl };
        }
      },
    });

    console.log("[url-reader] Registered url_reader tool (IPv4)");
  },
};

export default plugin;
