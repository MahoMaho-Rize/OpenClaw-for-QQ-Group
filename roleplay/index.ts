import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/*  Roleplay Plugin                                                    */
/*  Multiple character personas backed by free SiliconFlow models.     */
/*                                                                     */
/*  Directory structure:                                               */
/*    characters/{角色名}/                                              */
/*      persona.md        — frontmatter + system prompt                */
/*      memory/           — per-group conversation memory              */
/*        qq-group-XXXXX.md                                            */
/*        qq-dm-XXXXX.md                                               */
/*                                                                     */
/*  persona.md format (same as old .md files):                         */
/*    ---                                                              */
/*    name: 若叶睦                                                      */
/*    aliases: 若叶睦,睦,mutsumi,mortis,墨缇丝                          */
/*    model: THUDM/GLM-4.1V-9B-Thinking                               */
/*    temperature: 0.85                                                */
/*    max_tokens: 1024                                                 */
/*    ---                                                              */
/*    (rest of file is the system prompt / SOUL)                       */
/* ------------------------------------------------------------------ */

const SF_API_BASE = "https://api.siliconflow.cn";
const DEFAULT_MODEL = "THUDM/GLM-4.1V-9B-Thinking";
const DEFAULT_TEMPERATURE = 0.85;
const DEFAULT_MAX_TOKENS = 1024;
const REQUEST_TIMEOUT = 30_000;
const MAX_MEMORY_CHARS = 3000; // Max chars of memory injected into system prompt
const MAX_MEMORY_LINES = 100; // Trim oldest lines when exceeding this

/* ---- Character type ---- */

interface Character {
  name: string;
  aliases: string[];
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  dirName: string; // directory name under characters/
  dirPath: string; // absolute path to character directory
}

/* ---- Load characters from per-character subdirectories ---- */

function parseCharacterDir(charDirPath: string): Character | null {
  const personaPath = path.join(charDirPath, "persona.md");
  const dirName = path.basename(charDirPath);

  if (!fs.existsSync(personaPath)) {
    // Backwards compat: also check for .md file with same name as dir
    console.warn(`[roleplay] ${dirName}/persona.md not found, skipping`);
    return null;
  }

  try {
    const raw = fs.readFileSync(personaPath, "utf-8");

    // Parse YAML frontmatter between --- delimiters
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
      console.warn(`[roleplay] ${dirName}/persona.md: no frontmatter found, skipping`);
      return null;
    }

    const frontmatter = match[1];
    const body = match[2].trim();

    if (!body) {
      console.warn(`[roleplay] ${dirName}/persona.md: empty body, skipping`);
      return null;
    }

    // Simple YAML parsing (key: value)
    const meta: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }

    const name = meta.name || dirName;
    const aliases = (meta.aliases || name)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    return {
      name,
      aliases,
      systemPrompt: body,
      model: meta.model || DEFAULT_MODEL,
      temperature: parseFloat(meta.temperature || "") || DEFAULT_TEMPERATURE,
      maxTokens: parseInt(meta.max_tokens || "", 10) || DEFAULT_MAX_TOKENS,
      dirName,
      dirPath: charDirPath,
    };
  } catch (err) {
    console.error(`[roleplay] Failed to parse ${dirName}/persona.md:`, err);
    return null;
  }
}

function loadCharacters(pluginDir: string): Character[] {
  const charDir = path.join(pluginDir, "characters");
  if (!fs.existsSync(charDir)) {
    console.warn(`[roleplay] characters/ directory not found at ${charDir}`);
    return [];
  }

  const entries = fs.readdirSync(charDir, { withFileTypes: true });
  const chars: Character[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const char = parseCharacterDir(path.join(charDir, entry.name));
    if (char) chars.push(char);
  }

  return chars;
}

/* ---- Memory (per-character, per-group) ---- */

function getMemoryPath(character: Character, groupKey: string): string {
  return path.join(character.dirPath, "memory", `${groupKey}.md`);
}

