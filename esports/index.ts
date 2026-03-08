import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import https from "node:https";
import zlib from "node:zlib";

// ═══════════════════════════════════════════════════════════════════
//  Part 1: Liquipedia — MediaWiki API
//  支持: dota2, counterstrike, leagueoflegends, valorant, starcraft2,
//        overwatch, rocketleague, fighters, apexlegends, ...
// ═══════════════════════════════════════════════════════════════════

const LP_UA = "OpenClaw-Esports/1.0 (https://github.com/openclaw; openclaw-esports-plugin)";

const WIKI_ALIASES: Record<string, string> = {
  dota: "dota2",
  dota2: "dota2",
  cs: "counterstrike",
  cs2: "counterstrike",
  csgo: "counterstrike",
  counterstrike: "counterstrike",
  lol: "leagueoflegends",
  league: "leagueoflegends",
  leagueoflegends: "leagueoflegends",
  val: "valorant",
  valorant: "valorant",
  sc2: "starcraft2",
  starcraft: "starcraft2",
  starcraft2: "starcraft2",
  ow: "overwatch",
  overwatch: "overwatch",
  rl: "rocketleague",
  rocketleague: "rocketleague",
  apex: "apexlegends",
  apexlegends: "apexlegends",
  fighters: "fighters",
  fg: "fighters",
  ow2: "overwatch",
  r6: "rainbowsix",
  rainbowsix: "rainbowsix",
  pubg: "pubg",
  deadlock: "deadlock",
  marvel: "marvelrivals",
  marvelrivals: "marvelrivals",
};

function resolveWiki(input: string): string {
  const key = input.toLowerCase().replace(/[\s\-_]/g, "");
  return WIKI_ALIASES[key] || input.toLowerCase();
}

// ─── Rate limiter ───
// query: 1 req / 2s,  parse: 1 req / 30s
let lastQueryTime = 0;
let lastParseTime = 0;

async function rateLimitQuery(): Promise<void> {
  const now = Date.now();
  const wait = 2100 - (now - lastQueryTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastQueryTime = Date.now();
}

async function rateLimitParse(): Promise<void> {
  const now = Date.now();
  const wait = 30500 - (now - lastParseTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastParseTime = Date.now();
}

// ─── HTTP with gzip ───

function lpGet(url: string, timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        family: 4,
        headers: {
          "User-Agent": LP_UA,
          "Accept-Encoding": "gzip, deflate",
          Accept: "application/json",
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const stream =
          res.headers["content-encoding"] === "gzip"
            ? res.pipe(zlib.createGunzip())
            : res.headers["content-encoding"] === "deflate"
              ? res.pipe(zlib.createInflate())
              : res;
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Liquipedia API timeout"));
    });
  });
}

async function lpQuery(wiki: string, params: Record<string, string>): Promise<any> {
  await rateLimitQuery();
  const qs = new URLSearchParams({ format: "json", ...params }).toString();
  const raw = await lpGet(`https://liquipedia.net/${wiki}/api.php?${qs}`);
  return JSON.parse(raw);
}

async function lpParse(wiki: string, params: Record<string, string>): Promise<any> {
  await rateLimitParse();
  const qs = new URLSearchParams({ format: "json", action: "parse", ...params }).toString();
  const raw = await lpGet(`https://liquipedia.net/${wiki}/api.php?${qs}`);
  return JSON.parse(raw);
}

