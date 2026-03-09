import { Type } from "@sinclair/typebox";
import https from "node:https";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const UA = "OpenClaw-Fandom/1.0 (bot; https://github.com/openclaw)";

// ── HTTP helper (node:https, IPv4-forced) ────────────────────────────
function httpsGet(url: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        family: 4,
        timeout: timeoutMs,
        headers: { "User-Agent": UA },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redir = res.headers.location;
          if (redir.startsWith("/")) redir = `https://${u.hostname}${redir}`;
          httpsGet(redir, timeoutMs).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timeout")); });
  });
}

// ── Fandom API helpers ───────────────────────────────────────────────

/** Build API base URL: https://{wiki}.fandom.com[/{lang}]/api.php */
function apiUrl(wiki: string, lang?: string): string {
  const base = `https://${wiki}.fandom.com`;
  return lang ? `${base}/${lang}/api.php` : `${base}/api.php`;
}

async function mwApi(wiki: string, params: Record<string, string>, lang?: string): Promise<any> {
  params.format = "json";
  const url = `${apiUrl(wiki, lang)}?${new URLSearchParams(params).toString()}`;
  const raw = await httpsGet(url);
  return JSON.parse(raw);
}

/** Strip HTML tags and decode common entities → plain text */
function htmlToText(html: string): string {
  let s = html;
  // Remove style/script blocks
  s = s.replace(/<(script|style)[^>]*>.*?<\/\1>/gis, "");
  // Remove navigation/infobox tables (class contains "infobox", "navbox", "portable-infobox")
  s = s.replace(/<(table|aside|div)\b[^>]*class="[^"]*(?:infobox|navbox|portable-infobox|pi-item|toc)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove sup/reference tags
  s = s.replace(/<sup[^>]*>.*?<\/sup>/gis, "");
  // Convert <br>, <p>, heading, <li> to newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|h[1-6]|li|tr|div)[\s>][^>]*>/gi, "\n");
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode entities
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map(l => l.trim()).filter(l => l).join("\n");
}

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