function readMemory(character: Character, groupKey: string): string {
  const memPath = getMemoryPath(character, groupKey);
  try {
    if (!fs.existsSync(memPath)) return "";
    let content = fs.readFileSync(memPath, "utf-8").trim();
    // Truncate to max chars if too long (keep the tail = recent memory)
    if (content.length > MAX_MEMORY_CHARS) {
      const lines = content.split("\n");
      // Keep recent lines that fit within limit
      const kept: string[] = [];
      let total = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (total + lines[i].length + 1 > MAX_MEMORY_CHARS) break;
        kept.unshift(lines[i]);
        total += lines[i].length + 1;
      }
      content = kept.join("\n");
    }
    return content;
  } catch {
    return "";
  }
}

function appendMemory(character: Character, groupKey: string, entry: string): void {
  const memPath = getMemoryPath(character, groupKey);
  const memDir = path.dirname(memPath);

  try {
    // Ensure memory directory exists
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }

    // Read existing content
    let existing = "";
    if (fs.existsSync(memPath)) {
      existing = fs.readFileSync(memPath, "utf-8");
    }

    // Trim old lines if too many
    const lines = existing.trim().split("\n").filter(Boolean);
    if (lines.length >= MAX_MEMORY_LINES) {
      // Keep only recent half
      const kept = lines.slice(Math.floor(lines.length / 2));
      existing = kept.join("\n") + "\n";
    }

    // Append new entry
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `[${timestamp}] ${entry}\n`;
    fs.writeFileSync(memPath, existing.trimEnd() + "\n" + line, "utf-8");
  } catch (err) {
    console.error(`[roleplay] Failed to write memory for ${character.name}:`, err);
  }
}

/* ---- Extract group key from tool call context ---- */

function extractGroupKey(params: Record<string, unknown>): string {
  // The context param may contain group info, or we use a default
  const context = (params.context as string | undefined) || "";

  // Try to extract group id from context like "qq-group:689961939" or "群号689961939"
  const groupMatch = context.match(/(?:qq-group[:\-]?|群号?)(\d{6,})/i);
  if (groupMatch) return `qq-group-${groupMatch[1]}`;

  const dmMatch = context.match(/(?:qq-dm[:\-]?|私聊)(\d{6,})/i);
  if (dmMatch) return `qq-dm-${dmMatch[1]}`;

  // Fallback: global (shared across all contexts without group info)
  return "global";
}

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
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
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
              reject(new Error("SiliconFlow: no choices in response"));
              return;
            }

            let content = choice.message?.content || "";
            // Strip <think>...</think> blocks from thinking models
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

function findCharacter(characters: Character[], query: string): Character | null {
  const q = query.toLowerCase().trim();
  // Exact match first
  for (const char of characters) {
    for (const alias of char.aliases) {
      if (alias.toLowerCase() === q) return char;
    }
  }
  // Fuzzy: contains
  for (const char of characters) {
    for (const alias of char.aliases) {
      if (q.includes(alias.toLowerCase()) || alias.toLowerCase().includes(q)) {
        return char;
      }
    }
  }
  return null;
}

/* ---- Plugin ---- */

// Resolve plugin directory
const PLUGIN_DIR = path.dirname(
  typeof __filename !== "undefined"
    ? __filename
    : new URL(import.meta.url).pathname
);

