import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const BGM_API = "https://api.bgm.tv";
// Token is loaded from plugin config (plugins.entries.bangumi.config.token in openclaw.json)
// or from env var BANGUMI_TOKEN
let BGM_TOKEN = "";

const SUBJECT_TYPE: Record<number, string> = {
  1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元",
};
const SUBJECT_TYPE_REVERSE: Record<string, number> = {
  book: 1, anime: 2, music: 3, game: 4, real: 6,
  书籍: 1, 动画: 2, 音乐: 3, 游戏: 4, 三次元: 6,
};

async function bgmFetch(path: string, opts?: { method?: string; body?: unknown }) {
  const res = await fetch(`${BGM_API}${path}`, {
    method: opts?.method || "GET",
    headers: {
      Authorization: `Bearer ${BGM_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenClaw-Bangumi/1.0 (https://github.com/openclaw)",
    },
    ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bangumi API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function formatRating(r: any): string {
  if (!r) return "暂无评分";
  return `${r.score}/10 (${r.total}人评分, 排名#${r.rank || "N/A"})`;
}

function formatCollection(c: any): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.wish) parts.push(`想看${c.wish}`);
  if (c.collect) parts.push(`看过${c.collect}`);
  if (c.doing) parts.push(`在看${c.doing}`);
  if (c.on_hold) parts.push(`搁置${c.on_hold}`);
  if (c.dropped) parts.push(`抛弃${c.dropped}`);
  return parts.join(" / ");
}

function formatTags(tags: any[]): string {
  if (!tags?.length) return "";
  return tags.slice(0, 10).map((t: any) => t.name).join(", ");
}

function formatSubjectBrief(s: any): string {
  const type = SUBJECT_TYPE[s.type] || `类型${s.type}`;
  const name = s.name_cn || s.name;
  const orig = s.name_cn && s.name !== s.name_cn ? ` (${s.name})` : "";
  const date = s.date || "日期未知";
  const score = s.rating ? `${s.rating.score}/10` : "暂无评分";
  const rank = s.rating?.rank ? ` #${s.rating.rank}` : "";
  return `[${type}] ${name}${orig} (${date}) - ${score}${rank} - bgm.tv/subject/${s.id}`;
}

function formatSubjectDetail(s: any): string {
  const type = SUBJECT_TYPE[s.type] || `类型${s.type}`;
  const name = s.name_cn || s.name;
  const orig = s.name_cn && s.name !== s.name_cn ? `原名: ${s.name}` : "";
  const lines: string[] = [
    `## ${name}`,
    orig,
    `类型: ${type} | 日期: ${s.date || "未知"} | 平台: ${s.platform || "N/A"}`,
    `评分: ${formatRating(s.rating)}`,
    `收藏: ${formatCollection(s.collection)}`,
    `标签: ${formatTags(s.tags)}`,
    "",
    s.summary || "暂无简介",
    "",
    `链接: https://bgm.tv/subject/${s.id}`,
  ];
  // Infobox highlights
  if (s.infobox?.length) {
    const important = ["导演", "原作", "脚本", "音乐", "制作", "监督", "开发", "作者", "出版社", "播放电视台"];
    const infoLines = s.infobox
      .filter((item: any) => important.some(k => item.key?.includes(k)))
      .map((item: any) => {
        const val = typeof item.value === "string" 
          ? item.value 
          : Array.isArray(item.value) 
            ? item.value.map((v: any) => v.v || v).join(", ")
            : JSON.stringify(item.value);
        return `${item.key}: ${val}`;
      });
    if (infoLines.length) {
      lines.push("", "### 制作信息", ...infoLines);
    }
  }
  return lines.filter(l => l !== undefined).join("\n");
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

const BangumiSchema = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("detail"),
    Type.Literal("characters"),
    Type.Literal("related"),
    Type.Literal("persons"),
  ]),
  keyword: Type.Optional(Type.String({ description: "搜索关键词 (action=search 时必填)" })),
  subject_id: Type.Optional(Type.Number({ description: "条目ID (action=detail/characters/related/persons 时必填)" })),
  type: Type.Optional(Type.String({ description: "条目类型过滤: anime, book, game, music, real (action=search 时可选)" })),
  limit: Type.Optional(Type.Number({ description: "返回数量限制, 默认5, 最大25" })),
});

