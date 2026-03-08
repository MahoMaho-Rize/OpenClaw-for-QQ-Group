import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Trivia Plugin                                                       */
/*  Open Trivia DB + Chuck Norris Jokes + PoetryDB                      */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "OpenClaw-Bot/1.0";

/* ---- HTTP helper (IPv4-only) ---- */

function httpGet(url: string, timeout = REQUEST_TIMEOUT): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname, path: u.pathname + u.search,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        family: 4, timeout,
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate" },
      },
      (res) => {
        let stream: NodeJS.ReadableStream = res;
        const enc = res.headers["content-encoding"];
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout ${timeout}ms`)); });
  });
}

/* ---- HTML entity decoder ---- */

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const plugin = {
  id: "trivia",
  name: "Trivia & Fun",
  description: "趣味问答 + 笑话 + 诗歌",

  register(api: OpenClawPluginApi) {
    /* ---- trivia_question ---- */
    api.registerTool({
      name: "trivia_question",
      label: "趣味问答",
      description: `从 Open Trivia Database 获取随机趣味问答题（多选题）。
返回题目、分类、难度、正确答案和错误选项。

使用场景：
- "来几道趣味问答题"
- "给我出5道知识问答"
- "来点冷知识题目"`,
      parameters: Type.Object({
        amount: Type.Optional(Type.Number({ description: "题目数量（默认1，最大50）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const amount = Math.min(Math.max(Number(params.amount) || 1, 1), 50);

        try {
          const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `Open Trivia DB HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          if (data.response_code !== 0) {
            const codes: Record<number, string> = {
              1: "题库中没有足够的题目",
              2: "无效参数",
              3: "Token 未找到",
              4: "Token 已用尽所有题目",
              5: "请求过于频繁，请稍后再试",
            };
            return { error: codes[data.response_code] || `API 错误代码: ${data.response_code}` };
          }

          const questions = data.results.map((q: any) => ({
            category: decodeHtmlEntities(q.category),
            difficulty: q.difficulty,
            question: decodeHtmlEntities(q.question),
            correct_answer: decodeHtmlEntities(q.correct_answer),
            wrong_answers: q.incorrect_answers.map((a: string) => decodeHtmlEntities(a)),
          }));

          return {
            count: questions.length,
            questions,
          };
        } catch (err) {
          return { error: `趣味问答查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- random_joke ---- */
    api.registerTool({
      name: "random_joke",
      label: "随机笑话",
      description: `获取一条随机 Chuck Norris 笑话。
可选按分类筛选（如 dev、science、sport 等）。

使用场景：
- "讲个笑话"
- "来个程序员笑话"
- "Chuck Norris 笑话"`,
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "笑话分类（如 dev、science、sport、animal、music、food 等，不填则随机）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const category = params.category as string | undefined;

        try {
          let url = "https://api.chucknorris.io/jokes/random";
          if (category && category.trim()) {
            url += `?category=${encodeURIComponent(category.trim().toLowerCase())}`;
          }

          const res = await httpGet(url);
          if (res.status !== 200) {
            if (res.status === 404) return { error: `分类 "${category}" 不存在。可用分类请不带参数调用查看。` };
            return { error: `Chuck Norris API HTTP ${res.status}` };
          }
          const data = JSON.parse(res.data);

          return {
            joke: data.value,
            id: data.id,
            categories: data.categories?.length > 0 ? data.categories : ["uncategorized"],
            url: data.url,
          };
        } catch (err) {
          return { error: `笑话查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- random_poem ---- */
    api.registerTool({
      name: "random_poem",
      label: "随机诗歌",
      description: `从 PoetryDB 获取英文诗歌。
支持随机获取、按作者搜索、按标题搜索。

使用场景：
- "来一首随机诗歌"
- "给我一首 Shakespeare 的诗"
- "搜索标题包含 love 的诗"`,
      parameters: Type.Object({
        author: Type.Optional(Type.String({ description: "按作者搜索（如 Shakespeare、Emily Dickinson）" })),
        title: Type.Optional(Type.String({ description: "按标题搜索（如 Sonnet、Love）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const author = params.author as string | undefined;
        const title = params.title as string | undefined;

        try {
          let url: string;
          if (author && author.trim()) {
            url = `https://poetrydb.org/author/${encodeURIComponent(author.trim())}`;
          } else if (title && title.trim()) {
            url = `https://poetrydb.org/title/${encodeURIComponent(title.trim())}`;
          } else {
            url = "https://poetrydb.org/random/1";
          }

          const res = await httpGet(url);
          if (res.status !== 200) return { error: `PoetryDB HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          if (data.status && data.status === 404) {
            return { error: data.reason || "未找到匹配的诗歌" };
          }

          const poems = Array.isArray(data) ? data : [data];

          // For author/title searches that may return many results, limit to 5
          const limited = poems.slice(0, 5);

          const result = limited.map((p: any) => ({
            title: p.title,
            author: p.author,
            lines: p.lines,
            linecount: p.linecount ? Number(p.linecount) : p.lines?.length,
          }));

          return {
            count: result.length,
            total_matches: poems.length,
            poems: result,
            note: poems.length > 5 ? `共找到 ${poems.length} 首诗，仅展示前5首。` : undefined,
          };
        } catch (err) {
          return { error: `诗歌查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[trivia] Registered trivia_question + random_joke + random_poem tools");
  },
};

export default plugin;
