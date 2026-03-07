import { Type } from "@sinclair/typebox";
import https from "node:https";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const API = "https://thwiki.cc/api.php";
const UA = "OpenClaw-THBWiki/1.0 (https://github.com/openclaw)";

// Use node:https with family:4 to force IPv4 (this server has no IPv6 connectivity
// and thwiki.cc has AAAA records, causing Node.js fetch/undici to hang on IPv6)
function httpsGet(url: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { "User-Agent": UA }, family: 4 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`THBWiki API HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("THBWiki API request timeout")); });
  });
}

async function mwFetch(params: Record<string, string>): Promise<any> {
  params.format = "json";
  const url = `${API}?${new URLSearchParams(params).toString()}`;
  const raw = await httpsGet(url);
  return JSON.parse(raw);
}

/** Convert rendered HTML to clean plain text */
function htmlToText(html: string): string {
  let s = html;
  // Remove script/style blocks
  s = s.replace(/<(script|style)[^>]*>.*?<\/\1>/gis, "");
  // Remove edit section links
  s = s.replace(/<span class="mw-editsection">.*?<\/span>/gis, "");
  // Remove sup/reference tags
  s = s.replace(/<sup[^>]*>.*?<\/sup>/gis, "");
  // Remove navbox, toc, notice divs
  s = s.replace(/<(div|table)[^>]*class="[^"]*(?:navbox|toc|notice|mw-empty-elt|infobox)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Convert br, p, headings, li, tr to newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|h[1-6]|li|tr|div)[\s>][^>]*>/gi, "\n");
  // Strip remaining tags
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

const THBWikiSchema = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("page"),
    Type.Literal("sections"),
    Type.Literal("read_section"),
  ]),
  keyword: Type.Optional(Type.String({ description: "搜索关键词 (action=search 时必填)" })),
  title: Type.Optional(Type.String({ description: "页面标题 (action=page/sections/read_section 时必填)" })),
  section: Type.Optional(Type.Number({ description: "章节序号 (action=read_section 时必填，从 sections 结果获取)" })),
  limit: Type.Optional(Type.Number({ description: "返回数量限制, 默认5, 最大20" })),
});

const plugin = {
  id: "thbwiki",
  name: "THBWiki",
  description: "THBWiki (thwiki.cc) Touhou Project wiki lookup",

  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "thbwiki",
        label: "THBWiki",
        description: `Search and read articles on THBWiki (thwiki.cc), the Chinese Touhou Project encyclopedia.
Actions:
- search: Search pages by keyword. Params: keyword (required), limit (default 5, max 20)
- page: Get a page's intro text and section list. Params: title (required)
- sections: List all sections of a page. Params: title (required)
- read_section: Read a specific section's content. Params: title (required), section (required, index from 'sections' result)`,
        parameters: THBWikiSchema,

        async execute(_toolCallId: string, params: any) {
          try {
            switch (params.action) {
              case "search": {
                if (!params.keyword) return text("错误: search 需要 keyword 参数");
                const limit = Math.min(params.limit || 5, 20);
                const data = await mwFetch({
                  action: "query",
                  list: "search",
                  srsearch: params.keyword,
                  srlimit: String(limit),
                });
                const results = data.query?.search;
                if (!results?.length) return text(`未找到与"${params.keyword}"相关的页面`);
                const total = data.query.searchinfo?.totalhits ?? "?";
                const lines = results.map((r: any) => {
                  const snippet = r.snippet?.replace(/<[^>]+>/g, "").slice(0, 120) || "";
                  return `- ${r.title} (${r.size}字) — ${snippet}`;
                });
                return text(`搜索"${params.keyword}"找到${total}个结果 (显示${lines.length}个):\n\n${lines.join("\n")}\n\n提示: 使用 action=page 和 title 参数查看页面详情`);
              }

              case "page": {
                if (!params.title) return text("错误: page 需要 title 参数");
                // Fetch intro (section 0) as rendered HTML + section list
                const [introData, secData] = await Promise.all([
                  mwFetch({
                    action: "parse",
                    page: params.title,
                    prop: "text|displaytitle",
                    section: "0",
                    disabletoc: "true",
                  }),
                  mwFetch({
                    action: "parse",
                    page: params.title,
                    prop: "sections",
                  }),
                ]);
                if (introData.error) return text(`页面不存在: ${introData.error.info}`);

                const html = introData.parse?.text?.["*"] || "";
                const displayTitle = introData.parse?.displaytitle
                  ? htmlToText(introData.parse.displaytitle)
                  : params.title;
                const cleaned = htmlToText(html).slice(0, 3000);

                const sections = secData.parse?.sections || [];
                const secList = sections.slice(0, 20).map((s: any) =>
                  `${"  ".repeat(s.toclevel - 1)}${s.number}. ${s.line} (section=${s.index})`
                ).join("\n");

                const out = [`## ${displayTitle}`, "", cleaned || "(介绍部分为空，请查看具体章节)"];
                if (secList) out.push("", "### 目录", secList, "", "提示: 使用 action=read_section 和 section 参数阅读具体章节");
                out.push("", `链接: https://thwiki.cc/${encodeURIComponent(params.title)}`);
                return text(out.join("\n"));
              }

              case "sections": {
                if (!params.title) return text("错误: sections 需要 title 参数");
                const data = await mwFetch({
                  action: "parse",
                  page: params.title,
                  prop: "sections",
                });
                if (data.error) return text(`页面不存在: ${data.error.info}`);
                const sections = data.parse?.sections || [];
                if (!sections.length) return text("该页面没有章节结构");
                const lines = sections.map((s: any) =>
                  `${"  ".repeat(s.toclevel - 1)}${s.number}. ${s.line} (section=${s.index})`
                );
                return text(`## ${data.parse.title} — 目录\n\n${lines.join("\n")}\n\n提示: 使用 action=read_section, title="${params.title}", section=N 阅读具体章节`);
              }

              case "read_section": {
                if (!params.title) return text("错误: read_section 需要 title 参数");
                if (params.section === undefined) return text("错误: read_section 需要 section 参数 (从 sections 结果获取)");
                // Fetch rendered HTML instead of wikitext
                const data = await mwFetch({
                  action: "parse",
                  page: params.title,
                  prop: "text",
                  section: String(params.section),
                  disabletoc: "true",
                });
                if (data.error) return text(`获取章节失败: ${data.error.info}`);
                const html = data.parse?.text?.["*"] || "";
                const cleaned = htmlToText(html).slice(0, 4000);
                if (!cleaned) return text(`章节 ${params.section} 内容为空`);
                return text(`## ${data.parse.title} — 章节 ${params.section}\n\n${cleaned}\n\n链接: https://thwiki.cc/${encodeURIComponent(params.title)}`);
              }

              default:
                return text(`未知操作: ${params.action}`);
            }
          } catch (err) {
            return text(`THBWiki 错误: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      { name: "thbwiki" },
    );
    console.log("[thbwiki] Registered thbwiki tool (HTML extraction)");
  },
};

export default plugin;
