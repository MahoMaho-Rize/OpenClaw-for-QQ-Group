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
  const parts = key.split(":");
  if (parts.length >= 3) {
    const ch = parts[2];
    if (["qq", "feishu", "telegram", "discord", "slack", "web"].includes(ch)) return ch;
  }
  return "internal";
}

/** Extract group/chat ID from session key, e.g. "agent:main:qq:group:738129404" -> "738129404" */
function getGroupIdFromKey(key: string): string | null {
  const parts = key.split(":");
  // agent:main:qq:group:738129404
  if (parts.length >= 5 && parts[3] === "group") return parts[4];
  return null;
}

function getChatTypeFromKey(key: string): string {
  const parts = key.split(":");
  if (parts.length >= 4) return parts[3]; // "group" or "direct"
  return "unknown";
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
}

interface UsageNumbers {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

function emptyUsage(): UsageNumbers {
  return { sessions: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addUsage(target: UsageNumbers, entry: SessionEntry) {
  target.sessions += 1;
  target.inputTokens += entry.inputTokens || 0;
  target.outputTokens += entry.outputTokens || 0;
  target.cacheRead += entry.cacheRead || 0;
  target.cacheWrite += entry.cacheWrite || 0;
  target.totalTokens += entry.totalTokens || 0;
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

function formatUsageBlock(u: UsageNumbers, label: string): string {
  return [
    `【${label}】`,
    `会话数: ${u.sessions}`,
    `总 Token: ${formatTokens(u.totalTokens)}`,
    `  输入: ${formatTokens(u.inputTokens)}`,
    `  输出: ${formatTokens(u.outputTokens)}`,
    `  缓存读取: ${formatTokens(u.cacheRead)}`,
    `  缓存写入: ${formatTokens(u.cacheWrite)}`,
  ].join("\n");
}

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

// --- Plugin ---

const UsageSchema = Type.Object({
  channel: Type.String({
    description: "渠道名称。你必须根据当前对话来源填写: 在QQ群/私聊中填 qq，在飞书中填 feishu，填 all 查看所有渠道。",
  }),
  group_id: Type.Optional(
    Type.String({
      description: "群号。如果用户在某个QQ群中提问，填入该群的群号（从对话上下文的元数据中获取）。不填则显示该渠道下所有会话的合计。",
    }),
  ),
  days: Type.Optional(
    Type.Number({
      description: "统计最近N天的数据，默认30天，0表示全部历史",
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
        description: `查询本bot的 token 用量统计，按渠道和群分别统计。
调用时你必须根据当前对话来源自动填入 channel 参数（qq/feishu）。
如果用户在QQ群中提问，还应填入 group_id（从消息元数据中的群号获取）。
这样用户只会看到自己所在群的用量，而非所有渠道的混合数据。`,
        parameters: UsageSchema,

        async execute(_toolCallId: string, params: any) {
          try {
            const sessions = await loadSessions();
            const days = params.days ?? 30;
            const channel: string = params.channel || "all";
            const groupId: string | undefined = params.group_id || undefined;
            const cutoff = days > 0 ? daysAgoMs(days) : 0;
            const daysLabel = days > 0 ? `最近${days}天` : "全部时间";

            // Filter and aggregate
            const matchedSessions: Array<{ key: string; entry: SessionEntry }> = [];
            const usage = emptyUsage();

            for (const [key, entry] of Object.entries(sessions)) {
              const ch = getChannelFromKey(key);
              // Channel filter
              if (channel !== "all" && ch !== channel) continue;
              // Group filter
              if (groupId) {
                const gid = getGroupIdFromKey(key);
                if (gid !== groupId) continue;
              }
              // Time filter
              const ts = entry.updatedAt || entry.createdAt || 0;
              if (cutoff > 0 && ts < cutoff) continue;

              matchedSessions.push({ key, entry });
              addUsage(usage, entry);
            }

            if (matchedSessions.length === 0) {
              const scope = groupId ? `群${groupId}` : `${channel}渠道`;
              return text(`${daysLabel}内 ${scope} 没有使用记录。`);
            }

            // Build response
            const lines: string[] = [];
            const scope = groupId ? `群 ${groupId}` : channel === "all" ? "所有渠道" : `${channel} 渠道`;
            lines.push(`📊 用量统计 — ${scope}（${daysLabel}）`);
            lines.push("");
            lines.push(formatUsageBlock(usage, scope));

            // If showing all channels (no group filter), break down by channel
            if (channel === "all" && !groupId) {
              const byChannel: Record<string, UsageNumbers> = {};
              for (const { key, entry } of matchedSessions) {
                const ch = getChannelFromKey(key);
                if (!byChannel[ch]) byChannel[ch] = emptyUsage();
                addUsage(byChannel[ch], entry);
              }
              const sorted = Object.entries(byChannel).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
              for (const [ch, u] of sorted) {
                lines.push("");
                lines.push(formatUsageBlock(u, ch));
              }
            }

            // If showing a channel without group filter, break down by group/chat
            if (channel !== "all" && !groupId && matchedSessions.length > 1) {
              lines.push("");
              lines.push("--- 按会话明细 ---");
              const sorted = matchedSessions.sort(
                (a, b) => (b.entry.totalTokens || 0) - (a.entry.totalTokens || 0),
              );
              for (const { key, entry } of sorted.slice(0, 15)) {
                const chatType = getChatTypeFromKey(key);
                const gid = getGroupIdFromKey(key);
                const label = chatType === "group" && gid ? `群${gid}` : chatType === "direct" ? "私聊" : key;
                const date = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString("zh-CN") : "";
                lines.push(`  ${label}: ${formatTokens(entry.totalTokens || 0)} (${date})`);
              }
            }

            return text(lines.join("\n"));
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
