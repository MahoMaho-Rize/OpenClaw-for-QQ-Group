import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// §0  Types & Constants
// ============================================================

interface SearchResult {
  id: string;
  document: string;
  score: number;
  metadata: Record<string, string>;
}

/** Query log entry */
interface QueryLogEntry {
  ts: string;
  queryId: string;
  query: string;
  topK: number;
  tag?: string;
  backend: "chroma" | "local";
  results: {
    id: string;
    score: number;
    title: string;
    textPreview: string;
  }[];
  latencyMs: number;
}

/** Feedback entry */
interface FeedbackEntry {
  ts: string;
  queryId: string;
  rating: "good" | "bad" | "partial";
  comment?: string;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3";
const EMBEDDING_API_URL = "https://api.siliconflow.cn/v1/embeddings";
const DEFAULT_CHROMA_URL = "http://127.0.0.1:8100";
const DEFAULT_CHROMA_COLLECTION = "moegirl_wiki";

// ============================================================
// §1  HTTP Helpers
// ============================================================

/** IPv4-only HTTPS request */
function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts: https.RequestOptions = {
      ...options,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      family: 4,
    };
    const req = https.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() })
      );
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

/** Local HTTP request (for ChromaDB on localhost) */
function httpRequest(
  url: string,
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts: http.RequestOptions = {
      ...options,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      family: 4,
    };
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() })
      );
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => { req.destroy(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================
// §2  Embedding Provider (SiliconFlow)
// ============================================================

async function getEmbeddings(
  texts: string[],
  apiKey: string,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number[][]> {
  const body = JSON.stringify({ model, input: texts, encoding_format: "float" });
  const res = await httpsRequest(EMBEDDING_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  }, body);
  if (res.status !== 200) {
    throw new Error(`Embedding API error ${res.status}: ${res.data.slice(0, 200)}`);
  }
  const json = JSON.parse(res.data);
  const sorted = (json.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

async function getEmbedding(text: string, apiKey: string, model?: string): Promise<number[]> {
  return (await getEmbeddings([text], apiKey, model))[0];
}

// ============================================================
// §3  ChromaDB HTTP Client
// ============================================================

class ChromaClient {
  private baseUrl: string;
  private collectionName: string;
  private collectionId: string | null = null;

  constructor(baseUrl: string, collectionName: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.collectionName = collectionName;
  }

  private get v2Base(): string {
    return `${this.baseUrl}/api/v2/tenants/default_tenant/databases/default_database`;
  }

  /** Resolve collection name → collection ID (cached) */
  private async getCollectionId(): Promise<string> {
    if (this.collectionId) return this.collectionId;

    const res = await httpRequest(
      `${this.v2Base}/collections/${encodeURIComponent(this.collectionName)}`,
      { method: "GET", headers: { "Content-Type": "application/json" } }
    );

    if (res.status === 200) {
      const data = JSON.parse(res.data);
      this.collectionId = data.id;
      return this.collectionId!;
    }

    throw new Error(`Collection "${this.collectionName}" not found (status ${res.status}): ${res.data.slice(0, 200)}`);
  }

  /** Query by embedding vector */
  async query(queryEmbedding: number[], nResults: number = 5, whereFilter?: Record<string, unknown>): Promise<SearchResult[]> {
    const collId = await this.getCollectionId();

    const payload: Record<string, unknown> = {
      query_embeddings: [queryEmbedding],
      n_results: nResults,
      include: ["documents", "metadatas", "distances"],
    };
    if (whereFilter) payload.where = whereFilter;

    const res = await httpRequest(
      `${this.v2Base}/collections/${collId}/query`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      JSON.stringify(payload)
    );

    if (res.status !== 200) {
      throw new Error(`ChromaDB query failed (${res.status}): ${res.data.slice(0, 200)}`);
    }

    const data = JSON.parse(res.data);
    const ids: string[] = data.ids?.[0] || [];
    const documents: string[] = data.documents?.[0] || [];
    const metadatas: Record<string, string>[] = data.metadatas?.[0] || [];
    const distances: number[] = data.distances?.[0] || [];

    return ids.map((id, i) => ({
      id,
      document: documents[i] || "",
      // ChromaDB cosine distance = 1 - similarity; convert to similarity
      score: 1 - (distances[i] || 0),
      metadata: metadatas[i] || {},
    }));
  }

  /** Health check */
  async heartbeat(): Promise<{ ok: boolean; version?: string; collections?: number }> {
    try {
      const res = await httpRequest(`${this.baseUrl}/api/v2/heartbeat`, { method: "GET" });
      if (res.status !== 200) return { ok: false };

      const listRes = await httpRequest(
        `${this.v2Base}/collections`,
        { method: "GET", headers: { "Content-Type": "application/json" } }
      );
      let collections = 0;
      if (listRes.status === 200) {
        const arr = JSON.parse(listRes.data);
        collections = Array.isArray(arr) ? arr.length : 0;
      }

      const verRes = await httpRequest(`${this.baseUrl}/api/v2/version`, { method: "GET" });
      const version = verRes.status === 200 ? JSON.parse(verRes.data) : "unknown";

      return { ok: true, version: String(version), collections };
    } catch {
      return { ok: false };
    }
  }

  /** Get collection stats */
  async collectionStats(): Promise<{ count: number; name: string } | null> {
    try {
      const collId = await this.getCollectionId();
      const res = await httpRequest(
        `${this.v2Base}/collections/${collId}/count`,
        { method: "GET" }
      );
      if (res.status === 200) {
        return { count: JSON.parse(res.data), name: this.collectionName };
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ============================================================
// §4  Query Logger (JSONL append-only)
// ============================================================

class QueryLogger {
  private logPath: string;
  private feedbackPath: string;
  private recentQueries: { queryId: string; query: string; ts: number }[] = [];
  private static MAX_RECENT = 50;

  constructor(dataDir: string) {
    const logDir = path.join(dataDir, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, "queries.jsonl");
    this.feedbackPath = path.join(logDir, "feedback.jsonl");
  }

  logQuery(entry: QueryLogEntry): void {
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
    this.recentQueries.push({ queryId: entry.queryId, query: entry.query, ts: Date.now() });
    if (this.recentQueries.length > QueryLogger.MAX_RECENT) this.recentQueries.shift();
  }

  logFeedback(entry: FeedbackEntry): void {
    fs.appendFileSync(this.feedbackPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  getLastQueryId(): string | null {
    return this.recentQueries[this.recentQueries.length - 1]?.queryId ?? null;
  }

  getRecentQueries(n: number = 5): { queryId: string; query: string }[] {
    return this.recentQueries.slice(-n).reverse();
  }

  getStats(): { queryCount: number; feedbackCount: number; logSize: string; feedbackSize: string } {
    const count = (p: string) => {
      if (!fs.existsSync(p)) return 0;
      return fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).length;
    };
    const size = (p: string) => {
      if (!fs.existsSync(p)) return "0 KB";
      const s = fs.statSync(p).size;
      return s > 1024 * 1024 ? `${(s / 1024 / 1024).toFixed(1)} MB` : `${(s / 1024).toFixed(1)} KB`;
    };
    return {
      queryCount: count(this.logPath),
      feedbackCount: count(this.feedbackPath),
      logSize: size(this.logPath),
      feedbackSize: size(this.feedbackPath),
    };
  }
}

function genQueryId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// §5  Helper
// ============================================================

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

// ============================================================
// §6  Plugin Entry
// ============================================================

export default {
  id: "rag",
  name: "RAG Knowledge Base",
  description: "向量知识库：萌娘百科23万条目语义检索、查询日志与反馈闭环",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const apiKey = (cfg.siliconflowApiKey as string) || "";
    const embeddingModel = (cfg.embeddingModel as string) || DEFAULT_EMBEDDING_MODEL;
    const chromaUrl = (cfg.chromaUrl as string) || DEFAULT_CHROMA_URL;
    const chromaCollection = (cfg.chromaCollection as string) || DEFAULT_CHROMA_COLLECTION;
    const dataDir = (cfg.dataDir as string) ||
      path.join(process.env.HOME || "/tmp", ".openclaw", "extensions", "rag", "data");

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const chroma = new ChromaClient(chromaUrl, chromaCollection);
    const logger = new QueryLogger(dataDir);

    // ----------------------------------------------------------
    // Tool: rag_search  —  语义搜索知识库
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_search",
      label: "知识库搜索",
      description: "在萌娘百科向量知识库中语义搜索（23万条目）。查找ACG角色、作品、声优、梗等百科知识时使用。输入自然语言查询。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索查询（自然语言）" }),
        top_k: Type.Optional(Type.Number({ description: "返回结果数量，默认5", minimum: 1, maximum: 20 })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        if (!apiKey) return text("❌ RAG插件未配置 siliconflowApiKey");

        const query = params.query as string;
        const topK = (params.top_k as number) || DEFAULT_TOP_K;
        const queryId = genQueryId();
        const t0 = Date.now();

        try {
          // Step 1: Embed query via SiliconFlow
          const queryEmb = await getEmbedding(query, apiKey, embeddingModel);

          // Step 2: Search ChromaDB via HTTP
          const results = await chroma.query(queryEmb, topK);
          const latencyMs = Date.now() - t0;

          // Step 3: Log
          logger.logQuery({
            ts: new Date().toISOString(),
            queryId,
            query,
            topK,
            backend: "chroma",
            results: results.map((r) => ({
              id: r.id,
              score: Math.round(r.score * 10000) / 10000,
              title: (r.metadata.title as string) || "",
              textPreview: r.document.slice(0, 120),
            })),
            latencyMs,
          });

          if (results.length === 0) {
            return text(`知识库中未找到相关内容。\n[queryId: ${queryId}]`);
          }

          // Format results
          const lines = results.map((r, i) => {
            const title = r.metadata.title || r.id;
            const header = `【${i + 1}】${title} (相似度: ${(r.score * 100).toFixed(1)}%)`;
            // Strip 【title】 prefix that was added during indexing
            let doc = r.document;
            const prefixMatch = doc.match(/^【[^】]+】/);
            if (prefixMatch) doc = doc.slice(prefixMatch[0].length);
            return `${header}\n${doc}`;
          });

          return text(
            lines.join("\n\n---\n\n") +
            `\n\n[queryId: ${queryId} | ${latencyMs}ms | ${results.length} hits]\n数据来源：萌娘百科`
          );
        } catch (e: any) {
          return text(`❌ 搜索失败: ${e.message}`);
        }
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_feedback  —  用户反馈
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_feedback",
      label: "知识库反馈",
      description: "记录用户对知识库检索结果的反馈。当用户表示检索结果好/不好/部分有用时调用。",
      parameters: Type.Object({
        rating: Type.Union([
          Type.Literal("good"),
          Type.Literal("bad"),
          Type.Literal("partial"),
        ], { description: "评价：good=有用, bad=没用, partial=部分有用" }),
        comment: Type.Optional(Type.String({ description: "用户的具体反馈" })),
        query_id: Type.Optional(Type.String({ description: "关联的queryId（不提供则关联最近一次查询）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const rating = params.rating as "good" | "bad" | "partial";
        const comment = params.comment as string | undefined;
        let queryId = params.query_id as string | undefined;

        if (!queryId) queryId = logger.getLastQueryId() ?? undefined;
        if (!queryId) return text("❌ 没有最近的查询可以关联反馈");

        logger.logFeedback({ ts: new Date().toISOString(), queryId, rating, comment });

        const label = { good: "👍 有用", bad: "👎 没用", partial: "🤔 部分有用" }[rating];
        return text(`✅ 反馈已记录\n评价: ${label}\nqueryId: ${queryId}${comment ? "\n备注: " + comment : ""}`);
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_stats  —  知识库统计
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_stats",
      label: "知识库统计",
      description: "显示知识库统计：ChromaDB状态、条目数、查询日志统计等。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        const logStats = logger.getStats();

        // ChromaDB status
        const hb = await chroma.heartbeat();
        const collStats = hb.ok ? await chroma.collectionStats() : null;

        const fbRate = logStats.queryCount > 0
          ? `${((logStats.feedbackCount / logStats.queryCount) * 100).toFixed(0)}%`
          : "N/A";

        return text(
          `📊 RAG 知识库统计\n\n` +
          `ChromaDB:\n` +
          `  状态: ${hb.ok ? "✅ 运行中" : "❌ 离线"}\n` +
          (hb.version ? `  版本: ${hb.version}\n` : "") +
          (hb.collections !== undefined ? `  集合数: ${hb.collections}\n` : "") +
          (collStats ? `  当前集合: ${collStats.name} (${collStats.count.toLocaleString()} chunks)\n` : "") +
          `  嵌入模型: ${embeddingModel}\n\n` +
          `📋 查询日志\n` +
          `  总查询: ${logStats.queryCount}\n` +
          `  总反馈: ${logStats.feedbackCount} (反馈率: ${fbRate})\n` +
          `  日志大小: ${logStats.logSize}\n` +
          `  反馈大小: ${logStats.feedbackSize}`
        );
      },
    });
  },
};
