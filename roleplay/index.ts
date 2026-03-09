import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Roleplay Plugin                                                    */
/*  Multiple character personas backed by free SiliconFlow models.     */
/*  Characters are defined in the CHARACTERS array below.              */
/*  Each character has a name, aliases, system prompt, and model.      */
/* ------------------------------------------------------------------ */

const SF_API_BASE = "https://api.siliconflow.cn";
const REQUEST_TIMEOUT = 30_000;

/* ---- Character definitions ---- */

interface Character {
  /** Display name */
  name: string;
  /** Trigger aliases (lowercase). First one is the canonical name. */
  aliases: string[];
  /** System prompt that defines the character's personality */
  systemPrompt: string;
  /** SiliconFlow model ID */
  model: string;
  /** Sampling temperature (0-2). Default 0.8 */
  temperature?: number;
  /** Max output tokens. Default 1024 */
  maxTokens?: number;
}

/*
 * ============================================================
 *  CHARACTER ROSTER — 在这里添加角色
 *  每个角色需要: name, aliases, systemPrompt, model
 *
 *  可用的免费模型:
 *    - Qwen/Qwen3.5-4B              (快，中文好)
 *    - deepseek-ai/DeepSeek-R1-Distill-Qwen-7B  (会推理)
 *    - THUDM/GLM-4.1V-9B-Thinking   (理性，稳)
 *
 *  示例角色（取消注释并修改即可启用）:
 *  {
 *    name: "御坂美琴",
 *    aliases: ["御坂美琴", "美琴", "炮姐", "misaka"],
 *    systemPrompt: "你是御坂美琴……（人设描述）",
 *    model: "Qwen/Qwen3.5-4B",
 *    temperature: 0.85,
 *  },
 * ============================================================
 */
const CHARACTERS: Character[] = [
  // 在这里添加角色，格式参考上面的示例
];

/* ---- HTTP helper for SiliconFlow (OpenAI-compatible) ---- */