const plugin = {
  id: "roleplay",
  name: "Roleplay",
  description: "Character roleplay chat backed by free SiliconFlow models",

  register(api: OpenClawPluginApi) {
    const apiKey = api.pluginConfig?.siliconflowApiKey as string;
    const characters = loadCharacters(PLUGIN_DIR);

    if (!apiKey) {
      console.warn("[roleplay] ⚠ No siliconflowApiKey configured. API calls will fail.");
    }

    if (characters.length === 0) {
      console.warn("[roleplay] ⚠ No characters found in characters/ subdirectories.");
    } else {
      console.log(
        `[roleplay] Loaded ${characters.length} characters: ${characters.map((c) => c.name).join(", ")}`
      );
    }

    /* ---- character_chat ---- */
    api.registerTool({
      name: "character_chat",
      label: "角色扮演对话",
      description: `与BanG Dream!角色进行对话。每个角色有独立人格、语气和记忆。
当用户想和特定角色聊天时使用（如"找睦聊天"、"让灯说…"、"问问爱音"）。
${characters.length > 0 ? `可用角色：${characters.map((c) => c.name).join("、")}` : "暂无可用角色。"}
注意：丰川祥子是本bot，不在角色列表中。回复由免费模型生成，仅供娱乐。`,
      parameters: Type.Object({
        character: Type.String({
          description: `角色名称或别名。${characters.length > 0 ? `可选：${characters.map((c) => `${c.name}(${c.aliases.slice(0, 3).join("/")})` ).join("、")}` : "暂无"}`,
        }),
        message: Type.String({
          description: "用户想对该角色说的话",
        }),
        context: Type.Optional(
          Type.String({
            description: "对话上下文。请传入当前群标识（如 qq-group:689961939 或 qq-dm:1619287560），用于加载该群的角色记忆。也可附加额外背景信息。",
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

        if (!userMessage) return text("❌ 请输入想说的话");

        const character = findCharacter(characters, characterQuery);
        if (!character) {
          const available =
            characters.length > 0
              ? `当前可用角色：${characters.map((c) => c.name).join("、")}`
              : "当前没有可用角色";
          return text(`❌ 找不到角色「${characterQuery}」。${available}`);
        }

        // Extract group key for memory
        const groupKey = extractGroupKey(params);

        console.log(
          `[roleplay] ${character.name} (${character.model}) [${groupKey}] ← "${userMessage.slice(0, 50)}"`
        );

        // Build messages: persona + memory + context + user message
        const messages: { role: string; content: string }[] = [
          { role: "system", content: character.systemPrompt },
        ];

        // Inject memory if available
        const memory = readMemory(character, groupKey);
        if (memory) {
          messages.push({
            role: "system",
            content: `[对话记忆 — 你之前在这个群里的互动记录，用于保持一致性]\n${memory}`,
          });
        }

        if (context) {
          // Strip the group key part from context before injecting
          const cleanContext = context
            .replace(/qq-group[:\-]?\d+/gi, "")
            .replace(/qq-dm[:\-]?\d+/gi, "")
            .trim();
          if (cleanContext) {
            messages.push({ role: "system", content: `[对话背景] ${cleanContext}` });
          }
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

          // Append to memory: one-line summary of this interaction
          const userSnippet = userMessage.length > 60 ? userMessage.slice(0, 60) + "…" : userMessage;
          const replySnippet = reply.length > 80 ? reply.slice(0, 80) + "…" : reply;
          appendMemory(character, groupKey, `用户说「${userSnippet}」→ ${character.name}回复「${replySnippet}」`);

          return text(reply);
        } catch (err) {
          console.error(`[roleplay] ${character.name} error:`, err);
          return text(`❌ ${character.name}暂时无法回应: ${String(err).slice(0, 100)}`);
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
        if (characters.length === 0) {
          return text("当前没有可用的角色。角色正在招募中～");
        }

        const lines = characters.map((c, i) => {
          const aliases = c.aliases.filter((a) => a !== c.name).slice(0, 3);
          const aliasStr = aliases.length > 0 ? `（${aliases.join("、")}）` : "";
          return `${i + 1}. ${c.name}${aliasStr}`;
        });

        return text(
          [`🎭 可用角色：`, "", ...lines, "", "用「找XX聊天」或「让XX说…」来召唤ta们吧"].join("\n")
        );
      },
    });

    console.log(
      `[roleplay] Registered 2 tools, ${characters.length} characters (per-dir structure with memory)`
    );
  },
};

export default plugin;