// ── Tool schema ──────────────────────────────────────────────────────
const FandomSchema = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("page"),
    Type.Literal("sections"),
    Type.Literal("read_section"),
  ]),
  wiki: Type.String({
    description:
      "Fandom wiki subdomain, e.g. 'onepiece', 'genshin-impact', 'naruto', 'touhou', 'typemoon', 'minecraft'. " +
      "This is the part before .fandom.com in the URL.",
  }),
  lang: Type.Optional(
    Type.String({
      description:
        "Language code for multilingual wikis, e.g. 'zh', 'ja', 'es'. " +
        "Omit for English (default). Maps to https://{wiki}.fandom.com/{lang}/api.php",
    }),
  ),
  keyword: Type.Optional(Type.String({ description: "Search keyword (required for action=search)" })),
  title: Type.Optional(
    Type.String({ description: "Page title (required for action=page/sections/read_section)" }),
  ),
  section: Type.Optional(
    Type.Number({
      description: "Section index for read_section (get from sections action first)",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max results, default 5, max 10" })),
});

// ── Plugin ───────────────────────────────────────────────────────────
const plugin = {
  id: "fandom",
  name: "Fandom Wiki",
  description: "Generic Fandom wiki lookup — any Fandom wiki by subdomain",

  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "fandom",
        label: "Fandom Wiki",
        description: `搜索和阅读 Fandom 百科 (*.fandom.com) 上的词条。Fandom 托管了数千个英文 wiki，覆盖游戏、动漫、影视、小说等IP。适用于：战锤、高达、魔戒、漫威、DC、星球大战、哈利波特、我的世界、塞尔达等非中文ACG百科覆盖的IP。中文ACG内容请优先用 moegirl，东方用 thbwiki。

常用 wiki 子域名：
  onepiece, naruto, genshin-impact, minecraft, zelda, mario, pokemon,
  finalfantasy, typemoon, marvel, dc, starwars, harrypotter, lordoftherings, warhammer40k, gundam

操作:
- search: 搜索页面。参数: wiki(必填), keyword(必填), lang(可选), limit(默认5)
- page: 获取页面简介。参数: wiki(必填), title(必填), lang(可选)
- sections: 列出章节目录。参数: wiki(必填), title(必填), lang(可选)
- read_section: 读取指定章节。参数: wiki(必填), title(必填), section(必填), lang(可选)

提示: 多语言 wiki 可加 lang='zh' 或 lang='ja'。页面标题区分大小写。

数据来源：Fandom`,
        parameters: FandomSchema,

        async execute(_toolCallId: string, params: any) {
          const wiki: string = params.wiki;
          const lang: string | undefined = params.lang || undefined;
          const wikiLabel = lang ? `${wiki}.fandom.com/${lang}` : `${wiki}.fandom.com`;

          try {
            switch (params.action) {
              // ── search ───────────────────────────────────────────
              case "search": {
                if (!params.keyword) return text("错误: search 需要 keyword 参数");
                const limit = Math.min(params.keyword ? (params.limit || 5) : 5, 10);

                // Try full-text search first (richer results)
                const data = await mwApi(
                  wiki,
                  {
                    action: "query",
                    list: "search",
                    srsearch: params.keyword,
                    srlimit: String(limit),
                    srprop: "snippet|size|wordcount",
                  },
                  lang,
                );

                const results = data?.query?.search;
                if (!results?.length) {
                  // Fallback to opensearch (prefix match)
                  const os = await mwApi(
                    wiki,
                    {
                      action: "opensearch",
                      search: params.keyword,
                      limit: String(limit),
                      redirects: "resolve",
                    },
                    lang,
                  );
                  if (Array.isArray(os) && os[1]?.length) {
                    const titles: string[] = os[1];
                    const urls: string[] = os[3] || [];
                    const lines = titles.map((t: string, i: number) => `- ${t}\n  ${urls[i] || ""}`);
                    return text(
                      `[${wikiLabel}] 搜索"${params.keyword}"找到 ${titles.length} 个匹配 (前缀):\n\n${lines.join("\n")}\n\n使用 action=page 查看内容`,
                    );
                  }
                  return text(`[${wikiLabel}] 未找到与"${params.keyword}"相关的页面`);
                }

                const baseUrl = lang
                  ? `https://${wiki}.fandom.com/${lang}/wiki`
                  : `https://${wiki}.fandom.com/wiki`;
                const lines = results.map((r: any) => {
                  const snippet = r.snippet
                    ? htmlToText(r.snippet).slice(0, 120)
                    : "";
                  return `- **${r.title}** (${r.wordcount} words)\n  ${baseUrl}/${encodeURIComponent(r.title)}${snippet ? "\n  " + snippet : ""}`;
                });
                return text(
                  `[${wikiLabel}] 搜索"${params.keyword}"找到 ${data.query.searchinfo?.totalhits ?? results.length} 个结果:\n\n${lines.join("\n")}\n\n使用 action=page 和 title 参数查看页面内容`,
                );
              }

              // ── page (intro section) ────────────────────────────
              case "page": {
                if (!params.title) return text("错误: page 需要 title 参数");
                const data = await mwApi(
                  wiki,
                  {
                    action: "parse",
                    page: params.title,
                    prop: "text|displaytitle",
                    section: "0",
                    disabletoc: "true",
                  },
                  lang,
                );
                if (data.error) {
                  return text(`[${wikiLabel}] 错误: ${data.error.info || data.error.code}`);
                }
                const html = data.parse?.text?.["*"] || "";
                const title = data.parse?.displaytitle || params.title;
                const plainTitle = htmlToText(title);
                let extracted = htmlToText(html);
                if (!extracted) return text(`[${wikiLabel}] 页面"${params.title}"内容为空`);

                const maxLen = 4000;
                const truncated = extracted.slice(0, maxLen);
                const isTruncated = extracted.length > maxLen;
                const baseUrl = lang
                  ? `https://${wiki}.fandom.com/${lang}/wiki`
                  : `https://${wiki}.fandom.com/wiki`;
                return text(
                  `## ${plainTitle}\n\n${truncated}${isTruncated ? "\n\n...(内容过长已截断，使用 sections + read_section 查看特定章节)" : ""}\n\n链接: ${baseUrl}/${encodeURIComponent(params.title)}\n\n提示: 使用 action=sections 查看所有章节标题，action=read_section 读取特定章节`,
                );
              }

              // ── sections ────────────────────────────────────────
              case "sections": {
                if (!params.title) return text("错误: sections 需要 title 参数");
                const data = await mwApi(
                  wiki,
                  { action: "parse", page: params.title, prop: "sections" },
                  lang,
                );
                if (data.error) {
                  return text(`[${wikiLabel}] 错误: ${data.error.info || data.error.code}`);
                }
                const secs = data.parse?.sections;
                if (!secs?.length) return text(`[${wikiLabel}] 页面"${params.title}"没有章节`);

                const lines = secs.map((s: any) => {
                  const indent = "  ".repeat(Math.max(0, Number(s.toclevel) - 1));
                  return `${indent}${s.index}. ${s.line}`;
                });
                return text(
                  `## ${params.title} — 章节目录\n\n${lines.join("\n")}\n\n使用 action=read_section, title="${params.title}", section=<序号> 读取特定章节`,
                );
              }

              // ── read_section ────────────────────────────────────
              case "read_section": {
                if (!params.title) return text("错误: read_section 需要 title 参数");
                if (params.section === undefined || params.section === null)
                  return text("错误: read_section 需要 section 参数 (章节序号)");

                const data = await mwApi(
                  wiki,
                  {
                    action: "parse",
                    page: params.title,
                    prop: "text",
                    section: String(params.section),
                    disabletoc: "true",
                  },
                  lang,
                );
                if (data.error) {
                  return text(`[${wikiLabel}] 错误: ${data.error.info || data.error.code}`);
                }
                const html = data.parse?.text?.["*"] || "";
                let extracted = htmlToText(html);
                if (!extracted) return text(`[${wikiLabel}] 章节 ${params.section} 内容为空`);

                const maxLen = 4000;
                const truncated = extracted.slice(0, maxLen);
                const isTruncated = extracted.length > maxLen;
                return text(
                  `## ${params.title} — 章节 ${params.section}\n\n${truncated}${isTruncated ? "\n\n...(内容过长已截断)" : ""}`,
                );
              }

              default:
                return text(`未知操作: ${params.action}`);
            }
          } catch (err) {
            return text(`[${wikiLabel}] Fandom 错误: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      { name: "fandom" },
    );
    console.log("[fandom] Registered fandom tool (node:https, IPv4)");
  },
};

export default plugin;
