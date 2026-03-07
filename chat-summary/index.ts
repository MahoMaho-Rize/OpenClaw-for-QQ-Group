import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as http from "node:http";

/* ------------------------------------------------------------------ */
/*  Chat Summary Plugin                                                */
/*  Fetches QQ group chat history via NapCat OneBot11 HTTP API         */
/*  Returns formatted messages for the model to summarize              */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;

/* ---- NapCat HTTP API helper ---- */

function napCatPost(
  baseUrl: string,
  token: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ status: string; retcode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint, baseUrl);
    const payload = JSON.stringify(body);

    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "POST",
        family: 4,
        timeout: REQUEST_TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`Failed to parse NapCat response: ${String(err)}`));
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`NapCat HTTP request timeout (${REQUEST_TIMEOUT}ms)`));
    });
    req.write(payload);
    req.end();
  });
}

/* ---- Message formatting ---- */

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

interface MsgSegment {
  type: string;
  data?: Record<string, unknown>;
}

function extractTextFromSegments(segments: MsgSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") parts.push(String(seg.data?.text || ""));
    else if (seg.type === "at") {
      const qq = seg.data?.qq;
      if (qq === "all") parts.push("@全体成员");
      else parts.push(`@${qq}`);
    }
    else if (seg.type === "image") parts.push("[图片]");
    else if (seg.type === "face") parts.push("[表情]");
    else if (seg.type === "record") parts.push("[语音]");
    else if (seg.type === "video") parts.push("[视频]");
    else if (seg.type === "reply") { /* skip reply indicator */ }
    else if (seg.type === "forward") parts.push("[转发消息]");
    else if (seg.type === "json") parts.push("[卡片消息]");
    else if (seg.type === "xml") parts.push("[XML消息]");
    else parts.push(`[${seg.type}]`);
  }
  return parts.join("").trim();
}

function formatMessage(msg: any): string {
  const time = formatTime(msg.time);
  const name = msg.sender?.card || msg.sender?.nickname || String(msg.user_id);
  let text: string;
  if (Array.isArray(msg.message)) {
    text = extractTextFromSegments(msg.message as MsgSegment[]);
  } else {
    text = msg.raw_message || "";
  }
  // Skip empty messages
  if (!text.trim()) return "";
  return `[${time}] ${name}: ${text}`;
}

/* ---- Plugin entry ---- */

const plugin = {
  id: "chat-summary",
  name: "Chat Summary",
  description: "获取QQ群聊历史消息，用于总结群聊内容",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig || {};
    const napCatUrl = config.napcat_http_url || process.env.NAPCAT_HTTP_URL || "http://127.0.0.1:3002";
    const napCatToken = config.napcat_token || process.env.NAPCAT_TOKEN || "";

    api.registerTool({
      name: "chat_summary",
      label: "群聊历史",
      description: `获取QQ群的最近聊天记录，返回格式化的消息列表。你可以基于这些聊天记录进行总结、分析话题、回答关于群聊内容的问题。

参数说明：
- group_id: QQ群号（必填）。你当前所在群的群号可以从对话上下文获取。
- count: 获取的消息条数，默认50，最大200。

使用场景：
- 用户要求"总结一下群聊"、"今天群里聊了什么"
- 用户想知道群里最近在讨论什么话题
- 用户要求回顾某段时间的聊天内容

注意：返回的是原始聊天记录，你需要自己进行总结分析。`,
      parameters: Type.Object({
        group_id: Type.Union([Type.String(), Type.Number()], {
          description: "QQ群号。从对话上下文获取当前群号。",
        }),
        count: Type.Optional(
          Type.Number({
            description: "获取的消息条数（默认50，最大200）",
          })
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const groupId = params.group_id;
        if (!groupId) {
          return { error: "需要提供 group_id 参数（QQ群号）" };
        }

        const count = Math.min(Math.max(Number(params.count) || 50, 1), 200);

        try {
          const resp = await napCatPost(napCatUrl, napCatToken, "/get_group_msg_history", {
            group_id: Number(groupId),
            count,
          });

          if (resp.retcode !== 0) {
            return { error: `NapCat API 错误: ${resp.status} (retcode=${resp.retcode})`, group_id: groupId };
          }

          const messages: any[] = resp.data?.messages || [];
          if (messages.length === 0) {
            return { group_id: groupId, message_count: 0, messages: "暂无聊天记录" };
          }

          // Format messages
          const formatted = messages
            .map(formatMessage)
            .filter((line) => line.length > 0);

          // Build time range info
          const firstTime = messages[0]?.time;
          const lastTime = messages[messages.length - 1]?.time;
          const timeRange = firstTime && lastTime
            ? `${new Date(firstTime * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} ~ ${new Date(lastTime * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
            : "未知";

          // Gather unique participants
          const participants = new Set<string>();
          for (const msg of messages) {
            const name = msg.sender?.card || msg.sender?.nickname;
            if (name) participants.add(name);
          }

          console.log(`[chat-summary] group=${groupId} fetched=${messages.length} formatted=${formatted.length}`);

          return {
            group_id: groupId,
            message_count: formatted.length,
            total_fetched: messages.length,
            time_range: timeRange,
            participants: Array.from(participants).join(", "),
            participant_count: participants.size,
            chat_log: formatted.join("\n"),
          };
        } catch (err) {
          return { error: `获取群聊记录失败: ${String(err)}`, group_id: groupId };
        }
      },
    });

    console.log(`[chat-summary] Registered chat_summary tool (NapCat HTTP: ${napCatUrl})`);
  },
};

export default plugin;
