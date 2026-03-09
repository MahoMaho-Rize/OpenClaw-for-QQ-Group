import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// §0  Types & Constants
// ============================================================

interface DocChunk {
  id: string;           // unique chunk id: {docId}#{chunkIndex}
  docId: string;        // parent document id
  text: string;         // chunk text content
  embedding: number[];  // vector embedding
  metadata: Record<string, string>;
  createdAt: string;    // ISO timestamp
}

interface SearchResult {
  chunk: DocChunk;
  score: number;        // cosine similarity [0, 1]
}

interface DocInfo {
  docId: string;
  title: string;
  source: string;
  chunkCount: number;
  createdAt: string;
  metadata: Record<string, string>;
}

/** Query log entry — written per rag_search call */
interface QueryLogEntry {
  ts: string;           // ISO timestamp
  queryId: string;      // unique id for feedback linking
  query: string;        // user's search query
  topK: number;
  tag?: string;
  results: {
    docId: string;
    chunkId: string;
    score: number;
    title: string;
    textPreview: string; // first 120 chars
  }[];
  latencyMs: number;
  feedback?: FeedbackEntry; // filled in later by rag_feedback
}

/** Feedback entry — linked to a queryId */
interface FeedbackEntry {
  ts: string;
  queryId: string;
  rating: "good" | "bad" | "partial";
  comment?: string;     // user's optional comment
  expectedDocId?: string; // what the user actually wanted
}

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 64;
const DEFAULT_TOP_K = 5;
const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3";
const DEFAULT_EMBEDDING_DIM = 1024;
const EMBEDDING_API_URL = "https://api.siliconflow.cn/v1/embeddings";

