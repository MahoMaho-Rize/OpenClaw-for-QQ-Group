import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// HTTP helpers
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

/** MusicBrainz requires a User-Agent with contact info. */
function mbGet(url: string, timeout = REQUEST_TIMEOUT): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname, path: u.pathname + u.search,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        family: 4, timeout,
        headers: {
          "User-Agent": "OpenClaw-Bot/1.0 (openclaw@example.com)",
          "Accept-Encoding": "gzip, deflate",
        },
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
// Plugin
// ---------------------------------------------------------------------------

const plugin = {
  id: "arts",
  name: "Arts & Culture",
  description: "芝加哥艺术馆藏品搜索 + MusicBrainz音乐数据库 + 圣经经文查询",

  register(api: OpenClawPluginApi) {
    // -----------------------------------------------------------------------
    // Tool 1: Art Institute of Chicago artwork search
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "artic_artwork_search",
      description: "搜索芝加哥艺术学院的馆藏艺术品，可按作品名称或艺术家检索，返回作品详情及图片链接。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词（作品名称或艺术家）" }),
        limit: Type.Number({ description: "返回结果数量，默认5，最大10", default: 5 }),
      }),
      async execute({ query, limit = 5 }) {
        const n = Math.min(Math.max(1, limit), 10);
        const fields = "id,title,artist_display,date_display,medium_display,dimensions,image_id,thumbnail";
        const url = `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}&limit=${n}&fields=${fields}`;
        const { status, data } = await httpGet(url);
        if (status !== 200) {
          return { error: `Art Institute API 返回状态码 ${status}` };
        }
        const json = JSON.parse(data);
        const artworks = (json.data ?? []).map((item: any) => ({
          title: item.title ?? "",
          artist: item.artist_display ?? "",
          date: item.date_display ?? "",
          medium: item.medium_display ?? "",
          dimensions: item.dimensions ?? "",
          image_url: item.image_id
            ? `https://www.artic.edu/iiif/2/${item.image_id}/full/843,/0/default.jpg`
            : null,
          artic_url: `https://www.artic.edu/artworks/${item.id}`,
        }));
        return { artworks };
      },
    });

    // -----------------------------------------------------------------------
    // Tool 2: MusicBrainz music database search
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "musicbrainz_search",
      description: "搜索MusicBrainz音乐数据库，支持按艺术家、专辑或录音检索，返回详细音乐元数据。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        entity: Type.Union(
          [Type.Literal("artist"), Type.Literal("release"), Type.Literal("recording")],
          { description: "搜索类型：artist（艺术家）、release（专辑）、recording（录音）", default: "artist" },
        ),
        limit: Type.Number({ description: "返回结果数量，默认5，最大10", default: 5 }),
      }),
      async execute({ query, entity = "artist", limit = 5 }) {
        const n = Math.min(Math.max(1, limit), 10);
        const url = `https://musicbrainz.org/ws/2/${entity}/?query=${encodeURIComponent(query)}&limit=${n}&fmt=json`;
        const { status, data } = await mbGet(url);
        if (status !== 200) {
          return { error: `MusicBrainz API 返回状态码 ${status}` };
        }
        const json = JSON.parse(data);

        if (entity === "artist") {
          const results = (json.artists ?? []).map((a: any) => ({
            name: a.name ?? "",
            type: a.type ?? "",
            country: a.country ?? "",
            disambiguation: a.disambiguation ?? "",
            life_span: a["life-span"] ?? {},
            tags: (a.tags ?? []).map((t: any) => t.name),
          }));
          return { results };
        }

        if (entity === "release") {
          const results = (json.releases ?? []).map((r: any) => ({
            title: r.title ?? "",
            artist: (r["artist-credit"] ?? []).map((c: any) => c.name).join(", "),
            date: r.date ?? "",
            country: r.country ?? "",
            status: r.status ?? "",
            barcode: r.barcode ?? "",
          }));
          return { results };
        }

        // recording
        const results = (json.recordings ?? []).map((r: any) => {
          const ms = r.length ?? 0;
          const mins = Math.floor(ms / 60000);
          const secs = Math.floor((ms % 60000) / 1000);
          return {
            title: r.title ?? "",
            artist: (r["artist-credit"] ?? []).map((c: any) => c.name).join(", "),
            length: `${mins}:${secs.toString().padStart(2, "0")}`,
            releases: (r.releases ?? []).map((rel: any) => rel.title),
          };
        });
        return { results };
      },
    });

    // -----------------------------------------------------------------------
    // Tool 3: Bible verse lookup
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "bible_verse",
      description: "查询圣经经文，支持按书卷章节检索（如 John 3:16、Genesis 1:1-3、Psalm 23），返回经文内容及翻译信息。",
      parameters: Type.Object({
        reference: Type.String({ description: "圣经经文引用（例如 John 3:16、Genesis 1:1-3、Psalm 23）" }),
      }),
      async execute({ reference }) {
        const url = `https://bible-api.com/${encodeURIComponent(reference)}`;
        const { status, data } = await httpGet(url);
        if (status !== 200) {
          return { error: `Bible API 返回状态码 ${status}` };
        }
        const json = JSON.parse(data);
        return {
          reference: json.reference ?? reference,
          text: json.text ?? "",
          translation: json.translation_name ?? "",
          verse_count: json.verses ? json.verses.length : 0,
        };
      },
    });
  },
};

export default plugin;