// ─── Simple in-memory cache (TTL 5 min) ───
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then((data) => {
    cache.set(key, { data, ts: Date.now() });
    // evict old entries
    if (cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (now - v.ts > CACHE_TTL) cache.delete(k);
      }
    }
    return data;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Wikitext parsers — extract structured data from Liquipedia templates
// ═══════════════════════════════════════════════════════════════════

/** Extract key=value pairs from an {{Infobox ...}} template */
function parseInfobox(wikitext: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Match |key=value lines, handling multiline values
  const lines = wikitext.split("\n");
  let currentKey = "";
  let currentVal = "";
  for (const line of lines) {
    const m = line.match(/^\s*\|(\w[\w\s]*\w|\w+)\s*=\s*(.*)/);
    if (m) {
      if (currentKey) result[currentKey.trim()] = cleanInfoboxVal(currentVal);
      currentKey = m[1];
      currentVal = m[2];
    } else if (currentKey) {
      currentVal += " " + line.trim();
    }
  }
  if (currentKey) result[currentKey.trim()] = cleanInfoboxVal(currentVal);
  return result;
}

/** Strip HTML comments, refs, and excess whitespace from infobox values */
function cleanInfoboxVal(val: string): string {
  return val
    .replace(/<!--.*?-->/gs, "")
    .replace(/<ref[^>]*>.*?<\/ref>/gs, "")
    .replace(/<ref[^/]*\/>/g, "")
    .replace(/\{\{PlayerTeamAuto\}\}/gi, "(auto)")
    .trim();
}

/** Extract {{Person|...}} entries from Squad template */
function parseSquad(wikitext: string): Array<{ id: string; name: string; flag: string; position: string; captain: boolean }> {
  const players: Array<{ id: string; name: string; flag: string; position: string; captain: boolean }> = [];
  const personRegex = /\{\{Person\|([^}]+)\}\}/g;
  let match;
  while ((match = personRegex.exec(wikitext)) !== null) {
    const params: Record<string, string> = {};
    match[1].split("|").forEach((part) => {
      const eq = part.indexOf("=");
      if (eq > 0) {
        const key = part.slice(0, eq).trim();
        let val = part.slice(eq + 1).trim();
        // strip <ref> tags
        val = val.replace(/<ref[^>]*>.*?<\/ref>/gs, "").replace(/<ref[^/]*\/>/g, "").trim();
        params[key] = val;
      }
    });
    players.push({
      id: params.id || "",
      name: params.name || "",
      flag: params.flag || "",
      position: params.position || "",
      captain: params.captain === "yes",
    });
  }
  return players;
}

