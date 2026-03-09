import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  DeepWiki Plugin                                                    */
/*  Uses DeepWiki MCP server (free, no auth) to explore & ask about   */
/*  any public GitHub repository's documentation.                      */
/*  Endpoint: POST https://mcp.deepwiki.com/mcp (JSON-RPC 2.0 / SSE) */
/* ------------------------------------------------------------------ */

const MCP_URL = "https://mcp.deepwiki.com/mcp";
const REQUEST_TIMEOUT = 60_000; // ask_question can take ~15-20s
const STRUCTURE_TIMEOUT = 15_000;

/* ---- MCP JSON-RPC helper ---- */

interface McpResult {
  text: string;
  isError: boolean;
}

/**
 * Call a DeepWiki MCP tool via JSON-RPC 2.0 over Streamable HTTP.
 * Response is SSE: we parse the last `data:` line containing the result.
 */
function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  timeout: number = REQUEST_TIMEOUT
): Promise<McpResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  return new Promise((resolve, reject) => {
    const u = new URL(MCP_URL);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        port: 443,
        method: "POST",
        family: 4,
        timeout,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
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
            reject(new Error(`DeepWiki HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }

          // Parse SSE: find the last "data:" line with a JSON-RPC result
          const lines = raw.split("\n");
          let resultJson: string | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (payload.includes('"result"')) {
                resultJson = payload;
                break;
              }
            }
          }

          if (!resultJson) {
            // Maybe the whole response is plain JSON (non-SSE)
            try {
              const plain = JSON.parse(raw);
              if (plain.result) {
                resultJson = raw;
              }
            } catch {}
          }

          if (!resultJson) {
            reject(new Error(`DeepWiki: no result in response (${raw.slice(0, 200)})`));
            return;
          }

          try {
            const parsed = JSON.parse(resultJson);
            const result = parsed.result;
            const isError = result?.isError === true;
            const textContent = result?.content?.[0]?.text || result?.structuredContent?.result || "";
            resolve({ text: textContent, isError });
          } catch (e) {
            reject(new Error(`DeepWiki: failed to parse result JSON: ${String(e)}`));
          }
        });
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`DeepWiki request timeout (${timeout}ms)`));
    });

    req.write(body);
    req.end();
  });
}

/* ---- Helpers ---- */

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

function parseRepoName(input: string): string | null {
  let s = input.trim();
  // Handle full URLs: https://github.com/owner/repo or https://deepwiki.com/owner/repo
  const urlMatch = s.match(/(?:github\.com|deepwiki\.com)\/([\w.-]+\/[\w.-]+)/i);
  if (urlMatch) return urlMatch[1];
  // Handle owner/repo format
  const slashMatch = s.match(/^([\w.-]+\/[\w.-]+)$/);
  if (slashMatch) return slashMatch[1];
  return null;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.substring(0, max) + "…" : s;
}

/* ---- Plugin ---- */

const plugin = {
  id: "deepwiki",
  name: "DeepWiki",
  description: "AI-powered documentation explorer for any public GitHub repository",

  register(api: OpenClawPluginApi) {
    /* ---- deepwiki_explore ---- */
    api.registerTool({
      name: "deepwiki_explore",
      label: "DeepWiki 仓库文档浏览",
      description: `浏览任意公开 GitHub 仓库的 AI 生成文档目录结构。
输入仓库名（owner/repo 格式或 GitHub URL），返回文档主题列表。
适用场景：了解一个项目的整体架构、模块划分、文档有哪些章节。`,
      parameters: Type.Object({
        repo: Type.String({
          description:
            "GitHub 仓库，支持 owner/repo 格式（如 facebook/react）或完整 GitHub URL",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const repoInput = params.repo as string;
        const repoName = parseRepoName(repoInput);
        if (!repoName) {
          return text("❌ 无法识别仓库名。请使用 owner/repo 格式，如 facebook/react");
        }

        console.log(`[deepwiki] explore: ${repoName}`);

        try {
          const result = await mcpCall(
            "read_wiki_structure",
            { repoName },
            STRUCTURE_TIMEOUT
          );

          if (result.isError) {
            return text(`❌ DeepWiki 返回错误: ${truncate(result.text, 300)}`);
          }

          const output = [
            `📚 ${repoName} 文档结构`,
            "",
            result.text,
            "",
            `数据来源：DeepWiki (deepwiki.com/${repoName})`,
          ].join("\n");

          return text(output);
        } catch (err) {
          console.error(`[deepwiki] explore error:`, err);
          return text(`❌ DeepWiki 查询失败: ${String(err)}`);
        }
      },
    });

    /* ---- deepwiki_ask ---- */
    api.registerTool({
      name: "deepwiki_ask",
      label: "DeepWiki 仓库提问",
      description: `对任意公开 GitHub 仓库提出技术问题，获取 AI 生成的详细回答。
基于仓库源码和文档的 RAG 检索增强生成，回答准确且附带代码示例。
适用场景：理解某个库的用法、架构设计、实现原理、API 细节等。
支持同时查询最多 10 个仓库。`,
      parameters: Type.Object({
        repo: Type.String({
          description:
            "GitHub 仓库，支持 owner/repo 格式或 URL。查询多个仓库用逗号分隔，如 facebook/react,vercel/next.js",
        }),
        question: Type.String({
          description: "要提问的技术问题，越具体越好",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const repoInput = (params.repo as string).trim();
        const question = (params.question as string).trim();

        if (!question) {
          return text("❌ 请提供要提问的问题");
        }

        // Support comma-separated repos
        const repoParts = repoInput.split(/[,，\s]+/).filter(Boolean);
        const repoNames: string[] = [];
        for (const part of repoParts) {
          const name = parseRepoName(part);
          if (name) repoNames.push(name);
        }

        if (repoNames.length === 0) {
          return text("❌ 无法识别仓库名。请使用 owner/repo 格式，如 facebook/react");
        }

        if (repoNames.length > 10) {
          return text("❌ 最多同时查询 10 个仓库");
        }

        const repoArg = repoNames.length === 1 ? repoNames[0] : repoNames;
        const repoDisplay = repoNames.join(", ");

        console.log(`[deepwiki] ask: ${repoDisplay} — "${truncate(question, 60)}"`);

        try {
          const result = await mcpCall(
            "ask_question",
            { repoName: repoArg, question },
            REQUEST_TIMEOUT
          );

          if (result.isError) {
            return text(`❌ DeepWiki 返回错误: ${truncate(result.text, 300)}`);
          }

          const output = [
            result.text,
            "",
            `数据来源：DeepWiki (deepwiki.com/${repoNames[0]})`,
          ].join("\n");

          return text(output);
        } catch (err) {
          console.error(`[deepwiki] ask error:`, err);
          return text(`❌ DeepWiki 查询失败: ${String(err)}`);
        }
      },
    });

    console.log(
      "[deepwiki] Registered 2 tools: deepwiki_explore, deepwiki_ask"
    );
  },
};

export default plugin;
