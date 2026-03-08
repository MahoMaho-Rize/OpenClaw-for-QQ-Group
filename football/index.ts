import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Football (Soccer) Plugin — 五大联赛 via ESPN API                    */
/*  英超 / 西甲 / 德甲 / 意甲 / 法甲                                     */
/*  Scoreboard, Standings, Team info                                    */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "OpenClaw-Bot/1.0";
const ESPN_BASE = "https://site.api.espn.com";

function httpGet(url: string, timeout = REQUEST_TIMEOUT): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname, path: u.pathname + u.search,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        family: 4, timeout,
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate", "Accept": "application/json" },
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

/* ---- League mapping ---- */
interface LeagueInfo { slug: string; name: string; country: string; sport: string; }
const LEAGUES: Record<string, LeagueInfo> = {
  "eng.1":  { slug: "eng.1",  name: "英超 (Premier League)",  country: "英格兰", sport: "soccer" },
  "esp.1":  { slug: "esp.1",  name: "西甲 (La Liga)",         country: "西班牙", sport: "soccer" },
  "ger.1":  { slug: "ger.1",  name: "德甲 (Bundesliga)",      country: "德国",   sport: "soccer" },
  "ita.1":  { slug: "ita.1",  name: "意甲 (Serie A)",         country: "意大利", sport: "soccer" },
  "fra.1":  { slug: "fra.1",  name: "法甲 (Ligue 1)",         country: "法国",   sport: "soccer" },
  "uefa.champions": { slug: "uefa.champions", name: "欧冠 (Champions League)", country: "欧洲", sport: "soccer" },
};

/* Chinese aliases → ESPN slug */
const LEAGUE_ALIASES: Record<string, string> = {
  "英超": "eng.1", "epl": "eng.1", "premier league": "eng.1", "pl": "eng.1",
  "西甲": "esp.1", "la liga": "esp.1", "laliga": "esp.1",
  "德甲": "ger.1", "bundesliga": "ger.1",
  "意甲": "ita.1", "serie a": "ita.1", "seriea": "ita.1",
  "法甲": "fra.1", "ligue 1": "fra.1", "ligue1": "fra.1",
  "欧冠": "uefa.champions", "ucl": "uefa.champions", "champions league": "uefa.champions",
};

function resolveLeague(input: string): LeagueInfo | null {
  const key = input.trim().toLowerCase();
  const slug = LEAGUE_ALIASES[key] || key;
  return LEAGUES[slug] || null;
}

/* ---- Helpers ---- */
function getStat(stats: any[], name: string): number {
  const s = stats.find((x: any) => x.name === name);
  return s ? s.value : 0;
}
function getStatDisplay(stats: any[], name: string): string {
  const s = stats.find((x: any) => x.name === name);
  return s ? (s.displayValue || String(s.value)) : "0";
}

function formatMatchStatus(status: any): string {
  const name = status?.type?.name || "";
  const desc = status?.type?.description || "";
  if (name === "STATUS_FULL_TIME") return "已结束";
  if (name === "STATUS_SCHEDULED") return "未开始";
  if (name === "STATUS_IN_PROGRESS") return `进行中 ${status?.displayClock || ""}`;
  if (name === "STATUS_HALFTIME") return "中场休息";
  if (name === "STATUS_POSTPONED") return "延期";
  if (name === "STATUS_CANCELED" || name === "STATUS_CANCELLED") return "取消";
  return desc || name;
}

/* ==================================================================== */

