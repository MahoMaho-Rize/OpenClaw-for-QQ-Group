import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Sports Plugin                                                      */
/*  F1 + Chess.com + Lichess                                           */
/* ------------------------------------------------------------------ */

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

const plugin = {
  id: "sports",
  name: "Sports & Gaming",
  description: "F1赛事数据 + Chess.com棋手数据 + Lichess棋手数据",

  register(api: OpenClawPluginApi) {
    /* ---- f1_results ---- */
    api.registerTool({
      name: "f1_results",
      label: "F1赛事查询",
      description: `查询F1一级方程式赛车数据。
支持获取最近一场比赛的结果或当前赛季车手积分榜。

使用场景：
- "F1最近一场比赛谁赢了"
- "F1赛季积分榜"`,
      parameters: Type.Object({
        type: Type.Optional(Type.String({ description: "查询类型：latest_race（最近比赛结果）或 standings（赛季积分榜），默认 latest_race" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const queryType = (params.type as string) || "latest_race";
        try {
          if (queryType === "standings") {
            const url = "https://api.jolpi.ca/ergast/f1/current/driverStandings.json";
            const resp = await httpGet(url);
            if (resp.status !== 200) return { error: `API 请求失败，状态码: ${resp.status}` };
            const body = JSON.parse(resp.data);
            const standingsList = body?.MRData?.StandingsTable?.StandingsLists?.[0];
            if (!standingsList) return { error: "未获取到积分榜数据" };
            const standings = (standingsList.DriverStandings ?? []).map((s: any) => ({
              position: s.position,
              driver: `${s.Driver?.givenName} ${s.Driver?.familyName}`,
              constructor: s.Constructors?.[0]?.name ?? "N/A",
              points: s.points,
              wins: s.wins,
            }));
            return { season: standingsList.season, standings };
          }

          // latest_race
          const url = "https://api.jolpi.ca/ergast/f1/current/last/results.json";
          const resp = await httpGet(url);
          if (resp.status !== 200) return { error: `API 请求失败，状态码: ${resp.status}` };
          const body = JSON.parse(resp.data);
          const race = body?.MRData?.RaceTable?.Races?.[0];
          if (!race) return { error: "未获取到比赛数据" };
          const results = (race.Results ?? []).slice(0, 10).map((r: any) => ({
            position: r.position,
            driver: `${r.Driver?.givenName} ${r.Driver?.familyName}`,
            constructor: r.Constructor?.name ?? "N/A",
            time: r.Time?.time ?? r.status ?? "N/A",
            points: r.points,
            fastest_lap: r.FastestLap ? { rank: r.FastestLap.rank, time: r.FastestLap.Time?.time ?? "N/A" } : null,
          }));
          return {
            race_name: race.raceName,
            circuit: race.Circuit?.circuitName ?? "N/A",
            date: race.date,
            location: race.Circuit?.Location ? `${race.Circuit.Location.locality}, ${race.Circuit.Location.country}` : "N/A",
            results,
          };
        } catch (err) {
          return { error: `F1查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- chess_com_player ---- */
    api.registerTool({
      name: "chess_com_player",
      label: "Chess.com棋手查询",
      description: `查询 Chess.com 国际象棋平台的棋手统计数据。
包括各类型对局的等级分和胜负记录。

使用场景：
- "查一下Chess.com上hikaru的数据"
- "chess.com用户名xxx的等级分"`,
      parameters: Type.Object({
        username: Type.String({ description: "Chess.com 用户名" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const username = params.username as string;
        if (!username) return { error: "缺少必填参数: username" };
        const lowerUser = username.toLowerCase();
        try {
          const [statsResp, profileResp] = await Promise.all([
            httpGet(`https://api.chess.com/pub/player/${lowerUser}/stats`),
            httpGet(`https://api.chess.com/pub/player/${lowerUser}`),
          ]);
          if (statsResp.status !== 200) return { error: `获取棋手统计失败，状态码: ${statsResp.status}` };
          if (profileResp.status !== 200) return { error: `获取棋手资料失败，状态码: ${profileResp.status}` };
          const stats = JSON.parse(statsResp.data);
          const profile = JSON.parse(profileResp.data);
          const extractRating = (key: string) => {
            const section = stats[key];
            if (!section) return null;
            return {
              rating: section.last?.rating ?? null,
              wins: section.record?.win ?? 0,
              losses: section.record?.loss ?? 0,
              draws: section.record?.draw ?? 0,
            };
          };
          return {
            username: profile.username ?? lowerUser,
            name: profile.name ?? null,
            country: profile.country ?? null,
            joined_date: profile.joined ? new Date(profile.joined * 1000).toISOString() : null,
            last_online: profile.last_online ? new Date(profile.last_online * 1000).toISOString() : null,
            ratings: {
              chess_rapid: extractRating("chess_rapid"),
              chess_blitz: extractRating("chess_blitz"),
              chess_bullet: extractRating("chess_bullet"),
              chess_daily: extractRating("chess_daily"),
            },
          };
        } catch (err) {
          return { error: `Chess.com查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- lichess_player ---- */
    api.registerTool({
      name: "lichess_player",
      label: "Lichess棋手查询",
      description: `查询 Lichess 国际象棋平台的棋手统计数据。
包括各类型对局的等级分和对局数量。

使用场景：
- "查一下Lichess上DrNykterstein的数据"
- "Lichess用户xxx的rating"`,
      parameters: Type.Object({
        username: Type.String({ description: "Lichess 用户名" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const username = params.username as string;
        if (!username) return { error: "缺少必填参数: username" };
        try {
          const resp = await httpGet(`https://lichess.org/api/user/${username}`);
          if (resp.status !== 200) return { error: `获取 Lichess 棋手数据失败，状态码: ${resp.status}` };
          const data = JSON.parse(resp.data);
          const extractPerf = (key: string) => {
            const perf = data.perfs?.[key];
            if (!perf) return null;
            return { rating: perf.rating ?? null, games: perf.games ?? 0 };
          };
          return {
            username: data.username ?? username,
            title: data.title ?? null,
            created_at: data.createdAt ? new Date(data.createdAt).toISOString() : null,
            profile: { bio: data.profile?.bio ?? null, country: data.profile?.country ?? null },
            play_time: { total: data.playTime?.total ?? null },
            ratings: {
              bullet: extractPerf("bullet"),
              blitz: extractPerf("blitz"),
              rapid: extractPerf("rapid"),
              classical: extractPerf("classical"),
              puzzle: extractPerf("puzzle"),
            },
          };
        } catch (err) {
          return { error: `Lichess查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[sports] Registered f1_results + chess_com_player + lichess_player tools");
  },
};

export default plugin;