// ============================================================
// §1  Embedding Provider (SiliconFlow)
// ============================================================

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
    req.setTimeout(30_000, () => {
      req.destroy(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function getEmbeddings(
  texts: string[],
  apiKey: string,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number[][]> {
  const body = JSON.stringify({
    model,
    input: texts,
    encoding_format: "float",
  });
  const res = await httpsRequest(EMBEDDING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  }, body);

  if (res.status !== 200) {
    throw new Error(`Embedding API error ${res.status}: ${res.data.slice(0, 200)}`);
  }

  const json = JSON.parse(res.data);
  const sorted = (json.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

async function getEmbedding(
  text: string,
  apiKey: string,
  model?: string
): Promise<number[]> {
  const results = await getEmbeddings([text], apiKey, model);
  return results[0];
}

// ============================================================
// §2  Vector Store (JSONL file-backed + cosine search + hot reload)
// ============================================================

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

class VectorStore {
  private chunks: DocChunk[] = [];
  private filePath: string;
  private dirty = false;
  private lastMtimeMs = 0;  // for hot reload detection

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Load from JSONL — also records file mtime for hot reload */
  private load(): void {
    this.chunks = [];
    if (!fs.existsSync(this.filePath)) { this.lastMtimeMs = 0; return; }
    const stat = fs.statSync(this.filePath);
    this.lastMtimeMs = stat.mtimeMs;
    const content = fs.readFileSync(this.filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.chunks.push(JSON.parse(trimmed) as DocChunk);
      } catch { /* skip corrupted */ }
    }
  }

  /**
   * Hot reload: re-read JSONL only if file was modified externally.
   * Called before every search so we always use the freshest data.
   * Cost: one stat() per search — negligible.
   */
  reloadIfChanged(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    const stat = fs.statSync(this.filePath);
    if (stat.mtimeMs !== this.lastMtimeMs) {
      const prevSize = this.chunks.length;
      this.load();
      this.dirty = false;
      return this.chunks.length !== prevSize;
    }
    return false;
  }

  /** Force full reload (e.g. after external push of rebuilt vectors.jsonl) */
  forceReload(): number {
    const prevSize = this.chunks.length;
    this.load();
    this.dirty = false;
    return this.chunks.length;
  }

  flush(): void {
    if (!this.dirty) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = this.chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
    fs.writeFileSync(this.filePath, lines, "utf-8");
    this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
    this.dirty = false;
  }

  addChunks(chunks: DocChunk[]): void {
    this.chunks.push(...chunks);
    this.dirty = true;
  }

  search(queryEmbedding: number[], topK: number = DEFAULT_TOP_K, filter?: Record<string, string>): SearchResult[] {
    // Hot reload check — pick up externally pushed vector updates
    this.reloadIfChanged();

    let candidates = this.chunks;
    if (filter) {
      candidates = candidates.filter((c) =>
        Object.entries(filter).every(([k, v]) => c.metadata[k] === v)
      );
    }
    const scored: SearchResult[] = candidates.map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  deleteDoc(docId: string): number {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => c.docId !== docId);
    const removed = before - this.chunks.length;
    if (removed > 0) this.dirty = true;
    return removed;
  }

  listDocs(): DocInfo[] {
    const map = new Map<string, { chunks: DocChunk[]; earliest: string }>();
    for (const c of this.chunks) {
      const entry = map.get(c.docId);
      if (!entry) {
        map.set(c.docId, { chunks: [c], earliest: c.createdAt });
      } else {
        entry.chunks.push(c);
        if (c.createdAt < entry.earliest) entry.earliest = c.createdAt;
      }
    }
    const docs: DocInfo[] = [];
    for (const [docId, { chunks, earliest }] of map) {
      const first = chunks[0];
      docs.push({
        docId,
        title: first.metadata.title || docId,
        source: first.metadata.source || "",
        chunkCount: chunks.length,
        createdAt: earliest,
        metadata: first.metadata,
      });
    }
    return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get size(): number { return this.chunks.length; }
}

// ============================================================
// §3  Query Logger (JSONL append-only log for offline evaluation)
// ============================================================

class QueryLogger {
  private logPath: string;
  private feedbackPath: string;

  /** In-memory ring of recent queryIds for feedback linking */
  private recentQueries: { queryId: string; query: string; ts: number }[] = [];
  private static MAX_RECENT = 50;

  constructor(dataDir: string) {
    const logDir = path.join(dataDir, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, "queries.jsonl");
    this.feedbackPath = path.join(logDir, "feedback.jsonl");
  }

  /** Log a search query + results. Returns queryId for feedback linking. */
  logQuery(entry: QueryLogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.logPath, line, "utf-8");
    this.recentQueries.push({ queryId: entry.queryId, query: entry.query, ts: Date.now() });
    if (this.recentQueries.length > QueryLogger.MAX_RECENT) {
      this.recentQueries.shift();
    }
  }

  /** Log user feedback, linked to a queryId. */
  logFeedback(entry: FeedbackEntry): void {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.feedbackPath, line, "utf-8");
  }

  /** Get the most recent queryId (for implicit feedback linking) */
  getLastQueryId(): string | null {
    const last = this.recentQueries[this.recentQueries.length - 1];
    return last?.queryId ?? null;
  }

  /** Get recent queries for display */
  getRecentQueries(n: number = 5): { queryId: string; query: string }[] {
    return this.recentQueries.slice(-n).reverse();
  }

  /** Get log stats */
  getStats(): { queryCount: number; feedbackCount: number; logSize: string; feedbackSize: string } {
    const count = (p: string) => {
      if (!fs.existsSync(p)) return 0;
      const content = fs.readFileSync(p, "utf-8");
      return content.split("\n").filter((l) => l.trim()).length;
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

/** Generate a short unique queryId */
function genQueryId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// §4  Document Processor (chunking)
// ============================================================

function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP
): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 1 <= chunkSize) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) chunks.push(current);
      if (para.length > chunkSize) {
        const sentences = splitSentences(para);
        let buf = "";
        for (const s of sentences) {
          if (buf.length + s.length + 1 <= chunkSize) {
            buf = buf ? buf + s : s;
          } else {
            if (buf) chunks.push(buf);
            buf = s.length > chunkSize ? s.slice(0, chunkSize) : s;
          }
        }
        if (buf) current = buf; else current = "";
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  if (overlap > 0 && chunks.length > 1) {
    const overlapped: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const overlapText = prev.slice(-overlap);
      overlapped.push(overlapText + "..." + chunks[i]);
    }
    return overlapped;
  }
  return chunks;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；\.\!\?\;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function generateDocId(title: string): string {
  const ts = Date.now().toString(36);
  const slug = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "").slice(0, 20);
  return `${slug}-${ts}`;
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
  description: "向量知识库：文档入库、语义检索、知识管理、查询日志与反馈闭环",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const apiKey = (cfg.siliconflowApiKey as string) || "";
    const embeddingModel = (cfg.embeddingModel as string) || DEFAULT_EMBEDDING_MODEL;
    const dataDir = (cfg.dataDir as string) ||
      path.join(process.env.HOME || "/tmp", ".openclaw", "extensions", "rag", "data");

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const store = new VectorStore(path.join(dataDir, "vectors.jsonl"));
    const logger = new QueryLogger(dataDir);

    // ----------------------------------------------------------
    // Tool: rag_search  —  语义搜索知识库（带日志）
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_search",
      label: "知识库搜索",
      description: "在本地向量知识库中进行语义搜索。当需要查找已入库的专有知识、文档、笔记时使用。输入自然语言查询，返回最相关的文档片段。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索查询（自然语言）" }),
        top_k: Type.Optional(Type.Number({ description: "返回结果数量，默认5", minimum: 1, maximum: 20 })),
        tag: Type.Optional(Type.String({ description: "按标签过滤（精确匹配）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        if (!apiKey) return text("❌ RAG插件未配置 siliconflowApiKey");

        const query = params.query as string;
        const topK = (params.top_k as number) || DEFAULT_TOP_K;
        const tag = params.tag as string | undefined;
        const queryId = genQueryId();
        const t0 = Date.now();

        try {
          const queryEmb = await getEmbedding(query, apiKey, embeddingModel);
          const filter = tag ? { tag } : undefined;
          const results = store.search(queryEmb, topK, filter);
          const latencyMs = Date.now() - t0;

          // --- Log query + results ---
          logger.logQuery({
            ts: new Date().toISOString(),
            queryId,
            query,
            topK,
            tag,
            results: results.map((r) => ({
              docId: r.chunk.docId,
              chunkId: r.chunk.id,
              score: Math.round(r.score * 10000) / 10000,
              title: r.chunk.metadata.title || "",
              textPreview: r.chunk.text.slice(0, 120),
            })),
            latencyMs,
          });

          if (results.length === 0) {
            return text(`知识库中未找到相关内容。\n[queryId: ${queryId}]`);
          }

          const lines = results.map((r, i) => {
            const meta = r.chunk.metadata;
            const header = `【${i + 1}】${meta.title || r.chunk.docId} (相似度: ${(r.score * 100).toFixed(1)}%)`;
            const source = meta.source ? `来源: ${meta.source}` : "";
            const tagStr = meta.tag ? `标签: ${meta.tag}` : "";
            const info = [source, tagStr].filter(Boolean).join(" | ");
            return `${header}\n${info ? info + "\n" : ""}${r.chunk.text}`;
          });

          return text(
            lines.join("\n\n---\n\n") +
            `\n\n[queryId: ${queryId} | ${latencyMs}ms | ${results.length} hits]`
          );
        } catch (e: any) {
          return text(`❌ 搜索失败: ${e.message}`);
        }
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_feedback  —  用户对检索结果的反馈
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_feedback",
      label: "知识库反馈",
      description: "记录用户对知识库检索结果的反馈。当用户表示检索结果好/不好/部分有用时调用。用于持续优化检索质量。",
      parameters: Type.Object({
        rating: Type.Union([
          Type.Literal("good"),
          Type.Literal("bad"),
          Type.Literal("partial"),
        ], { description: "评价：good=有用, bad=没用, partial=部分有用" }),
        comment: Type.Optional(Type.String({ description: "用户的具体反馈内容" })),
        query_id: Type.Optional(Type.String({ description: "关联的queryId（如不提供则关联最近一次查询）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const rating = params.rating as "good" | "bad" | "partial";
        const comment = params.comment as string | undefined;
        let queryId = params.query_id as string | undefined;

        if (!queryId) {
          queryId = logger.getLastQueryId() ?? undefined;
        }
        if (!queryId) {
          return text("❌ 没有最近的查询可以关联反馈");
        }

        logger.logFeedback({
          ts: new Date().toISOString(),
          queryId,
          rating,
          comment,
        });

        const ratingLabel = { good: "👍 有用", bad: "👎 没用", partial: "🤔 部分有用" }[rating];
        return text(`✅ 反馈已记录\n评价: ${ratingLabel}\nqueryId: ${queryId}${comment ? "\n备注: " + comment : ""}`);
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_ingest  —  将文本入库
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_ingest",
      label: "知识入库",
      description: "将文本内容分块并嵌入向量知识库。用于持久存储知识、文档、笔记等供后续语义检索。",
      parameters: Type.Object({
        title: Type.String({ description: "文档标题" }),
        content: Type.String({ description: "要入库的文本内容" }),
        source: Type.Optional(Type.String({ description: "来源说明（如URL、书名等）" })),
        tag: Type.Optional(Type.String({ description: "分类标签" })),
        chunk_size: Type.Optional(Type.Number({ description: "分块大小（字符数），默认512" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        if (!apiKey) return text("❌ RAG插件未配置 siliconflowApiKey");

        const title = params.title as string;
        const content = params.content as string;
        const source = (params.source as string) || "";
        const tag = (params.tag as string) || "";
        const chunkSize = (params.chunk_size as number) || DEFAULT_CHUNK_SIZE;

        if (!content || content.length < 10) {
          return text("❌ 内容过短，至少需要10个字符");
        }

        try {
          const docId = generateDocId(title);
          const textChunks = chunkText(content, chunkSize, DEFAULT_CHUNK_OVERLAP);
          const embeddings = await getEmbeddings(textChunks, apiKey, embeddingModel);
          const now = new Date().toISOString();
          const metadata: Record<string, string> = { title };
          if (source) metadata.source = source;
          if (tag) metadata.tag = tag;

          const docChunks: DocChunk[] = textChunks.map((t, i) => ({
            id: `${docId}#${i}`,
            docId,
            text: t,
            embedding: embeddings[i],
            metadata: { ...metadata },
            createdAt: now,
          }));

          store.addChunks(docChunks);
          store.flush();

          return text(
            `✅ 入库成功\n` +
            `文档ID: ${docId}\n` +
            `标题: ${title}\n` +
            `分块数: ${textChunks.length}\n` +
            `总字符: ${content.length}\n` +
            `知识库总量: ${store.size} chunks`
          );
        } catch (e: any) {
          return text(`❌ 入库失败: ${e.message}`);
        }
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_list  —  列出知识库内容
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_list",
      label: "知识库列表",
      description: "列出知识库中所有已入库的文档。显示文档ID、标题、来源、分块数等信息。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        const docs = store.listDocs();
        if (docs.length === 0) return text("知识库为空，暂无文档。");

        const lines = docs.map((d, i) => {
          const parts = [
            `${i + 1}. ${d.title}`,
            `   ID: ${d.docId}`,
            `   分块: ${d.chunkCount} | 入库: ${d.createdAt.slice(0, 10)}`,
          ];
          if (d.source) parts.push(`   来源: ${d.source}`);
          if (d.metadata.tag) parts.push(`   标签: ${d.metadata.tag}`);
          return parts.join("\n");
        });

        return text(`📚 知识库文档列表 (${docs.length} 篇, ${store.size} chunks)\n\n` + lines.join("\n\n"));
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_delete  —  删除文档
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_delete",
      label: "知识库删除",
      description: "从知识库中删除指定文档及其所有分块。需要提供文档ID。",
      parameters: Type.Object({
        doc_id: Type.String({ description: "要删除的文档ID（通过 rag_list 获取）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const docId = params.doc_id as string;
        const removed = store.deleteDoc(docId);
        if (removed === 0) return text(`❌ 未找到文档 ${docId}`);
        store.flush();
        return text(`✅ 已删除文档 ${docId}\n移除分块: ${removed}\n知识库剩余: ${store.size} chunks`);
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_reload  —  热加载向量库
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_reload",
      label: "知识库热加载",
      description: "强制重新加载向量数据库文件。当外部推送了新的 vectors.jsonl 后调用，无需重启网关。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        const newSize = store.forceReload();
        const docs = store.listDocs();
        return text(
          `✅ 热加载完成\n` +
          `加载分块: ${newSize}\n` +
          `文档数: ${docs.length}`
        );
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_stats  —  知识库 + 日志统计
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_stats",
      label: "知识库统计",
      description: "显示知识库的详细统计信息：文档数、分块数、存储大小、标签分布、查询日志统计等。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        const docs = store.listDocs();
        const totalChunks = store.size;
        const logStats = logger.getStats();

        // Tag distribution
        const tagCounts = new Map<string, number>();
        for (const d of docs) {
          const tag = d.metadata.tag || "(无标签)";
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }

        // Vector store file size
        const storePath = path.join(dataDir, "vectors.jsonl");
        let fileSize = "N/A";
        if (fs.existsSync(storePath)) {
          const stat = fs.statSync(storePath);
          fileSize = stat.size > 1024 * 1024
            ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
            : `${(stat.size / 1024).toFixed(1)} KB`;
        }

        const tagLines = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => `  ${tag}: ${count} 篇`)
          .join("\n");

        // Feedback rate
        const fbRate = logStats.queryCount > 0
          ? `${((logStats.feedbackCount / logStats.queryCount) * 100).toFixed(0)}%`
          : "N/A";

        return text(
          `📊 知识库统计\n` +
          `文档数: ${docs.length}\n` +
          `总分块: ${totalChunks}\n` +
          `向量文件: ${fileSize}\n` +
          `嵌入模型: ${embeddingModel}\n` +
          `向量维度: ${DEFAULT_EMBEDDING_DIM}\n\n` +
          `标签分布:\n${tagLines || "  (空)"}\n\n` +
          `📋 查询日志\n` +
          `总查询: ${logStats.queryCount}\n` +
          `总反馈: ${logStats.feedbackCount} (反馈率: ${fbRate})\n` +
          `日志大小: ${logStats.logSize}\n` +
          `反馈大小: ${logStats.feedbackSize}`
        );
      },
    });
  },
};