interface SFResponse {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function sfChatCompletion(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<SFResponse> {
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const u = new URL(`${SF_API_BASE}/v1/chat/completions`);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        port: 443,
        method: "POST",
        family: 4,
        timeout: REQUEST_TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
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
          const raw = Buffer.concat(chunks).toString("utf8");

          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`SiliconFlow HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }

          try {
            const data = JSON.parse(raw);
            const choice = data.choices?.[0];
            if (!choice) {
              reject(new Error(`SiliconFlow: no choices in response`));
              return;
            }

            // Handle thinking models: they may have reasoning_content + content
            let content = choice.message?.content || "";
            // Strip any <think>...</think> blocks from the response
            content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

            resolve({
              content,
              model: data.model || model,
              usage: data.usage,
            });
          } catch (e) {
            reject(new Error(`SiliconFlow: parse error: ${String(e)}`));
          }
        });
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`SiliconFlow request timeout (${REQUEST_TIMEOUT}ms)`));
    });

    req.write(body);
    req.end();
  });
}

/* ---- Helpers ---- */

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

function findCharacter(query: string): Character | null {
  const q = query.toLowerCase().trim();
  for (const char of CHARACTERS) {
    for (const alias of char.aliases) {
      if (alias.toLowerCase() === q) return char;
    }
  }
  // Fuzzy: check if query contains any alias or vice versa
  for (const char of CHARACTERS) {
    for (const alias of char.aliases) {
      if (q.includes(alias.toLowerCase()) || alias.toLowerCase().includes(q)) {
        return char;
      }
    }
  }
  return null;
}

/* ---- Plugin ---- */

const plugin = {
  id: "roleplay",
  name: "Roleplay",
  description: "Character roleplay chat backed by free SiliconFlow models",

  register(api: OpenClawPluginApi) {
    const apiKey = api.pluginConfig?.siliconflowApiKey as string;

    if (!apiKey) {
      console.warn(
        "[roleplay] ⚠ No siliconflowApiKey in plugin config. Plugin loaded but API calls will fail."
      );
    }

    if (CHARACTERS.length === 0) {
      console.warn(
        "[roleplay] ⚠ No characters defined. Add characters to the CHARACTERS array in index.ts."
      );
    }

    /* ---- character_chat ---- */
    api.registerTool({
      name: "character_chat",
      label: "角色扮演对话",
      description: `与不同角色进行对话。每个角色有独立的性格和说话风格，由不同的AI模型驱动。
当用户想要和特定角色聊天时使用此工具。
${CHARACTERS.length > 0 ? `当前可用角色：${CHARACTERS.map((c) => c.name).join("、")}` : "暂无可用角色。"}
注意：角色的回复仅供娱乐，不代表任何真实人物或组织的观点。`,
      parameters: Type.Object({
        character: Type.String({
          description: `角色名称。${CHARACTERS.length > 0 ? `可选：${CHARACTERS.map((c) => `${c.name}(${c.aliases.slice(0, 3).join("/")})` ).join("、")}` : "暂无可用角色"}`,
        }),
        message: Type.String({
          description: "用户想对该角色说的话",
        }),
        context: Type.Optional(
          Type.String({
            description:
              "可选的对话上下文/背景信息，帮助角色更好地理解对话场景",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        if (!apiKey) {
          return text("❌ 角色扮演功能未配置 API Key，请联系管理员");
        }

        const characterQuery = (params.character as string).trim();
        const userMessage = (params.message as string).trim();
        const context = (params.context as string | undefined)?.trim();

        if (!userMessage) {
          return text("❌ 请输入想说的话");
        }

        const character = findCharacter(characterQuery);
        if (!character) {
          const available =
            CHARACTERS.length > 0
              ? `当前可用角色：${CHARACTERS.map((c) => c.name).join("、")}`
              : "当前没有可用角色";
          return text(`❌ 找不到角色「${characterQuery}」。${available}`);
        }

        console.log(
          `[roleplay] ${character.name} (${character.model}) ← "${userMessage.slice(0, 50)}"`
        );

        const messages: { role: string; content: string }[] = [
          { role: "system", content: character.systemPrompt },
        ];

        if (context) {
          messages.push({
            role: "system",
            content: `[对话背景] ${context}`,
          });
        }

        messages.push({ role: "user", content: userMessage });

        try {
          const result = await sfChatCompletion(apiKey, character.model, messages, {
            temperature: character.temperature,
            maxTokens: character.maxTokens,
          });

          const reply = result.content;
          if (!reply) {
            return text(`❌ ${character.name}沉默了……（模型返回空内容）`);
          }

          console.log(
            `[roleplay] ${character.name} → ${reply.length} chars, ${result.usage?.total_tokens ?? "?"} tokens`
          );

          return text(reply);
        } catch (err) {
          console.error(`[roleplay] ${character.name} error:`, err);
          return text(
            `❌ ${character.name}暂时无法回应: ${String(err).slice(0, 100)}`
          );
        }
      },
    });

    /* ---- character_list ---- */
    api.registerTool({
      name: "character_list",
      label: "角色列表",
      description: `列出所有可用的角色扮演角色。
当用户问"有哪些角色/能找谁聊天"时使用此工具。`,
      parameters: Type.Object({}),
      execute: async () => {
        if (CHARACTERS.length === 0) {
          return text("当前没有可用的角色。角色正在招募中～");
        }

        const lines = CHARACTERS.map((c, i) => {
          const aliases = c.aliases.slice(1); // skip first (usually same as name)
          const aliasStr = aliases.length > 0 ? `（也叫：${aliases.join("、")}）` : "";
          return `${i + 1}. ${c.name}${aliasStr}`;
        });

        return text(
          [`🎭 可用角色：`, "", ...lines, "", "用「找XX聊天」或「让XX说…」来召唤角色"].join(
            "\n"
          )
        );
      },
    });

    console.log(
      `[roleplay] Registered 2 tools (character_chat, character_list), ${CHARACTERS.length} characters loaded`
    );
  },
};

export default plugin;
