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
  source: "moegirl" | "wikipedia";
}

/** Query log entry */
interface QueryLogEntry {
  ts: string;
  queryId: string;
  query: string;
  topK: number;
  tag?: string;
  sources: string[];
  results: {
    id: string;
    score: number;
    title: string;
    source: string;
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
const CHROMA_URL = "http://127.0.0.1:8100";

// Moegirl: bge-m3 via SiliconFlow
const MOEGIRL_COLLECTION = "moegirl_wiki";
const MOEGIRL_EMBEDDING_MODEL = "BAAI/bge-m3";
const SILICONFLOW_EMBED_URL = "https://api.siliconflow.cn/v1/embeddings";

// Wikipedia: Cohere embed-multilingual-v3.0
const WIKI_COLLECTION = "wiki_zh";
const WIKI_EMBEDDING_MODEL = "embed-multilingual-v3.0";
const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";

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
// §2  Embedding Providers
// ============================================================

/** SiliconFlow embedding (for moegirl / bge-m3) */
async function embedSiliconFlow(
  texts: string[],
  apiKey: string,
  model: string = MOEGIRL_EMBEDDING_MODEL
): Promise<number[][]> {
  const body = JSON.stringify({ model, input: texts, encoding_format: "float" });
  const res = await httpsRequest(SILICONFLOW_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  }, body);
  if (res.status !== 200) {
    throw new Error(`SiliconFlow embed error ${res.status}: ${res.data.slice(0, 200)}`);
  }
  const json = JSON.parse(res.data);
  const sorted = (json.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

/** Cohere embedding (for wikipedia / embed-multilingual-v3) */
async function embedCohere(
  texts: string[],
  apiKey: string,
  inputType: "search_query" | "search_document" = "search_query",
  model: string = WIKI_EMBEDDING_MODEL
): Promise<number[][]> {
  const body = JSON.stringify({
    model,
    input_type: inputType,
    texts,
    embedding_types: ["float"],
  });
  const res = await httpsRequest(COHERE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  }, body);
  if (res.status !== 200) {
    throw new Error(`Cohere embed error ${res.status}: ${res.data.slice(0, 200)}`);
  }
  const json = JSON.parse(res.data);
  // v2 response: { embeddings: { float: [[...], ...] } }
  return json.embeddings.float as number[][];
}

// ============================================================
// §3  ChromaDB HTTP Client
// ============================================================

class ChromaClient {
  private baseUrl: string;
  private collectionName: string;
  private collectionId: string | null = null;
  private available: boolean | null = null;

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
      this.available = true;
      return this.collectionId!;
    }

    this.available = false;
    throw new Error(`Collection "${this.collectionName}" not found (status ${res.status})`);
  }

