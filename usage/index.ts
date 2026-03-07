import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// --- Helpers ---

function getSessionsJsonPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".openclaw", "agents", "main", "sessions", "sessions.json");
}

function getChannelFromKey(key: string): string {
  // "agent:main:qq:group:738129404" -> "qq"
  // "agent:main:feishu:direct:ou_..." -> "feishu"
  const parts = key.split(":");
  if (parts.length >= 3) {
    const ch = parts[2];
    if (["qq", "feishu", "telegram", "discord", "slack", "web"].includes(ch)) return ch;
  }
  return "internal";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function daysAgoMs(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

interface SessionEntry {
  sessionId?: string;
  lastChannel?: string;
  chatType?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  updatedAt?: number;
  createdAt?: number;
  origin?: { provider?: string };
}

interface UsageSummary {
  channel: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

async function loadSessions(): Promise<Record<string, SessionEntry>> {
  const p = getSessionsJsonPath();
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function aggregateUsage(
  sessions: Record<string, SessionEntry>,
  filterChannel?: string,
  days?: number,
): { byChannel: Record<string, UsageSummary>; total: UsageSummary } {
  const cutoff = days && days > 0 ? daysAgoMs(days) : 0;

  const byChannel: Record<string, UsageSummary> = {};
  const total: UsageSummary = {
    channel: "all",
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };

  for (const [key, entry] of Object.entries(sessions)) {
    const channel = getChannelFromKey(key);

    // Filter by channel if specified
    if (filterChannel && filterChannel !== "all" && channel !== filterChannel) continue;

    // Filter by time if specified
    const ts = entry.updatedAt || entry.createdAt || 0;
    if (cutoff > 0 && ts < cutoff) continue;

    if (!byChannel[channel]) {
      byChannel[channel] = {
        channel,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      };
    }

    const ch = byChannel[channel];
    ch.sessions += 1;
    ch.inputTokens += entry.inputTokens || 0;
    ch.outputTokens += entry.outputTokens || 0;
    ch.cacheRead += entry.cacheRead || 0;
    ch.cacheWrite += entry.cacheWrite || 0;
    ch.totalTokens += entry.totalTokens || 0;

    total.sessions += 1;
    total.inputTokens += entry.inputTokens || 0;
    total.outputTokens += entry.outputTokens || 0;
    total.cacheRead += entry.cacheRead || 0;
    total.cacheWrite += entry.cacheWrite || 0;
    total.totalTokens += entry.totalTokens || 0;
  }

  return { byChannel, total };
}

function formatSummary(s: UsageSummary, label: string): string {
  const lines: string[] = [
    `### ${label}`,
    `会话数: ${s.sessions}`,
    `总 Token: ${formatTokens(s.totalTokens)}`,
    `  输入: ${formatTokens(s.inputTokens)}`,
    `  输出: ${formatTokens(s.outputTokens)}`,
    `  缓存读取: ${formatTokens(s.cacheRead)}`,
    `  缓存写入: ${formatTokens(s.cacheWrite)}`,
  ];
  return lines.join("\n");
}

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

// --- Plugin ---

const UsageSchema = Type.Object({
  action: Type.Union([
    Type.Literal("summary"),
    Type.Literal("detail"),
  ]),
  channel: Type.Optional(
    Type.String({
      description:
        "按渠道过滤: qq, feishu, all。如果当前对话来自QQ就填qq，来自飞书就填feishu，不填则只显示当前渠道的数据。",
    }),
  ),
  days: Type.Optional(
    Type.Number({
      description: "统计最近N天的数据，默认30天，0表示全部",
    }),
  ),
});

const plugin = {
  id: "usage",
  name: "Usage",
  description: "OpenClaw token usage statistics per channel",

  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "usage",
        label: "用量统计",
        description: `查询 OpenClaw 的 token 用量统计数据，支持按渠道（QQ/飞书等）和时间范围过滤。
重要：请根据当前对话所在的渠道自动填入 channel 参数。如果用户在QQ中询问，channel应填"qq"；在飞书中询问则填"feishu"。
Actions:
- summary: 查看用量汇总（按渠道分组）
- detail: 查看指定渠道的详细用量`,
        parameters: UsageSchema,

        async execute(_toolCallId: string, params: any) {
          try {
            const sessions = await loadSessions();
            const days = params.days ?? 30;
            const channel = params.channel || undefined;
            const daysLabel = days > 0 ? `最近${days}天` : "全部时间";

            switch (params.action) {
              case "summary": {
                const { byChannel, total } = aggregateUsage(sessions, channel, days);

                const lines: string[] = [`## OpenClaw 用量统计 (${daysLabel})`];

                if (channel && channel !== "all") {
                  // 只显示指定渠道
                  const ch = byChannel[channel];
                  if (!ch || ch.sessions === 0) {
                    return text(`${daysLabel}内 ${channel} 渠道没有使用记录。`);
                  }
                  lines.push("", formatSummary(ch, `${channel} 渠道`));
                } else {
                  // 显示所有渠道
                  const channels = Object.values(byChannel).sort(
                    (a, b) => b.totalTokens - a.totalTokens,
                  );
                  for (const ch of channels) {
                    lines.push("", formatSummary(ch, `${ch.channel} 渠道`));
                  }
                  if (channels.length > 1) {
                    lines.push("", formatSummary(total, "合计"));
                  }
                }

                return text(lines.join("\n"));
              }

              case "detail": {
                const ch = channel || "all";
                const { byChannel, total } = aggregateUsage(sessions, ch, days);

                const lines: string[] = [`## OpenClaw 详细用量 (${daysLabel})`];

                // List individual sessions for the channel
                const sessionList: Array<{
                  key: string;
                  channel: string;
                  chatType: string;
                  totalTokens: number;
                  updatedAt: number;
                }> = [];

                const cutoff = days > 0 ? daysAgoMs(days) : 0;

                for (const [key, entry] of Object.entries(sessions)) {
                  const sCh = getChannelFromKey(key);
                  if (ch !== "all" && sCh !== ch) continue;
                  const ts = entry.updatedAt || entry.createdAt || 0;
                  if (cutoff > 0 && ts < cutoff) continue;
                  sessionList.push({
                    key,
                    channel: sCh,
                    chatType: entry.chatType || "unknown",
                    totalTokens: entry.totalTokens || 0,
                    updatedAt: ts,
                  });
                }

                sessionList.sort((a, b) => b.totalTokens - a.totalTokens);

                // Summary first
                const summary = ch === "all" ? total : byChannel[ch];
                if (summary) {
                  lines.push("", formatSummary(summary, ch === "all" ? "合计" : `${ch} 渠道`));
                }

                // Top sessions
                lines.push("", `### 会话明细 (Top ${Math.min(sessionList.length, 20)})`);
                const top = sessionList.slice(0, 20);
                for (const s of top) {
                  const date = s.updatedAt
                    ? new Date(s.updatedAt).toLocaleDateString("zh-CN")
                    : "未知";
                  const keyShort = s.key.length > 50 ? s.key.slice(0, 50) + "..." : s.key;
                  lines.push(
                    `- ${formatTokens(s.totalTokens)} | ${s.channel}/${s.chatType} | ${date} | ${keyShort}`,
                  );
                }

                return text(lines.join("\n"));
              }

              default:
                return text(`未知操作: ${params.action}。可用: summary, detail`);
            }
          } catch (err) {
            return text(`读取用量数据失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      { name: "usage" },
    );

    console.log("[usage] Registered usage tool (per-channel token statistics)");
  },
};

export default plugin;
