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
  metadata: Record<string, string>; // arbitrary metadata (title, source, tags, ...)
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

const DEFAULT_CHUNK_SIZE = 512;    // chars per chunk
const DEFAULT_CHUNK_OVERLAP = 64;  // overlap between chunks
const DEFAULT_TOP_K = 5;
const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3";
const DEFAULT_EMBEDDING_DIM = 1024;
const EMBEDDING_API_URL = "https://api.siliconflow.cn/v1/embeddings";

// ============================================================
// §1  Embedding Provider (SiliconFlow)
// ============================================================

/** IPv4-only HTTPS request helper (same pattern as other plugins) */
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
  // SiliconFlow embedding API is OpenAI-compatible
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
  // Sort by index to guarantee order
  const sorted = (json.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

/** Embed a single text */
async function getEmbedding(
  text: string,
  apiKey: string,
  model?: string
): Promise<number[]> {
  const results = await getEmbeddings([text], apiKey, model);
  return results[0];
}

// ============================================================
// §2  Vector Store (JSONL file-backed + cosine search)
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

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Load from JSONL file */
  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const content = fs.readFileSync(this.filePath, "utf-8");
    this.chunks = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.chunks.push(JSON.parse(trimmed) as DocChunk);
      } catch {
        // skip corrupted lines
      }
    }
  }

  /** Persist to JSONL file */
  flush(): void {
    if (!this.dirty) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = this.chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
    fs.writeFileSync(this.filePath, lines, "utf-8");
    this.dirty = false;
  }

  /** Add chunks (batch) */
  addChunks(chunks: DocChunk[]): void {
    this.chunks.push(...chunks);
    this.dirty = true;
  }

  /** Search by query embedding, return top-k results */
  search(queryEmbedding: number[], topK: number = DEFAULT_TOP_K, filter?: Record<string, string>): SearchResult[] {
    let candidates = this.chunks;

    // Optional metadata filter
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

  /** Delete all chunks belonging to a docId */
  deleteDoc(docId: string): number {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => c.docId !== docId);
    const removed = before - this.chunks.length;
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** List all unique documents */
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

  /** Get total chunk count */
  get size(): number {
    return this.chunks.length;
  }
}

// ============================================================
// §3  Document Processor (chunking)
// ============================================================

function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP
): string[] {
  // Strategy: split by double-newline (paragraphs) first, then merge small
  // paragraphs into chunks up to chunkSize, with overlap.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 1 <= chunkSize) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) chunks.push(current);
      // If a single paragraph exceeds chunkSize, split by sentences
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
        if (buf) current = buf;
        else current = "";
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  // Apply overlap: prepend tail of previous chunk to next chunk
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
  // Split on Chinese/Japanese/English sentence boundaries
  return text
    .split(/(?<=[。！？；\.\!\?\;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Generate a short deterministic docId from title + timestamp */
function generateDocId(title: string): string {
  const ts = Date.now().toString(36);
  const slug = title
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "")
    .slice(0, 20);
  return `${slug}-${ts}`;
}

// ============================================================
// §4  Helper: text() response wrapper
// ============================================================

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

// ============================================================
// §5  Plugin Entry
// ============================================================

export default {
  id: "rag",
  name: "RAG Knowledge Base",
  description: "向量知识库：文档入库、语义检索、知识管理",

  register(api: OpenClawPluginApi) {
    const apiKey = (api.pluginConfig as Record<string, unknown>)?.siliconflowApiKey as string || "";
    const embeddingModel = ((api.pluginConfig as Record<string, unknown>)?.embeddingModel as string) || DEFAULT_EMBEDDING_MODEL;
    const dataDir = ((api.pluginConfig as Record<string, unknown>)?.dataDir as string) || path.join(process.env.HOME || "/tmp", ".openclaw", "extensions", "rag", "data");

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const store = new VectorStore(path.join(dataDir, "vectors.jsonl"));

    // ----------------------------------------------------------
    // Tool: rag_search  —  语义搜索知识库
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

        try {
          const queryEmb = await getEmbedding(query, apiKey, embeddingModel);
          const filter = tag ? { tag } : undefined;
          const results = store.search(queryEmb, topK, filter);

          if (results.length === 0) {
            return text("知识库中未找到相关内容。");
          }

          const lines = results.map((r, i) => {
            const meta = r.chunk.metadata;
            const header = `【${i + 1}】${meta.title || r.chunk.docId} (相似度: ${(r.score * 100).toFixed(1)}%)`;
            const source = meta.source ? `来源: ${meta.source}` : "";
            const tagStr = meta.tag ? `标签: ${meta.tag}` : "";
            const info = [source, tagStr].filter(Boolean).join(" | ");
            return `${header}\n${info ? info + "\n" : ""}${r.chunk.text}`;
          });

          return text(lines.join("\n\n---\n\n"));
        } catch (e: any) {
          return text(`❌ 搜索失败: ${e.message}`);
        }
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

          // Batch embed (SiliconFlow supports batch)
          const embeddings = await getEmbeddings(textChunks, apiKey, embeddingModel);
          const now = new Date().toISOString();
          const metadata: Record<string, string> = { title };
          if (source) metadata.source = source;
          if (tag) metadata.tag = tag;

          const docChunks: DocChunk[] = textChunks.map((text, i) => ({
            id: `${docId}#${i}`,
            docId,
            text,
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
        if (docs.length === 0) {
          return text("知识库为空，暂无文档。");
        }

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

        return text(
          `📚 知识库文档列表 (${docs.length} 篇, ${store.size} chunks)\n\n` +
          lines.join("\n\n")
        );
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

        if (removed === 0) {
          return text(`❌ 未找到文档 ${docId}`);
        }

        store.flush();
        return text(
          `✅ 已删除文档 ${docId}\n` +
          `移除分块: ${removed}\n` +
          `知识库剩余: ${store.size} chunks`
        );
      },
    });

    // ----------------------------------------------------------
    // Tool: rag_stats  —  知识库统计
    // ----------------------------------------------------------
    api.registerTool({
      name: "rag_stats",
      label: "知识库统计",
      description: "显示知识库的详细统计信息：文档数、分块数、存储大小、标签分布等。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        const docs = store.listDocs();
        const totalChunks = store.size;

        // Tag distribution
        const tagCounts = new Map<string, number>();
        for (const d of docs) {
          const tag = d.metadata.tag || "(无标签)";
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }

        // Storage size
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

        return text(
          `📊 知识库统计\n` +
          `文档数: ${docs.length}\n` +
          `总分块: ${totalChunks}\n` +
          `存储大小: ${fileSize}\n` +
          `嵌入模型: ${embeddingModel}\n` +
          `向量维度: ${DEFAULT_EMBEDDING_DIM}\n\n` +
          `标签分布:\n${tagLines || "  (空)"}`
        );
      },
    });
  },
};