  /** Check if collection is available */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await this.getCollectionId();
      return true;
    } catch {
      return false;
    }
  }

  /** Query by embedding vector */
  async query(queryEmbedding: number[], nResults: number = 5): Promise<SearchResult[]> {
    const collId = await this.getCollectionId();

    const payload = {
      query_embeddings: [queryEmbedding],
      n_results: nResults,
      include: ["documents", "metadatas", "distances"],
    };

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
      source: this.collectionName === MOEGIRL_COLLECTION ? "moegirl" as const : "wikipedia" as const,
    }));
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

  /** Health check */
  async heartbeat(): Promise<{ ok: boolean; version?: string }> {
    try {
      const res = await httpRequest(`${this.baseUrl}/api/v2/heartbeat`, { method: "GET" });
      if (res.status !== 200) return { ok: false };
      const verRes = await httpRequest(`${this.baseUrl}/api/v2/version`, { method: "GET" });
      const version = verRes.status === 200 ? JSON.parse(verRes.data) : "unknown";
      return { ok: true, version: String(version) };
    } catch {
      return { ok: false };
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

const SOURCE_LABEL: Record<string, string> = {
  moegirl: "萌娘百科",
  wikipedia: "中文维基百科",
};

// ============================================================
// §6  Plugin Entry
// ============================================================

export default {
  id: "rag",
  name: "RAG Knowledge Base",
  description: "向量知识库：萌娘百科 + 中文维基百科 语义检索，查询日志与反馈闭环",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const siliconflowKey = (cfg.siliconflowApiKey as string) || "";
    const cohereKey = (cfg.cohereApiKey as string) || "";
    const dataDir = (cfg.dataDir as string) ||
      path.join(process.env.HOME || "/tmp", ".openclaw", "extensions", "rag", "data");

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const chromaMoegirl = new ChromaClient(CHROMA_URL, MOEGIRL_COLLECTION);
    const chromaWiki = new ChromaClient(CHROMA_URL, WIKI_COLLECTION);
    const logger = new QueryLogger(dataDir);

    // ----------------------------------------------------------
    // Tool: rag_search  —  语义搜索知识库（双库融合）
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_search",
      label: "知识库搜索",
      description: "在知识库中语义搜索。包含萌娘百科（23万条ACG百科）和中文维基百科（277万条综合百科）。查找任何百科知识时使用。输入自然语言查询。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索查询（自然语言）" }),
        top_k: Type.Optional(Type.Number({ description: "每个库返回的结果数量，默认5", minimum: 1, maximum: 20 })),
        source: Type.Optional(Type.Union([
          Type.Literal("all"),
          Type.Literal("moegirl"),
          Type.Literal("wikipedia"),
        ], { description: "搜索源：all=全部（默认）, moegirl=仅萌娘百科, wikipedia=仅维基百科" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = params.query as string;
        const topK = (params.top_k as number) || DEFAULT_TOP_K;
        const source = (params.source as string) || "all";
        const queryId = genQueryId();
        const t0 = Date.now();

        const searchMoegirl = source === "all" || source === "moegirl";
        const searchWiki = source === "all" || source === "wikipedia";
        const activeSources: string[] = [];

        // Check which sources are ready
        if (searchMoegirl && !siliconflowKey) {
          return text("❌ 萌娘百科搜索需要配置 siliconflowApiKey");
        }
        if (searchWiki && !cohereKey) {
          // Silently skip wikipedia if no key and searching all
          if (source === "wikipedia") {
            return text("❌ 维基百科搜索需要配置 cohereApiKey");
          }
        }

        try {
          const allResults: SearchResult[] = [];

          // Parallel: embed + query both sources
          const promises: Promise<void>[] = [];

          if (searchMoegirl && siliconflowKey && await chromaMoegirl.isAvailable()) {
            activeSources.push("moegirl");
            promises.push(
              (async () => {
                const [emb] = await embedSiliconFlow([query], siliconflowKey);
                const results = await chromaMoegirl.query(emb, topK);
                allResults.push(...results);
              })()
            );
          }

          if (searchWiki && cohereKey && await chromaWiki.isAvailable()) {
            activeSources.push("wikipedia");
            promises.push(
              (async () => {
                const [emb] = await embedCohere([query], cohereKey);
                const results = await chromaWiki.query(emb, topK);
                allResults.push(...results);
              })()
            );
          }

          if (promises.length === 0) {
            return text("❌ 没有可用的知识库（检查ChromaDB服务和API密钥配置）");
          }

          // Wait for all sources
          const settled = await Promise.allSettled(promises);
          const errors = settled
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => r.reason?.message || "unknown error");

          const latencyMs = Date.now() - t0;

          // Sort by score descending
          allResults.sort((a, b) => b.score - a.score);

          // Log
          logger.logQuery({
            ts: new Date().toISOString(),
            queryId,
            query,
            topK,
            sources: activeSources,
            results: allResults.map((r) => ({
              id: r.id,
              score: Math.round(r.score * 10000) / 10000,
              title: (r.metadata.title as string) || "",
              source: r.source,
              textPreview: r.document.slice(0, 120),
            })),
            latencyMs,
          });

          if (allResults.length === 0) {
            const errMsg = errors.length > 0 ? `\n错误: ${errors.join("; ")}` : "";
            return text(`知识库中未找到相关内容。${errMsg}\n[queryId: ${queryId}]`);
          }

          // Format results
          const lines = allResults.map((r, i) => {
            const title = r.metadata.title || r.id;
            const srcLabel = SOURCE_LABEL[r.source] || r.source;
            const header = `【${i + 1}】${title} [${srcLabel}] (相似度: ${(r.score * 100).toFixed(1)}%)`;
            // Strip 【title】 prefix from moegirl chunks
            let doc = r.document;
            if (r.source === "moegirl") {
              const prefixMatch = doc.match(/^【[^】]+】/);
              if (prefixMatch) doc = doc.slice(prefixMatch[0].length);
            }
            // Truncate very long wikipedia articles
            if (doc.length > 800) doc = doc.slice(0, 800) + "…";
            return `${header}\n${doc}`;
          });

          const sourcesUsed = [...new Set(allResults.map((r) => SOURCE_LABEL[r.source]))].join("、");
          const errNote = errors.length > 0 ? `\n⚠️ 部分源查询失败: ${errors.join("; ")}` : "";

          return text(
            lines.join("\n\n---\n\n") +
            `\n\n[queryId: ${queryId} | ${latencyMs}ms | ${allResults.length} hits]${errNote}\n数据来源：${sourcesUsed}`
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
      description: "显示知识库统计：ChromaDB状态、各知识库条目数、查询日志统计等。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        const logStats = logger.getStats();
        const hb = await chromaMoegirl.heartbeat();

        const moegirlStats = hb.ok ? await chromaMoegirl.collectionStats() : null;
        const wikiStats = hb.ok ? await chromaWiki.collectionStats() : null;

        const fbRate = logStats.queryCount > 0
          ? `${((logStats.feedbackCount / logStats.queryCount) * 100).toFixed(0)}%`
          : "N/A";

        let collectionsInfo = "";
        if (moegirlStats) {
          collectionsInfo += `  📗 萌娘百科: ${moegirlStats.count.toLocaleString()} chunks (bge-m3 via SiliconFlow)\n`;
        }
        if (wikiStats) {
          collectionsInfo += `  📘 中文维基百科: ${wikiStats.count.toLocaleString()} entries (Cohere embed-v3)\n`;
        }
        if (!moegirlStats && !wikiStats) {
          collectionsInfo += "  ⚠️ 无可用集合\n";
        }

        const keyStatus = [
          siliconflowKey ? "SiliconFlow ✅" : "SiliconFlow ❌",
          cohereKey ? "Cohere ✅" : "Cohere ❌",
        ].join(" | ");

        return text(
          `📊 RAG 知识库统计\n\n` +
          `ChromaDB: ${hb.ok ? "✅ 运行中" : "❌ 离线"}${hb.version ? ` (v${hb.version})` : ""}\n` +
          collectionsInfo +
          `API密钥: ${keyStatus}\n\n` +
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
