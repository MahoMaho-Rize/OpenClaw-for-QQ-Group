import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  NBA + MLB Plugin                                                    */
/*  NBA: ESPN API  |  MLB: ESPN + MLB Stats API (statsapi.mlb.com)     */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ESPN_BASE = "https://site.api.espn.com";
const MLB_API = "https://statsapi.mlb.com";

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

/* ---- Helpers ---- */
function getStat(stats: any[], name: string): any {
  const s = stats.find((x: any) => x.name === name);
  return s ? s.value : 0;
}
function getStatDisplay(stats: any[], name: string): string {
  const s = stats.find((x: any) => x.name === name);
  return s ? (s.displayValue || String(s.value)) : "0";
}

/* ==================================================================== */

const plugin = {
  id: "nba-mlb",
  name: "NBA & MLB",
  description: "NBA篮球 + MLB棒球数据 — 比分、积分榜、球员（ESPN + MLB官方API）",

  register(api: OpenClawPluginApi) {

    /* ================================================================ */
    /*                         NBA TOOLS                                */
    /* ================================================================ */

    /* ---- NBA Scores ---- */
    api.registerTool({
      name: "nba_scores",
      label: "NBA比分/赛程",
      description: `查询NBA比赛比分和赛程（ESPN数据）。
返回今天/指定日期的比赛结果或赛程。

使用场景：
- "今天NBA有什么比赛"
- "昨天NBA比分"
- "湖人今天赢了吗"`,
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "日期 YYYYMMDD 格式。默认=今天" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          let url = `${ESPN_BASE}/apis/site/v2/sports/basketball/nba/scoreboard`;
          if (params.date) url += `?dates=${params.date}`;

          const res = await httpGet(url);
          if (res.status !== 200) return { error: `ESPN HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const events = data.events || [];
          if (events.length === 0) return { league: "NBA", matches: [], message: "该日期暂无比赛" };

          const matches = events.map((e: any) => {
            const comp = (e.competitions || [])[0] || {};
            const teams = comp.competitors || [];
            const home = teams.find((t: any) => t.homeAway === "home") || teams[0] || {};
            const away = teams.find((t: any) => t.homeAway === "away") || teams[1] || {};
            const status = comp.status?.type;
            const result: any = {
              away_team: `${away.team?.displayName || "?"} (${away.team?.abbreviation || ""})`,
              home_team: `${home.team?.displayName || "?"} (${home.team?.abbreviation || ""})`,
              score: `${away.score || 0} - ${home.score || 0}`,
              status: status?.description || status?.name || "",
              date: e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "",
            };
            // Quarter scores
            if (home.linescores && home.linescores.length > 0) {
              result.quarters = {
                away: home.linescores ? away.linescores?.map((q: any) => q.value) : [],
                home: home.linescores?.map((q: any) => q.value) || [],
              };
            }
            // Leaders
            const leaders = comp.leaders || [];
            if (leaders.length > 0) {
              result.leaders = leaders.slice(0, 3).map((l: any) => {
                const top = l.leaders?.[0];
                return top ? {
                  category: l.displayName || l.name,
                  player: top.athlete?.displayName || "?",
                  team: top.team?.abbreviation || "",
                  value: top.displayValue || "",
                } : null;
              }).filter(Boolean);
            }
            return result;
          });

          return { league: "NBA", match_count: matches.length, matches };
        } catch (err) {
          return { error: `NBA比分查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- NBA Standings ---- */
    api.registerTool({
      name: "nba_standings",
      label: "NBA积分榜",
      description: `查询NBA赛季积分榜/排名（ESPN数据）。
按东/西部分区显示球队胜负、胜率、排名。

使用场景：
- "NBA东部排名"
- "NBA西部积分榜"
- "NBA季后赛种子排名"`,
      parameters: Type.Object({
        conference: Type.Optional(Type.String({ description: "分区筛选（east/west/东部/西部）。默认=全部" })),
        top: Type.Optional(Type.Number({ description: "只返回前N名（默认全部）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const url = `${ESPN_BASE}/apis/v2/sports/basketball/nba/standings`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `ESPN HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const confFilter = String(params.conference || "").toLowerCase();
          const wantEast = !confFilter || confFilter === "east" || confFilter === "东部" || confFilter === "东";
          const wantWest = !confFilter || confFilter === "west" || confFilter === "西部" || confFilter === "西";

          const conferences: any[] = [];
          for (const group of (data.children || [])) {
            const name = (group.name || "").toLowerCase();
            const isEast = name.includes("east");
            const isWest = name.includes("west");
            if ((isEast && !wantEast) || (isWest && !wantWest)) continue;

            const entries = (group.standings?.entries || []).map((e: any) => {
              const stats = e.stats || [];
              return {
                seed: Math.round(getStat(stats, "playoffSeed")),
                team: e.team?.displayName || "?",
                abbr: e.team?.abbreviation || "",
                wins: Math.round(getStat(stats, "wins")),
                losses: Math.round(getStat(stats, "losses")),
                win_pct: getStatDisplay(stats, "winPercent"),
                games_behind: getStatDisplay(stats, "gamesBehind"),
                streak: getStatDisplay(stats, "streak"),
                last10: getStatDisplay(stats, "record"),
              };
            });

            entries.sort((a: any, b: any) => a.seed - b.seed);
            const top = params.top ? Math.min(Number(params.top), entries.length) : entries.length;

            conferences.push({
              conference: group.name || "",
              teams: entries.slice(0, top),
            });
          }

          return { league: "NBA", conferences };
        } catch (err) {
          return { error: `NBA积分榜查询失败: ${String(err)}` };
        }
      },
    });

    /* ================================================================ */
    /*                         MLB TOOLS                                */
    /* ================================================================ */

    /* ---- MLB Scores ---- */
    api.registerTool({
      name: "mlb_scores",
      label: "MLB比分/赛程",
      description: `查询MLB棒球比分和赛程（ESPN数据）。
返回今天/指定日期的比赛结果或赛程。

使用场景：
- "今天MLB有什么比赛"
- "洋基今天赢了吗"
- "MLB昨天的比分"`,
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "日期 YYYYMMDD 格式。默认=今天" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          let url = `${ESPN_BASE}/apis/site/v2/sports/baseball/mlb/scoreboard`;
          if (params.date) url += `?dates=${params.date}`;

          const res = await httpGet(url);
          if (res.status !== 200) return { error: `ESPN HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const events = data.events || [];
          if (events.length === 0) return { league: "MLB", matches: [], message: "该日期暂无比赛" };

          const matches = events.map((e: any) => {
            const comp = (e.competitions || [])[0] || {};
            const teams = comp.competitors || [];
            const home = teams.find((t: any) => t.homeAway === "home") || teams[0] || {};
            const away = teams.find((t: any) => t.homeAway === "away") || teams[1] || {};
            const status = comp.status?.type;
            const result: any = {
              away_team: `${away.team?.displayName || "?"} (${away.team?.abbreviation || ""})`,
              home_team: `${home.team?.displayName || "?"} (${home.team?.abbreviation || ""})`,
              score: `${away.score || 0} - ${home.score || 0}`,
              status: status?.description || status?.name || "",
              date: e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "",
            };
            // Inning scores
            if (home.linescores && home.linescores.length > 0) {
              result.innings = {
                away: away.linescores?.map((q: any) => q.value) || [],
                home: home.linescores?.map((q: any) => q.value) || [],
              };
            }
            return result;
          });

          return { league: "MLB", match_count: matches.length, matches };
        } catch (err) {
          return { error: `MLB比分查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- MLB Standings (from MLB Stats API — more detailed) ---- */
    api.registerTool({
      name: "mlb_standings",
      label: "MLB积分榜",
      description: `查询MLB赛季排名/战绩（MLB官方Stats API）。
按美联/国联分区显示胜负、胜率、分差。

使用场景：
- "MLB排名"
- "美联东区排名"
- "道奇今年战绩怎么样"`,
      parameters: Type.Object({
        season: Type.Optional(Type.Number({ description: "赛季年份（默认当年）" })),
        league: Type.Optional(Type.String({ description: "联盟筛选（al/nl/美联/国联）。默认=全部" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const year = params.season || new Date().getFullYear();
          // leagueId: 103=AL, 104=NL
          const url = `${MLB_API}/api/v1/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason&hydrate=team`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `MLB Stats API HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const leagueFilter = String(params.league || "").toLowerCase();
          const wantAL = !leagueFilter || leagueFilter === "al" || leagueFilter === "美联" || leagueFilter === "american";
          const wantNL = !leagueFilter || leagueFilter === "nl" || leagueFilter === "国联" || leagueFilter === "national";

          const divisions: any[] = [];
          for (const record of (data.records || [])) {
            const leagueId = record.league?.id;
            if (leagueId === 103 && !wantAL) continue;
            if (leagueId === 104 && !wantNL) continue;

            const divName = record.division?.name || "Unknown Division";
            const leagueName = leagueId === 103 ? "美联 (AL)" : "国联 (NL)";

            const teams = (record.teamRecords || []).map((tr: any) => ({
              rank: tr.divisionRank || "",
              team: tr.team?.name || "?",
              wins: tr.wins || 0,
              losses: tr.losses || 0,
              win_pct: tr.winningPercentage || "",
              games_behind: tr.gamesBack || "-",
              streak: tr.streak?.streakCode || "",
              runs_scored: tr.runsScored || 0,
              runs_allowed: tr.runsAllowed || 0,
              run_diff: tr.runDifferential || 0,
              last10: tr.records?.splitRecords?.find((s: any) => s.type === "lastTen")?.wins
                ? `${tr.records.splitRecords.find((s: any) => s.type === "lastTen").wins}-${tr.records.splitRecords.find((s: any) => s.type === "lastTen").losses}`
                : "",
            }));

            divisions.push({ league: leagueName, division: divName, teams });
          }

          return { league: "MLB", season: year, divisions };
        } catch (err) {
          return { error: `MLB排名查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- MLB Player Stats (from MLB Stats API) ---- */
    api.registerTool({
      name: "mlb_player",
      label: "MLB球员数据",
      description: `查询MLB球员详细数据（MLB官方Stats API）。
先搜索球员，再返回本赛季/生涯数据。

使用场景：
- "大谷翔平今年数据"
- "查一下 Aaron Judge 的数据"
- "MLB球员搜索 Shohei Ohtani"`,
      parameters: Type.Object({
        name: Type.String({ description: "球员名（英文，如 Shohei Ohtani, Aaron Judge, Mike Trout）" }),
        season: Type.Optional(Type.Number({ description: "赛季（默认当年）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const playerName = String(params.name || "").trim();
        if (!playerName) return { error: "请提供球员名" };

        try {
          // Search player
          const searchUrl = `${MLB_API}/api/v1/people/search?names=${encodeURIComponent(playerName)}&hydrate=currentTeam`;
          const searchRes = await httpGet(searchUrl);
          if (searchRes.status !== 200) return { error: `MLB API HTTP ${searchRes.status}` };
          const searchData = JSON.parse(searchRes.data);

          const people = searchData.people || [];
          if (people.length === 0) return { error: `未找到球员 "${playerName}"` };

          const player = people[0];
          const playerId = player.id;
          const year = params.season || new Date().getFullYear();

          // Get stats
          const statsUrl = `${MLB_API}/api/v1/people/${playerId}?hydrate=stats(group=[hitting,pitching],type=[season,career],season=${year})`;
          const statsRes = await httpGet(statsUrl);

          const result: any = {
            name: player.fullName || player.nameFirstLast || playerName,
            position: player.primaryPosition?.name || player.primaryPosition?.abbreviation || "",
            team: player.currentTeam?.name || "",
            bats: player.batSide?.description || "",
            throws: player.pitchHand?.description || "",
            age: player.currentAge || "",
            birth_country: player.birthCountry || "",
          };

          if (statsRes.status === 200) {
            const statsData = JSON.parse(statsRes.data);
            const p = statsData.people?.[0];
            if (p?.stats) {
              for (const statGroup of p.stats) {
                const group = statGroup.group?.displayName || "";
                const type = statGroup.type?.displayName || "";
                const splits = statGroup.splits || [];
                if (splits.length === 0) continue;
                const s = splits[0].stat || {};
                const key = `${group}_${type}`.toLowerCase().replace(/\s+/g, "_");
                // Pick most important stats
                if (group === "hitting") {
                  result[key] = {
                    games: s.gamesPlayed, at_bats: s.atBats,
                    avg: s.avg, obp: s.obp, slg: s.slg, ops: s.ops,
                    hits: s.hits, home_runs: s.homeRuns, rbi: s.rbi,
                    runs: s.runs, stolen_bases: s.stolenBases,
                    strikeouts: s.strikeOuts, walks: s.baseOnBalls,
                  };
                } else if (group === "pitching") {
                  result[key] = {
                    games: s.gamesPlayed, wins: s.wins, losses: s.losses,
                    era: s.era, whip: s.whip, innings: s.inningsPitched,
                    strikeouts: s.strikeOuts, walks: s.baseOnBalls,
                    saves: s.saves, holds: s.holds,
                    hits_allowed: s.hits, home_runs_allowed: s.homeRuns,
                  };
                }
              }
            }
          }

          return result;
        } catch (err) {
          return { error: `MLB球员查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[nba-mlb] Registered nba_scores + nba_standings + mlb_scores + mlb_standings + mlb_player tools");
  },
};

export default plugin;