const plugin = {
  id: "bangumi",
  name: "Bangumi",
  description: "Bangumi (bangumi.tv) anime/manga/game database lookup",

  register(api: OpenClawPluginApi) {
    // Load token from plugin config or environment
    BGM_TOKEN = String(api.pluginConfig?.token || process.env.BANGUMI_TOKEN || "");
    if (!BGM_TOKEN) {
      console.warn("[bangumi] WARNING: No Bangumi API token configured. Set plugins.entries.bangumi.config.token in openclaw.json or BANGUMI_TOKEN env var.");
    }

    api.registerTool(
      {
        name: "bangumi",
        label: "Bangumi",
        description: `Search and look up anime, manga, game, music entries on Bangumi (bgm.tv / bangumi.tv), a Chinese ACG database.
Actions:
- search: Search subjects by keyword. Params: keyword (required), type (optional: anime/book/game/music/real), limit (default 5)
- detail: Get full details of a subject. Params: subject_id (required)
- characters: List characters of a subject. Params: subject_id (required), limit (default 10)
- related: Get related subjects (sequels, prequels, spin-offs). Params: subject_id (required)
- persons: Get staff/cast of a subject. Params: subject_id (required), limit (default 10)`,
        parameters: BangumiSchema,

        async execute(_toolCallId: string, params: any) {
          try {
            switch (params.action) {
              case "search": {
                if (!params.keyword) return text("错误: search 操作需要 keyword 参数");
                const limit = Math.min(params.limit || 5, 25);
                const filter: any = {};
                if (params.type) {
                  const typeNum = SUBJECT_TYPE_REVERSE[params.type];
                  if (typeNum) filter.type = [typeNum];
                }
                const data = await bgmFetch(`/v0/search/subjects?limit=${limit}`, {
                  method: "POST",
                  body: { keyword: params.keyword, filter },
                });
                if (!data.data?.length) return text(`未找到与"${params.keyword}"相关的条目`);
                const results = data.data.map(formatSubjectBrief).join("\n");
                return text(`搜索"${params.keyword}"找到${data.total}个结果 (显示前${data.data.length}个):\n\n${results}`);
              }

              case "detail": {
                if (!params.subject_id) return text("错误: detail 操作需要 subject_id 参数");
                const s = await bgmFetch(`/v0/subjects/${params.subject_id}`);
                return text(formatSubjectDetail(s));
              }

              case "characters": {
                if (!params.subject_id) return text("错误: characters 操作需要 subject_id 参数");
                const chars = await bgmFetch(`/v0/subjects/${params.subject_id}/characters`);
                if (!Array.isArray(chars) || !chars.length) return text("该条目暂无角色信息");
                const limit = Math.min(params.limit || 10, 25);
                const lines = chars.slice(0, limit).map((c: any) => {
                  const name = c.name_cn || c.name || "未知";
                  const orig = c.name_cn && c.name !== c.name_cn ? ` (${c.name})` : "";
                  const relation = c.relation || "";
                  const actors = c.actors?.map((a: any) => a.name).join(", ") || "";
                  return `- ${name}${orig}${relation ? ` [${relation}]` : ""}${actors ? ` CV: ${actors}` : ""}`;
                });
                return text(`角色列表 (共${chars.length}个, 显示${lines.length}个):\n${lines.join("\n")}`);
              }

              case "related": {
                if (!params.subject_id) return text("错误: related 操作需要 subject_id 参数");
                const related = await bgmFetch(`/v0/subjects/${params.subject_id}/subjects`);
                if (!Array.isArray(related) || !related.length) return text("该条目暂无关联条目");
                const lines = related.map((r: any) => {
                  const type = SUBJECT_TYPE[r.type] || `类型${r.type}`;
                  const name = r.name_cn || r.name || "未知";
                  const relation = r.relation || "";
                  return `- [${relation}] ${name} (${type}) - bgm.tv/subject/${r.id}`;
                });
                return text(`关联条目 (共${related.length}个):\n${lines.join("\n")}`);
              }

              case "persons": {
                if (!params.subject_id) return text("错误: persons 操作需要 subject_id 参数");
                const persons = await bgmFetch(`/v0/subjects/${params.subject_id}/persons`);
                if (!Array.isArray(persons) || !persons.length) return text("该条目暂无制作人员信息");
                const limit = Math.min(params.limit || 10, 25);
                const lines = persons.slice(0, limit).map((p: any) => {
                  const name = p.name_cn || p.name || "未知";
                  const relation = p.relation || "";
                  return `- ${name}${relation ? ` [${relation}]` : ""}`;
                });
                return text(`制作人员 (共${persons.length}个, 显示${lines.length}个):\n${lines.join("\n")}`);
              }

              default:
                return text(`未知操作: ${params.action}`);
            }
          } catch (err) {
            return text(`Bangumi API 错误: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      { name: "bangumi" },
    );

    console.log("[bangumi] Registered bangumi tool");
  },
};

export default plugin;
