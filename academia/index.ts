import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// HTTP helper — IPv4-only, gzip/deflate, 15 s timeout
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "OpenClaw-Bot/1.0";

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

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Pull every match of a pattern out of a string. */
function matchAll(text: string, re: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) results.push(m);
  return results;
}

/** Extract text between an XML open/close tag (non-greedy). */
function xmlTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  return m ? m[1].trim() : "";
}

/** Extract an attribute value from a self-closing or open tag. */
function xmlAttr(block: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*?${attr}="([^"]*)"`, "i");
  const m = re.exec(block);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// Tool 1 — arXiv search
// ---------------------------------------------------------------------------

async function arxivSearch(query: string, limit: number) {
  const url =
    `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${limit}`;
  const { data } = await httpGet(url);

  // Split into <entry> blocks
  const entryBlocks = matchAll(data, /<entry>([\s\S]*?)<\/entry>/gi);

  const papers = entryBlocks.map((m) => {
    const block = m[1];

    const title = xmlTag(block, "title").replace(/\s+/g, " ");
    const summary = truncate(xmlTag(block, "summary").replace(/\s+/g, " "), 200);
    const published = xmlTag(block, "published");
    const arxivUrl = xmlTag(block, "id").trim();

    // Authors — first 3
    const authorMatches = matchAll(block, /<author>\s*<name>([\s\S]*?)<\/name>/gi);
    const authors = authorMatches.slice(0, 3).map((a) => a[1].trim());

    // Categories
    const catMatches = matchAll(block, /<category\s+term="([^"]+)"/gi);
    const categories = catMatches.map((c) => c[1]);

    return { title, authors, summary, published, arxiv_url: arxivUrl, categories };
  });

  return papers;
}

// ---------------------------------------------------------------------------
// Tool 2 — Semantic Scholar search
// ---------------------------------------------------------------------------

async function semanticScholarSearch(query: string, limit: number) {
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,citationCount,url,abstract`;

  let res = await httpGet(url);

  // Retry once on 429 (rate-limited)
  if (res.status === 429) {
    await sleep(2000);
    res = await httpGet(url);
  }

  if (res.status !== 200) {
    throw new Error(`Semantic Scholar API returned status ${res.status}`);
  }

  const json = JSON.parse(res.data);
  const rawPapers: any[] = json.data ?? [];

  return rawPapers.map((p: any) => ({
    title: p.title ?? "",
    authors: (p.authors ?? []).map((a: any) => a.name as string),
    year: p.year ?? null,
    citation_count: p.citationCount ?? 0,
    url: p.url ?? "",
    abstract: truncate(p.abstract ?? "", 200),
  }));
}

// ---------------------------------------------------------------------------
// Tool 3 — PubMed search (two-step: esearch → esummary)
// ---------------------------------------------------------------------------

async function pubmedSearch(query: string, limit: number) {
  // Step 1 — search for IDs
  const searchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(query)}&retmax=${limit}`;
  const searchRes = await httpGet(searchUrl);
  const searchJson = JSON.parse(searchRes.data);
  const ids: string[] = searchJson?.esearchresult?.idlist ?? [];

  if (ids.length === 0) return [];

  // Step 2 — fetch summaries
  const summaryUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
  const summaryRes = await httpGet(summaryUrl);
  const summaryJson = JSON.parse(summaryRes.data);
  const result = summaryJson?.result ?? {};

  return ids
    .filter((id) => result[id])
    .map((id) => {
      const doc = result[id];
      const authors: string[] = (doc.authors ?? []).map((a: any) => a.name as string);
      const doi = (doc.articleids ?? []).find((a: any) => a.idtype === "doi")?.value ?? "";

      return {
        title: doc.title ?? "",
        authors,
        source: doc.source ?? "",
        pubdate: doc.pubdate ?? "",
        pmid: id,
        doi,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      };
    });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = {
  id: "academia",
  name: "Academic Search",
  description: "arXiv论文搜索 + Semantic Scholar学术搜索 + PubMed医学文献",

  register(api: OpenClawPluginApi) {
    // ---- arXiv search ----
    api.registerTool({
      name: "arxiv_search",
      description: "搜索arXiv上的学术论文，返回标题、作者、摘要、发布日期、分类等信息",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词（支持arXiv查询语法，如 ti:transformer AND cat:cs.CL）" }),
        limit: Type.Optional(Type.Number({ description: "返回结果数量，默认5，最大10", default: 5, maximum: 10 })),
      }),
      async execute({ query, limit = 5 }) {
        const n = Math.min(Math.max(limit, 1), 10);
        const papers = await arxivSearch(query, n);
        return { total: papers.length, papers };
      },
    });

    // ---- Semantic Scholar search ----
    api.registerTool({
      name: "semantic_scholar_search",
      description: "通过Semantic Scholar搜索学术论文，返回标题、作者、年份、引用次数等信息",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        limit: Type.Optional(Type.Number({ description: "返回结果数量，默认5，最大10", default: 5, maximum: 10 })),
      }),
      async execute({ query, limit = 5 }) {
        const n = Math.min(Math.max(limit, 1), 10);
        const papers = await semanticScholarSearch(query, n);
        return { total: papers.length, papers };
      },
    });

    // ---- PubMed search ----
    api.registerTool({
      name: "pubmed_search",
      description: "搜索PubMed医学文献数据库，返回标题、作者、期刊来源、发布日期、PMID、DOI等信息",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词（支持PubMed检索语法）" }),
        limit: Type.Optional(Type.Number({ description: "返回结果数量，默认5，最大10", default: 5, maximum: 10 })),
      }),
      async execute({ query, limit = 5 }) {
        const n = Math.min(Math.max(limit, 1), 10);
        const papers = await pubmedSearch(query, n);
        return { total: papers.length, papers };
      },
    });
  },
};

export default plugin;