/** Clean wikitext: strip refs, templates noise, keep readable text */
function cleanWikitext(wt: string): string {
  return wt
    .replace(/<ref[^>]*>.*?<\/ref>/gs, "")
    .replace(/<ref[^/]*\/>/g, "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/\{\{[Cc]ite web\|[^}]*\}\}/g, "")
    .replace(/\{\{DISPLAYTITLE:[^}]*\}\}/g, "")
    .replace(/\{\{[A-Z][A-Za-z0-9]*Tabs\|[^}]*\}\}/g, "")
    .replace(/\{\{TOClimit\|\d+\}\}/g, "")
    .replace(/\{\{box\|break\}\}/gi, "")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")  // [[link|text]] → text
    .replace(/\[\[([^\]]*)\]\]/g, "$1")              // [[link]] → link
    .replace(/'''([^']*)'''/g, "$1")                  // bold
    .replace(/''([^']*)''/g, "$1")                    // italic
    .trim();
}

// ─── Format player info from Infobox ───
function formatPlayerInfo(info: Record<string, string>, wiki: string): string {
  const lines: string[] = [];
  if (info.id) lines.push(`ID: ${info.id}`);
  if (info.ids) lines.push(`曾用名: ${info.ids}`);
  if (info.name || info.romanized_name) lines.push(`真名: ${info.romanized_name || info.name}`);
  if (info.birth_date) lines.push(`出生日期: ${info.birth_date}`);
  if (info.country) lines.push(`国籍: ${info.country}`);
  if (info.status) lines.push(`状态: ${info.status}`);
  if (info.team) lines.push(`队伍: ${cleanWikitext(info.team)}`);
  if (info.roles || info.role) lines.push(`角色: ${info.roles || info.role}`);
  // Game-specific
  if (info.hero) lines.push(`招牌英雄: ${[info.hero, info.hero2, info.hero3].filter(Boolean).join(", ")}`);
  if (info.signature_heroes) lines.push(`招牌英雄: ${info.signature_heroes}`);
  if (info.agent) lines.push(`招牌特工: ${[info.agent, info.agent2, info.agent3].filter(Boolean).join(", ")}`);
  // Socials
  const socials: string[] = [];
  if (info.twitch) socials.push(`Twitch: ${info.twitch}`);
  if (info.twitter) socials.push(`Twitter: ${info.twitter}`);
  if (info.instagram) socials.push(`IG: ${info.instagram}`);
  if (socials.length) lines.push(`社交: ${socials.join(" | ")}`);
  lines.push(`来源: https://liquipedia.net/${wiki}/${encodeURIComponent(info.id || "")}`);
  return lines.join("\n");
}

// ─── Format tournament info from Infobox ───
function formatTournamentInfo(info: Record<string, string>, introText: string): string {
  const lines: string[] = [];
  if (info.name) lines.push(`赛事: ${info.name}`);
  if (info.series) lines.push(`系列: ${info.series}`);
  if (info.organizer) {
    const orgs = [info.organizer, info.organizer2, info.organizer3].filter(Boolean);
    lines.push(`主办: ${orgs.join(", ")}`);
  }
  if (info.type) lines.push(`类型: ${info.type}`);
  if (info.country && info.city) lines.push(`地点: ${info.city}, ${info.country}`);
  else if (info.country) lines.push(`地区: ${info.country}`);
  if (info.venue) lines.push(`场馆: ${cleanWikitext(info.venue)}`);
  if (info.sdate && info.edate) lines.push(`日期: ${info.sdate} ~ ${info.edate}`);
  else if (info.sdate) lines.push(`日期: ${info.sdate}`);
  if (info.prizepoolusd) lines.push(`奖金池: $${cleanWikitext(info.prizepoolusd)}`);
  else if (info.prizepool) lines.push(`奖金池: ${cleanWikitext(info.prizepool)}`);
  if (info.team_number) lines.push(`参赛队伍数: ${info.team_number}`);
  if (info.format) lines.push(`赛制: ${cleanWikitext(info.format)}`);
  if (info.patch) lines.push(`版本: ${info.patch}`);
  if (info.liquipediatier) lines.push(`Tier: ${info.liquipediatier}`);
  // Intro paragraph
  const intro = cleanWikitext(introText).split("\n").filter((l) => l.length > 20);
  if (intro.length) {
    lines.push("", intro.slice(0, 5).join("\n"));
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
//  Part 2: HLTV — CS2 专用数据 (via npm hltv package)
// ═══════════════════════════════════════════════════════════════════

// HLTV tools are DISABLED — hltv.org is behind Cloudflare bot protection
// which blocks all server-side requests (both the npm package and direct HTTP).
// Liquipedia's CS2 wiki is the fallback for CS2 data.
const HLTV_DISABLED_MSG = "HLTV 工具暂不可用 — hltv.org 启用了 Cloudflare 反爬虫保护，服务端无法访问。请改用 liquipedia_search/liquipedia_player/liquipedia_roster (wiki=cs2) 查询 CS2 数据。";

// ═══════════════════════════════════════════════════════════════════
//  OpenClaw Plugin Registration
// ═══════════════════════════════════════════════════════════════════

export default {
  id: "esports",
  name: "Esports",
  description:
    "电竞数据工具集 — Liquipedia(Dota2/CS2/LoL/Valorant/SC2等) + HLTV(CS2排名/战队/选手)",

  register(api: OpenClawPluginApi) {

    // ═══════════════════════════════════════════════════════════
    //  Liquipedia Tools
    // ═══════════════════════════════════════════════════════════

    // ─── Tool 1: 搜索 ───
    api.registerTool({
      name: "liquipedia_search",
      description: `在 Liquipedia 搜索电竞相关页面。支持的游戏 wiki: dota2, cs2, lol, valorant, sc2, overwatch, rocketleague, apexlegends, fighters, rainbowsix, deadlock, marvelrivals。
可搜索: 选手名、战队名、赛事名、英雄/地图/特工名等。返回匹配页面列表。
此工具速度快(2秒限速), 建议先搜索再用其他工具查看详情。`,
      parameters: Type.Object({
        wiki: Type.String({
          description: "游戏wiki: dota2/dota, cs2/cs, lol/league, valorant/val, sc2, overwatch/ow, 等",
        }),
        keyword: Type.String({ description: "搜索关键词, 如 Team Spirit, s1mple, TI 2024" }),
        limit: Type.Optional(
          Type.Number({ description: "结果数量(1-20), 默认10", default: 10 }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        const wiki = resolveWiki(p.wiki);
        const limit = Math.min(Math.max(p.limit || 10, 1), 20);
        const cacheKey = `lp:search:${wiki}:${p.keyword}:${limit}`;
        return cached(cacheKey, async () => {
          const data = await lpQuery(wiki, {
            action: "query",
            list: "search",
            srsearch: p.keyword,
            srlimit: String(limit),
          });
          const results = data?.query?.search;
          if (!results?.length) return `Liquipedia [${wiki}] 未找到与"${p.keyword}"相关的页面`;
          const total = data.query.searchinfo?.totalhits || results.length;
          const lines = results.map((r: any, i: number) => {
            const snippet = r.snippet
              ?.replace(/<[^>]+>/g, "")
              .replace(/&[a-z]+;/g, "")
              .slice(0, 120);
            return `${i + 1}. ${r.title} (pageid:${r.pageid})\n   ${snippet || ""}`;
          });
          return `Liquipedia [${wiki}] 搜索"${p.keyword}" (约${total}条结果):\n\n${lines.join("\n\n")}`;
        });
      },
    });

    // ─── Tool 2: 页面概览 (章节列表) ───
    api.registerTool({
      name: "liquipedia_sections",
      description: `获取 Liquipedia 页面的章节目录。用于了解页面结构, 然后用 liquipedia_read 读取特定章节。
注意: 此工具使用 parse API, 限速30秒/次, 请先用 search 确认页面名称。`,
      parameters: Type.Object({
        wiki: Type.String({ description: "游戏wiki" }),
        title: Type.String({ description: "页面标题 (从搜索结果获取), 如 Team_Spirit, Yatoro" }),
      }),
      execute: async (_id: string, p: any) => {
        const wiki = resolveWiki(p.wiki);
        const title = p.title.replace(/ /g, "_");
        const cacheKey = `lp:sections:${wiki}:${title}`;
        return cached(cacheKey, async () => {
          const data = await lpParse(wiki, { page: title, prop: "sections" });
          const sections = data?.parse?.sections;
          if (!sections?.length) return `页面 "${p.title}" 无章节或不存在`;
          const lines = sections.map((s: any) => {
            const indent = "  ".repeat(s.toclevel - 1);
            return `${indent}${s.number}. ${s.line} (section=${s.index})`;
          });
          return `Liquipedia [${wiki}] "${data.parse.title}" 章节目录:\n\n${lines.join("\n")}\n\n使用 liquipedia_read 读取特定章节, 传入 section 编号。`;
        });
      },
    });

    // ─── Tool 3: 读取页面/章节内容 ───
    api.registerTool({
      name: "liquipedia_read",
      description: `读取 Liquipedia 页面内容。可读取整个引言(section=0)或指定章节。
返回清理后的 wikitext 内容。对于选手/战队/赛事页面, 会自动提取结构化信息。
限速30秒/次。`,
      parameters: Type.Object({
        wiki: Type.String({ description: "游戏wiki" }),
        title: Type.String({ description: "页面标题" }),
        section: Type.Optional(
          Type.String({ description: "章节编号(从 liquipedia_sections 获取), 默认0(引言/概览)", default: "0" }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        const wiki = resolveWiki(p.wiki);
        const title = p.title.replace(/ /g, "_");
        const section = p.section ?? "0";
        const cacheKey = `lp:read:${wiki}:${title}:${section}`;
        return cached(cacheKey, async () => {
          const data = await lpParse(wiki, { page: title, prop: "wikitext", section });
          const wt: string = data?.parse?.wikitext?.["*"] || "";
          if (!wt.trim()) return `页面 "${p.title}" section=${section} 无内容或不存在`;

          const pageTitle = data.parse.title || p.title;
          const parts: string[] = [`[${wiki}] ${pageTitle} (section ${section})`];

          // Auto-detect and format structured content
          if (wt.includes("{{Infobox player")) {
            const info = parseInfobox(wt);
            parts.push("\n--- 选手信息 ---");
            parts.push(formatPlayerInfo(info, wiki));
          } else if (wt.includes("{{Infobox league") || wt.includes("{{Infobox tournament")) {
            const info = parseInfobox(wt);
            const introLines = wt.split("\n").filter((l) => l.startsWith("'''") || (l.length > 50 && !l.startsWith("|") && !l.startsWith("{") && !l.startsWith("}")));
            parts.push("\n--- 赛事信息 ---");
            parts.push(formatTournamentInfo(info, introLines.join("\n")));
          } else if (wt.includes("{{Infobox team")) {
            const info = parseInfobox(wt);
            parts.push("\n--- 战队信息 ---");
            if (info.name) parts.push(`名称: ${info.name}`);
            if (info.location || info.region) parts.push(`地区: ${info.location || info.region}`);
            if (info.coach) parts.push(`教练: ${cleanWikitext(info.coach)}`);
            if (info.manager) parts.push(`经理: ${cleanWikitext(info.manager)}`);
            if (info.earnings) parts.push(`总奖金: ${cleanWikitext(info.earnings)}`);
            if (info.created) parts.push(`成立: ${info.created}`);
          }

          // Extract squad if present
          if (wt.includes("{{Squad") || wt.includes("{{Person|")) {
            const players = parseSquad(wt);
            if (players.length) {
              parts.push("\n--- 阵容 ---");
              players.forEach((pl) => {
                const cap = pl.captain ? " (C)" : "";
                const pos = pl.position ? ` [Pos ${pl.position}]` : "";
                parts.push(`  ${pl.flag ? `[${pl.flag}]` : ""} ${pl.id}${cap}${pos} — ${pl.name}`);
              });
            }
          }

          // Append cleaned text for sections without infobox
          if (!wt.includes("{{Infobox")) {
            const cleaned = cleanWikitext(wt);
            if (cleaned.length > 10) {
              // Truncate very long content
              const text = cleaned.length > 4000 ? cleaned.slice(0, 4000) + "\n...(内容过长已截断)" : cleaned;
              parts.push("\n" + text);
            }
          }

          return parts.join("\n");
        });
      },
    });

    // ─── Tool 4: 选手快查 ───
    api.registerTool({
      name: "liquipedia_player",
      description: `快速查询电竞选手信息 — ID、真名、国籍、队伍、角色、招牌英雄等。
内部先搜索再解析 Infobox, 会消耗两次 API 调用。`,
      parameters: Type.Object({
        wiki: Type.String({ description: "游戏wiki: dota2, cs2, lol, valorant, sc2 等" }),
        name: Type.String({ description: "选手ID或名字, 如 Yatoro, s1mple, Faker" }),
      }),
      execute: async (_id: string, p: any) => {
        const wiki = resolveWiki(p.wiki);

        // Step 1: search to get exact page title
        const searchData = await lpQuery(wiki, {
          action: "query",
          list: "search",
          srsearch: p.name,
          srlimit: "5",
        });
        const results = searchData?.query?.search;
        if (!results?.length) return `Liquipedia [${wiki}] 未找到选手"${p.name}"`;

        // Try to find the best match (exact or first result)
        const exactMatch = results.find(
          (r: any) => r.title.toLowerCase() === p.name.toLowerCase(),
        );
        const pageTitle = (exactMatch || results[0]).title;

        // Step 2: parse the page intro for infobox
        const cacheKey = `lp:player:${wiki}:${pageTitle}`;
        return cached(cacheKey, async () => {
          const data = await lpParse(wiki, { page: pageTitle.replace(/ /g, "_"), prop: "wikitext", section: "0" });
          const wt: string = data?.parse?.wikitext?.["*"] || "";
          if (!wt.includes("{{Infobox player")) {
            return `"${pageTitle}" 不是选手页面。搜索到的页面:\n${results.map((r: any) => `- ${r.title}`).join("\n")}`;
          }
          const info = parseInfobox(wt);
          return `Liquipedia [${wiki}] 选手信息:\n${formatPlayerInfo(info, wiki)}`;
        });
      },
    });

    // ─── Tool 5: 赛事快查 ───
    api.registerTool({
      name: "liquipedia_tournament",
      description: `快速查询电竞赛事信息 — 名称、组织方、日期、奖金、赛制、参赛队伍等。
适用于查询 The International, Major, Worlds 等大型赛事。`,
      parameters: Type.Object({
        wiki: Type.String({ description: "游戏wiki" }),
        name: Type.String({ description: "赛事名称, 如 The International 2024, PGL Major, Worlds 2024" }),
      }),
      execute: async (_id: string, p: any) => {
        const wiki = resolveWiki(p.wiki);

        const searchData = await lpQuery(wiki, {
          action: "query",
          list: "search",
          srsearch: p.name,
          srlimit: "5",
        });
        const results = searchData?.query?.search;
        if (!results?.length) return `Liquipedia [${wiki}] 未找到赛事"${p.name}"`;

        const pageTitle = results[0].title;
        const cacheKey = `lp:tournament:${wiki}:${pageTitle}`;
        return cached(cacheKey, async () => {
          const data = await lpParse(wiki, { page: pageTitle.replace(/ /g, "_"), prop: "wikitext", section: "0" });
          const wt: string = data?.parse?.wikitext?.["*"] || "";
          if (!wt.includes("{{Infobox league") && !wt.includes("{{Infobox tournament")) {
            return `"${pageTitle}" 可能不是赛事页面。搜索到的页面:\n${results.map((r: any) => `- ${r.title}`).join("\n")}`;
          }
          const info = parseInfobox(wt);
          const introLines = wt.split("\n").filter((l) => l.startsWith("'''") || (l.length > 50 && !l.startsWith("|") && !l.startsWith("{") && !l.startsWith("}")));
          return `Liquipedia [${wiki}] 赛事信息:\n${formatTournamentInfo(info, introLines.join("\n"))}`;
        });
      },
    });

    // ─── Tool 6: 战队阵容快查 ───
    api.registerTool({
      name: "liquipedia_roster",
      description: `查询电竞战队当前阵容。返回队员ID、真名、国籍、位置。
内部自动搜索并解析 Active Roster 章节。`,
      parameters: Type.Object({
        wiki: Type.String({ description: "游戏wiki" }),
        team: Type.String({ description: "战队名称, 如 Team Spirit, Natus Vincere, T1, Fnatic" }),
      }),
      execute: async (_id: string, p: any) => {
        const wiki = resolveWiki(p.wiki);

        const searchData = await lpQuery(wiki, {
          action: "query",
          list: "search",
          srsearch: p.team,
          srlimit: "5",
        });
        const results = searchData?.query?.search;
        if (!results?.length) return `Liquipedia [${wiki}] 未找到战队"${p.team}"`;

        const pageTitle = results[0].title;
        const cacheKey = `lp:roster:${wiki}:${pageTitle}`;
        return cached(cacheKey, async () => {
          // First get sections to find roster
          const secData = await lpParse(wiki, { page: pageTitle.replace(/ /g, "_"), prop: "sections" });
          const sections = secData?.parse?.sections || [];

          // Find "Active" or "Roster" or "Players" section
          const rosterSec = sections.find((s: any) =>
            /active roster|current roster|active|players of/i.test(s.line),
          );

          // If found, read that section; otherwise read section 0
          const targetSection = rosterSec?.index || "0";
          const data = await lpParse(wiki, { page: pageTitle.replace(/ /g, "_"), prop: "wikitext", section: targetSection });
          const wt: string = data?.parse?.wikitext?.["*"] || "";

          const players = parseSquad(wt);
          if (!players.length) {
            // Fallback: try to find any Person templates in section 0
            if (targetSection !== "0") {
              const data0 = await lpParse(wiki, { page: pageTitle.replace(/ /g, "_"), prop: "wikitext", section: "0" });
              const wt0: string = data0?.parse?.wikitext?.["*"] || "";
              const players0 = parseSquad(wt0);
              if (players0.length) {
                const lines = players0.map((pl) => {
                  const cap = pl.captain ? " (C)" : "";
                  const pos = pl.position ? ` [Pos ${pl.position}]` : "";
                  return `  [${pl.flag}] ${pl.id}${cap}${pos} — ${pl.name}`;
                });
                return `Liquipedia [${wiki}] ${pageTitle} 阵容:\n${lines.join("\n")}`;
              }
            }
            return `未能从 "${pageTitle}" 解析出阵容信息。请用 liquipedia_sections 查看页面结构后手动指定章节。`;
          }

          const lines = players.map((pl) => {
            const cap = pl.captain ? " (C)" : "";
            const pos = pl.position ? ` [Pos ${pl.position}]` : "";
            return `  [${pl.flag}] ${pl.id}${cap}${pos} — ${pl.name}`;
          });
          return `Liquipedia [${wiki}] ${pageTitle} 当前阵容:\n${lines.join("\n")}`;
        });
      },
    });

    console.log("[esports] Registered 6 Liquipedia tools (search/sections/read/player/tournament/roster)");

    // ═══════════════════════════════════════════════════════════
    //  HLTV Tools — CS2 专用
    // ═══════════════════════════════════════════════════════════

    // ─── HLTV Tools (disabled — Cloudflare blocks server-side access) ───
    // Register them so the bot knows they exist but returns a helpful message
    api.registerTool({
      name: "hltv_ranking",
      description: "获取 HLTV CS2 世界战队排名（当前不可用，请用 liquipedia_search wiki=cs2 代替）。",
      parameters: Type.Object({
        top: Type.Optional(Type.Number({ description: "显示前N名", default: 20 })),
      }),
      execute: async () => HLTV_DISABLED_MSG,
    });

    api.registerTool({
      name: "hltv_team",
      description: "查询 HLTV CS2 战队详情（当前不可用，请用 liquipedia_roster wiki=cs2 代替）。",
      parameters: Type.Object({
        name: Type.String({ description: "战队名称" }),
      }),
      execute: async () => HLTV_DISABLED_MSG,
    });

    api.registerTool({
      name: "hltv_player",
      description: "查询 HLTV CS2 选手详情（当前不可用，请用 liquipedia_player wiki=cs2 代替）。",
      parameters: Type.Object({
        id: Type.Optional(Type.Number({ description: "HLTV 选手ID" })),
        name: Type.Optional(Type.String({ description: "选手名" })),
      }),
      execute: async () => HLTV_DISABLED_MSG,
    });

    api.registerTool({
      name: "hltv_news",
      description: "获取 HLTV CS2 最新新闻（当前不可用，请用 liquipedia_search wiki=cs2 搜索赛事新闻）。",
      parameters: Type.Object({
        count: Type.Optional(Type.Number({ description: "新闻条数", default: 15 })),
      }),
      execute: async () => HLTV_DISABLED_MSG,
    });

    api.registerTool({
      name: "hltv_event",
      description: "查询 HLTV CS2 赛事详情（当前不可用，请用 liquipedia_tournament wiki=cs2 代替）。",
      parameters: Type.Object({
        id: Type.Number({ description: "HLTV 赛事ID" }),
      }),
      execute: async () => HLTV_DISABLED_MSG,
    });

    console.log("[esports] Registered 5 HLTV CS2 tools (DISABLED — Cloudflare blocked, returning fallback messages)");
    console.log("[esports] Total: 11 esports tools (6 Liquipedia active + 5 HLTV disabled)");
  },
};