const plugin = {
  id: "football",
  name: "Football (Soccer)",
  description: "五大联赛足球数据 — 比分、积分榜、赛程（ESPN）",

  register(api: OpenClawPluginApi) {

    /* ================================================================ */
    /* Tool 1: football_scores — match scores / schedule                */
    /* ================================================================ */
    api.registerTool({
      name: "football_scores",
      label: "足球比分/赛程",
      description: `查询五大联赛足球比分和赛程（ESPN数据）。
支持英超、西甲、德甲、意甲、法甲、欧冠。
默认返回今天/最近的比赛结果。

使用场景：
- "英超今天有什么比赛"
- "西甲最新比分"
- "昨天德甲结果"
- "欧冠赛程"`,
      parameters: Type.Object({
        league: Type.String({ description: "联赛（英超/西甲/德甲/意甲/法甲/欧冠，或 eng.1/esp.1/ger.1/ita.1/fra.1）" }),
        date: Type.Optional(Type.String({ description: "日期 YYYYMMDD 格式（如 20260308）。默认=今天" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const leagueInput = String(params.league || "").trim();
        const league = resolveLeague(leagueInput);
        if (!league) {
          return { error: `未知联赛 "${leagueInput}"。支持：英超、西甲、德甲、意甲、法甲、欧冠` };
        }
        try {
          let url = `${ESPN_BASE}/apis/site/v2/sports/${league.sport}/${league.slug}/scoreboard`;
          if (params.date) url += `?dates=${params.date}`;

          const res = await httpGet(url);
          if (res.status !== 200) return { error: `ESPN HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const events = data.events || [];
          if (events.length === 0) {
            return { league: league.name, matches: [], message: "该日期暂无比赛" };
          }

          const matches = events.map((e: any) => {
            const comp = (e.competitions || [])[0] || {};
            const teams = comp.competitors || [];
            const home = teams.find((t: any) => t.homeAway === "home") || teams[0] || {};
            const away = teams.find((t: any) => t.homeAway === "away") || teams[1] || {};
            const result: any = {
              home_team: home.team?.displayName || "?",
              away_team: away.team?.displayName || "?",
              score: `${home.score || 0} - ${away.score || 0}`,
              status: formatMatchStatus(comp.status),
              date: e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "",
            };
            if (comp.venue?.fullName) result.venue = comp.venue.fullName;
            return result;
          });

          return { league: league.name, match_count: matches.length, matches };
        } catch (err) {
          return { error: `比分查询失败: ${String(err)}` };
        }
      },
    });

    /* ================================================================ */
    /* Tool 2: football_standings — league table                        */
    /* ================================================================ */
    api.registerTool({
      name: "football_standings",
      label: "足球积分榜",
      description: `查询五大联赛积分榜/排名（ESPN数据）。
返回球队排名、胜平负、进失球、积分。

使用场景：
- "英超积分榜"
- "西甲排名"
- "意甲前五名"
- "德甲降级区"`,
      parameters: Type.Object({
        league: Type.String({ description: "联赛（英超/西甲/德甲/意甲/法甲/欧冠）" }),
        top: Type.Optional(Type.Number({ description: "只返回前N名（默认全部）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const leagueInput = String(params.league || "").trim();
        const league = resolveLeague(leagueInput);
        if (!league) {
          return { error: `未知联赛 "${leagueInput}"。支持：英超、西甲、德甲、意甲、法甲、欧冠` };
        }
        try {
          const url = `${ESPN_BASE}/apis/v2/sports/${league.sport}/${league.slug}/standings`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `ESPN HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const groups = data.children || [];
          const allEntries: any[] = [];

          for (const group of groups) {
            const entries = group.standings?.entries || [];
            for (const e of entries) {
              const stats = e.stats || [];
              allEntries.push({
                rank: Math.round(getStat(stats, "rank")),
                team: e.team?.displayName || "?",
                abbr: e.team?.abbreviation || "",
                played: Math.round(getStat(stats, "gamesPlayed")),
                wins: Math.round(getStat(stats, "wins")),
                draws: Math.round(getStat(stats, "ties")),
                losses: Math.round(getStat(stats, "losses")),
                goals_for: Math.round(getStat(stats, "pointsFor")),
                goals_against: Math.round(getStat(stats, "pointsAgainst")),
                goal_diff: Math.round(getStat(stats, "pointDifferential")),
                points: Math.round(getStat(stats, "points")),
              });
            }
          }

          // Sort by rank
          allEntries.sort((a, b) => a.rank - b.rank);

          const top = params.top ? Math.min(Number(params.top), allEntries.length) : allEntries.length;
          const table = allEntries.slice(0, top);

          return { league: league.name, total_teams: allEntries.length, showing: table.length, standings: table };
        } catch (err) {
          return { error: `积分榜查询失败: ${String(err)}` };
        }
      },
    });

    /* ================================================================ */
    /* Tool 3: football_team — team info / roster                       */
    /* ================================================================ */
    api.registerTool({
      name: "football_team",
      label: "足球队信息",
      description: `查询足球队详细信息（ESPN数据）。
输入球队名和联赛，返回球队基本信息、近期赛果。

使用场景：
- "阿森纳最近战绩"
- "皇马队伍信息"
- "拜仁慕尼黑近况"`,
      parameters: Type.Object({
        league: Type.String({ description: "联赛（英超/西甲/德甲/意甲/法甲）" }),
        team: Type.String({ description: "球队名（英文，如 Arsenal, Real Madrid, Bayern Munich）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const leagueInput = String(params.league || "").trim();
        const league = resolveLeague(leagueInput);
        if (!league) {
          return { error: `未知联赛 "${leagueInput}"` };
        }
        const teamQuery = String(params.team || "").trim().toLowerCase();
        if (!teamQuery) return { error: "请提供球队名" };

        try {
          // Get teams list
          const url = `${ESPN_BASE}/apis/site/v2/sports/${league.sport}/${league.slug}/teams`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `ESPN HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const teams = (data.sports?.[0]?.leagues?.[0]?.teams || []).map((t: any) => t.team);
          const match = teams.find((t: any) => {
            const name = (t.displayName || "").toLowerCase();
            const short = (t.shortDisplayName || "").toLowerCase();
            const abbr = (t.abbreviation || "").toLowerCase();
            return name.includes(teamQuery) || short.includes(teamQuery) || abbr === teamQuery || teamQuery.includes(name);
          });

          if (!match) {
            const names = teams.map((t: any) => t.displayName).join(", ");
            return { error: `未找到球队 "${teamQuery}"。该联赛球队: ${names}` };
          }

          // Get team detail with record
          const teamUrl = `${ESPN_BASE}/apis/site/v2/sports/${league.sport}/${league.slug}/teams/${match.id}`;
          const teamRes = await httpGet(teamUrl);
          let detail: any = {};
          if (teamRes.status === 200) {
            const td = JSON.parse(teamRes.data);
            detail = td.team || {};
          }

          const record = detail.record?.items?.[0];
          const result: any = {
            name: match.displayName,
            abbreviation: match.abbreviation,
            league: league.name,
          };
          if (detail.location) result.location = detail.location;
          if (detail.venue?.fullName) result.venue = detail.venue.fullName;
          if (record) {
            const stats = record.stats || [];
            result.record = {
              summary: record.summary || "",
              played: getStatDisplay(stats, "gamesPlayed"),
              wins: getStatDisplay(stats, "wins"),
              draws: getStatDisplay(stats, "ties"),
              losses: getStatDisplay(stats, "losses"),
              goals_for: getStatDisplay(stats, "pointsFor"),
              goals_against: getStatDisplay(stats, "pointsAgainst"),
              points: getStatDisplay(stats, "points"),
            };
          }

          // Next event
          if (detail.nextEvent?.[0]) {
            const ne = detail.nextEvent[0];
            const comps = ne.competitions?.[0]?.competitors || [];
            result.next_match = {
              name: ne.name || "",
              date: ne.date ? new Date(ne.date).toISOString().slice(0, 16).replace("T", " ") : "",
              teams: comps.map((c: any) => c.team?.displayName || "?"),
            };
          }

          return result;
        } catch (err) {
          return { error: `球队查询失败: ${String(err)}` };
        }
      },
    });

    /* ================================================================ */
    /* Tool 4: football_transfer_news — transfer rumors & news          */
    /* ================================================================ */
    api.registerTool({
      name: "football_transfer_news",
      label: "足球转会流言",
      description: `查询最新足球转会流言和新闻（ESPN数据）。
从五大联赛筛选带有 "soccer transfers" 标签的文章，返回标题、摘要、涉及球队/球员。

使用场景：
- "最近有什么转会消息"
- "英超转会流言"
- "皇马想签谁"
- "转会市场最新动态"`,
      parameters: Type.Object({
        league: Type.Optional(Type.String({ description: "指定联赛筛选（英超/西甲/德甲/意甲/法甲）。不指定则汇总五大联赛" })),
        limit: Type.Optional(Type.Number({ description: "返回条数上限（默认10，最多20）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const maxItems = Math.min(Math.max(Number(params.limit) || 10, 1), 20);

        /* Determine which leagues to fetch */
        let leagueSlugs: string[];
        let leagueLabel: string;
        if (params.league) {
          const league = resolveLeague(String(params.league));
          if (!league) {
            return { error: `未知联赛 "${params.league}"。支持：英超、西甲、德甲、意甲、法甲、欧冠` };
          }
          leagueSlugs = [league.slug];
          leagueLabel = league.name;
        } else {
          leagueSlugs = ["eng.1", "esp.1", "ger.1", "ita.1", "fra.1"];
          leagueLabel = "五大联赛";
        }

        try {
          /* Fetch news from each league in parallel */
          const fetches = leagueSlugs.map(async (slug) => {
            const url = `${ESPN_BASE}/apis/site/v2/sports/soccer/${slug}/news?limit=25`;
            try {
              const res = await httpGet(url);
              if (res.status !== 200) return [];
              const data = JSON.parse(res.data);
              return (data.articles || []).map((a: any) => ({ ...a, _league: slug }));
            } catch { return []; }
          });

          const allArticles = (await Promise.all(fetches)).flat();

          /* Filter for transfer-related articles */
          const transferArticles = allArticles.filter((a: any) => {
            const cats = (a.categories || []).map((c: any) => (c.description || "").toLowerCase());
            const headline = (a.headline || "").toLowerCase();
            return cats.includes("soccer transfers")
              || cats.includes("blog - transfer talk")
              || headline.includes("transfer")
              || headline.includes("signing")
              || headline.includes("signs")
              || headline.includes("signs new");
          });

          /* Sort by published date descending */
          transferArticles.sort((a: any, b: any) => {
            const da = a.published ? new Date(a.published).getTime() : 0;
            const db = b.published ? new Date(b.published).getTime() : 0;
            return db - da;
          });

          /* Deduplicate by headline */
          const seen = new Set<string>();
          const unique = transferArticles.filter((a: any) => {
            const h = a.headline || "";
            if (seen.has(h)) return false;
            seen.add(h);
            return true;
          });

          const items = unique.slice(0, maxItems).map((a: any) => {
            const cats = (a.categories || [])
              .map((c: any) => c.description || "")
              .filter((d: string) => d && d !== "Soccer" && d !== "soccer transfers" && d !== "blog - transfer talk" && d !== "news" && d !== "");
            const leagueInfo = LEAGUES[a._league];
            const result: any = {
              headline: a.headline || "",
              summary: a.description || "",
              published: a.published ? new Date(a.published).toISOString().slice(0, 16).replace("T", " ") : "",
              league: leagueInfo?.name || a._league,
            };
            /* Extract involved teams/players from categories */
            const entities = cats.filter((c: string) =>
              !c.toLowerCase().includes("premier league")
              && !c.toLowerCase().includes("la liga")
              && !c.toLowerCase().includes("bundesliga")
              && !c.toLowerCase().includes("serie a")
              && !c.toLowerCase().includes("ligue 1")
              && !c.toLowerCase().includes("champions league")
              && !c.toLowerCase().includes("english")
              && !c.toLowerCase().includes("german")
              && !c.toLowerCase().includes("spanish")
              && !c.toLowerCase().includes("italian")
              && !c.toLowerCase().includes("french")
            );
            if (entities.length > 0) result.involved = entities.slice(0, 6);
            const link = a.links?.web?.href || "";
            if (link) result.link = link;
            return result;
          });

          if (items.length === 0) {
            return { league: leagueLabel, transfers: [], message: "暂无最新转会流言" };
          }

          return {
            league: leagueLabel,
            count: items.length,
            transfers: items,
            note: "数据来源：ESPN Transfer Talk",
          };
        } catch (err) {
          return { error: `转会流言查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[football] Registered football_scores + football_standings + football_team + football_transfer_news tools");
  },
};

export default plugin;
