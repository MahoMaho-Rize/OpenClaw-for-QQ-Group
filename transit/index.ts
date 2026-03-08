import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Transit Plugin — Transitous (MOTIS 2) Global Public Transport      */
/*  Geocode stations, plan journeys, get departure boards              */
/*  Free, no API key, global coverage including Japan/Europe/etc.      */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 20_000;
const USER_AGENT = "OpenClaw-Bot/1.0 (https://github.com/anomalyco/opencode; contact@openclaw.ai)";
const API_BASE = "https://api.transitous.org";

/* ---- HTTP helper (IPv4-only) ---- */

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

/* ---- Mode Chinese labels ---- */
const MODE_LABELS: Record<string, string> = {
  WALK: "步行", BIKE: "骑行", CAR: "驾车", RENTAL: "租车/共享单车",
  TRAM: "有轨电车", SUBWAY: "地铁", BUS: "公交", COACH: "长途客车",
  FERRY: "渡轮", AIRPLANE: "飞机", FUNICULAR: "缆索铁路", AERIAL_LIFT: "空中缆车",
  HIGHSPEED_RAIL: "高铁", LONG_DISTANCE: "长途火车", NIGHT_RAIL: "夜行列车",
  REGIONAL_FAST_RAIL: "快速区间车", REGIONAL_RAIL: "区间火车", SUBURBAN: "城铁/通勤铁路",
  RAIL: "铁路", TRANSIT: "公共交通", OTHER: "其他",
};
function modeLabel(mode: string): string { return MODE_LABELS[mode] || mode; }

/* ---- Format duration ---- */
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}分钟`;
  return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
}

/* ---- Format time (extract HH:MM from ISO) ---- */
function fmtTime(iso: string): string {
  if (!iso) return "?";
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : iso;
}

/* ---- Well-known city coordinates for geocoding fallback ---- */
const CITY_COORDS: Record<string, [number, number]> = {
  "东京": [35.6812, 139.6671], "新宿": [35.6896, 139.7006], "涩谷": [35.6580, 139.7016],
  "池袋": [35.7295, 139.7109], "秋叶原": [35.6984, 139.7731], "品川": [35.6285, 139.7388],
  "上野": [35.7141, 139.7774], "银座": [35.6717, 139.7649],
  "大阪": [34.7025, 135.4959], "梅田": [34.7005, 135.4963], "难波": [34.6628, 135.5016],
  "京都": [35.0116, 135.7681], "札幌": [43.0687, 141.3508], "名古屋": [35.1709, 136.8815],
  "福冈": [33.5902, 130.4017], "横滨": [35.4437, 139.6380], "神户": [34.6901, 135.1956],
  "广岛": [34.3853, 132.4553], "仙台": [38.2601, 140.8823],
  "北京": [39.9042, 116.4074], "上海": [31.2304, 121.4737], "广州": [23.1291, 113.2644],
  "深圳": [22.5431, 114.0579], "香港": [22.3193, 114.1694], "台北": [25.0330, 121.5654],
  "首尔": [37.5665, 126.9780], "釜山": [35.1796, 129.0756],
  "巴黎": [48.8566, 2.3522], "伦敦": [51.5074, -0.1278], "柏林": [52.5200, 13.4050],
  "慕尼黑": [48.1351, 11.5820], "维也纳": [48.2082, 16.3738], "罗马": [41.9028, 12.4964],
  "苏黎世": [47.3769, 8.5417], "阿姆斯特丹": [52.3676, 4.9041],
  "纽约": [40.7128, -74.0060], "旧金山": [37.7749, -122.4194],
  "新加坡": [1.3521, 103.8198], "曼谷": [13.7563, 100.5018],
};

/* ---- Format a transit Leg into a compact summary ---- */
function formatLeg(leg: any, idx: number): any {
  const base: any = {
    step: idx + 1,
    mode: modeLabel(leg.mode),
    from: leg.from?.name || "?",
    to: leg.to?.name || "?",
    depart: fmtTime(leg.startTime),
    arrive: fmtTime(leg.endTime),
    duration: fmtDuration(leg.duration),
  };
  // Transit-specific fields
  if (leg.routeShortName || leg.displayName) {
    base.line = leg.displayName || leg.routeShortName || leg.routeLongName || "";
  }
  if (leg.headsign) base.headsign = leg.headsign;
  if (leg.track || leg.from?.track) base.platform = leg.track || leg.from?.track || "";
  if (leg.from?.scheduledTrack) base.scheduled_platform = leg.from.scheduledTrack;
  if (leg.agencyName) base.operator = leg.agencyName;
  if (leg.intermediateStops && leg.intermediateStops.length > 0) {
    base.stops_count = leg.intermediateStops.length;
  }
  // Delay info
  if (leg.realTime) {
    const depDelay = diffSeconds(leg.scheduledStartTime, leg.startTime);
    const arrDelay = diffSeconds(leg.scheduledEndTime, leg.endTime);
    if (depDelay !== 0) base.departure_delay = `${depDelay > 0 ? "+" : ""}${depDelay}分钟`;
    if (arrDelay !== 0) base.arrival_delay = `${arrDelay > 0 ? "+" : ""}${arrDelay}分钟`;
  }
  if (leg.cancelled) base.cancelled = true;
  return base;
}

function diffSeconds(scheduled: string, actual: string): number {
  if (!scheduled || !actual) return 0;
  try {
    return Math.round((new Date(actual).getTime() - new Date(scheduled).getTime()) / 60000);
  } catch { return 0; }
}

/* ==================================================================== */

const plugin = {
  id: "transit",
  name: "Transit & Railway",
  description: "全球公共交通查询 — 线路规划、车站搜索、发车时刻表（Transitous/MOTIS）",

  register(api: OpenClawPluginApi) {

    /* ================================================================ */
    /* Tool 1: transit_search — search for stations/stops by name       */
    /* ================================================================ */
    api.registerTool({
      name: "transit_search",
      label: "车站搜索",
      description: `搜索全球公共交通车站/站点（Transitous，覆盖日本、欧洲、北美等）。
输入车站名称，返回匹配的站点及其ID、坐标、可用交通方式。

使用场景：
- "东京站在哪"
- "搜索新宿站"
- "巴黎有哪些地铁站"
- 为 transit_route / transit_departures 获取 stopId`,
      parameters: Type.Object({
        query: Type.String({ description: "车站/地点名称（支持日文/英文/本地语言，如 Tokyo, 新宿, Shinjuku, Paris Gare du Nord）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = String(params.query || "").trim();
        if (!query) return { error: "请提供搜索关键词" };
        try {
          const url = `${API_BASE}/api/v1/geocode?text=${encodeURIComponent(query)}`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `Transitous HTTP ${res.status}: ${res.data.slice(0, 200)}` };
          const matches = JSON.parse(res.data);

          if (!Array.isArray(matches) || matches.length === 0) {
            return { query, results: [], message: "未找到匹配的站点。建议使用英文或当地语言搜索。" };
          }

          // Return top 10 results, prefer STOP type
          const results = matches.slice(0, 10).map((m: any) => {
            const r: any = {
              name: m.name,
              type: m.type,
              id: m.id,
              lat: m.lat,
              lon: m.lon,
            };
            if (m.country) r.country = m.country;
            if (m.tz) r.timezone = m.tz;
            if (m.areas && m.areas.length > 0) {
              r.area = m.areas.map((a: any) => a.name).join(", ");
            }
            if (m.modes && m.modes.length > 0) {
              r.modes = m.modes.map(modeLabel);
            }
            return r;
          });

          const stopCount = results.filter((r: any) => r.type === "STOP").length;
          return {
            query,
            total: matches.length,
            showing: results.length,
            stops_found: stopCount,
            results,
            tip: stopCount > 0 ? "使用 id 字段可以在 transit_route 和 transit_departures 中精确指定车站" : undefined,
          };
        } catch (err) {
          return { error: `车站搜索失败: ${String(err)}` };
        }
      },
    });

    /* ================================================================ */
    /* Tool 2: transit_route — plan a journey between two places        */
    /* ================================================================ */
    api.registerTool({
      name: "transit_route",
      label: "公交路线规划",
      description: `规划全球公共交通出行路线（Transitous，MOTIS路由引擎）。
支持火车、地铁、公交、城铁等所有公共交通方式。
覆盖日本（JR/私铁/地铁）、欧洲（DB/SNCF/Trenitalia等）、北美等。

输入出发地和目的地（车站名/stopId/坐标），返回最优换乘方案。

使用场景：
- "从东京到大阪怎么坐车"
- "新宿到涩谷的地铁路线"
- "巴黎北站到里昂的火车"
- "从成田机场怎么到新宿"`,
      parameters: Type.Object({
        from: Type.String({ description: "出发地（车站名/stopId/\"纬度,经度\"格式）" }),
        to: Type.String({ description: "目的地（车站名/stopId/\"纬度,经度\"格式）" }),
        time: Type.Optional(Type.String({ description: "出发/到达时间，ISO 8601格式（如 2026-03-08T14:00:00+09:00）。默认=现在" })),
        arrive_by: Type.Optional(Type.Boolean({ description: "true=按到达时间搜索，false=按出发时间搜索（默认false）" })),
        max_transfers: Type.Optional(Type.Number({ description: "最大换乘次数（默认不限）" })),
        modes: Type.Optional(Type.String({ description: "限制交通方式（逗号分隔，如 RAIL,SUBWAY,BUS）。默认=全部" })),
        num_results: Type.Optional(Type.Number({ description: "返回方案数（默认3，最大5）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        let fromPlace = String(params.from || "").trim();
        let toPlace = String(params.to || "").trim();
        if (!fromPlace || !toPlace) return { error: "请提供出发地和目的地" };

        // Resolve Chinese city names to coordinates as fallback for geocoding
        const resolvePlace = async (input: string): Promise<string> => {
          // Already a stopId (contains special chars like "de:" or "jp:")
          if (input.includes(":") || input.includes("_")) return input;
          // Already lat,lon format
          if (/^-?\d+\.?\d*,-?\d+\.?\d*/.test(input)) return input;
          // Known city → try geocoding with that name
          const coords = CITY_COORDS[input];
          // Use geocoding API to find best stop match
          try {
            const searchTerm = coords ? input : input;
            const geoUrl = `${API_BASE}/api/v1/geocode?text=${encodeURIComponent(searchTerm)}`;
            const geoRes = await httpGet(geoUrl, 10_000);
            if (geoRes.status === 200) {
              const matches = JSON.parse(geoRes.data);
              // Prefer STOP type matches
              const stop = matches.find((m: any) => m.type === "STOP") || matches[0];
              if (stop) {
                return stop.id || `${stop.lat},${stop.lon}`;
              }
            }
          } catch { /* fallback to coords */ }
          // Final fallback to known coordinates
          if (coords) return `${coords[0]},${coords[1]}`;
          return input;
        };

        try {
          fromPlace = await resolvePlace(fromPlace);
          toPlace = await resolvePlace(toPlace);

          const numResults = Math.min(Number(params.num_results) || 3, 5);
          let url = `${API_BASE}/api/v5/plan?fromPlace=${encodeURIComponent(fromPlace)}&toPlace=${encodeURIComponent(toPlace)}&numItineraries=${numResults}&maxItineraries=${numResults}`;

          if (params.time) url += `&time=${encodeURIComponent(String(params.time))}`;
          if (params.arrive_by) url += `&arriveBy=true`;
          if (params.max_transfers !== undefined) url += `&maxTransfers=${params.max_transfers}`;
          if (params.modes) url += `&transitModes=${encodeURIComponent(String(params.modes))}`;

          const res = await httpGet(url);
          if (res.status !== 200) {
            const errData = res.data.slice(0, 300);
            return { error: `Transitous 路线规划失败 (HTTP ${res.status}): ${errData}` };
          }

          const data = JSON.parse(res.data);
          const itineraries = data.itineraries || [];
          const direct = data.direct || [];

          if (itineraries.length === 0 && direct.length === 0) {
            return {
              from: data.from?.name || fromPlace,
              to: data.to?.name || toPlace,
              routes: [],
              message: "未找到公共交通路线。可能该区域未被Transitous覆盖，或两地之间无直达公共交通。",
            };
          }

          const routes = itineraries.map((itin: any, idx: number) => ({
            option: idx + 1,
            duration: fmtDuration(itin.duration),
            duration_seconds: itin.duration,
            depart: fmtTime(itin.startTime),
            arrive: fmtTime(itin.endTime),
            transfers: itin.transfers,
            legs: (itin.legs || []).map(formatLeg),
          }));

          // Add direct (walking/cycling) options if available
          const directRoutes = direct.slice(0, 1).map((d: any) => ({
            option: "直达(步行/骑行)",
            duration: fmtDuration(d.duration),
            duration_seconds: d.duration,
            legs: (d.legs || []).map(formatLeg),
          }));

          return {
            from: data.from?.name || fromPlace,
            to: data.to?.name || toPlace,
            routes,
            direct: directRoutes.length > 0 ? directRoutes : undefined,
          };
        } catch (err) {
          return { error: `路线规划失败: ${String(err)}` };
        }
      },
    });

    /* ================================================================ */
    /* Tool 3: transit_departures — departure board for a station       */
    /* ================================================================ */
    api.registerTool({
      name: "transit_departures",
      label: "发车时刻表",
      description: `查询车站发车/到站时刻表（Transitous）。
输入车站名或stopId，返回即将出发的列车/公交班次。

使用场景：
- "东京站接下来有什么车"
- "新宿站发车时刻表"
- "品川站出发的新干线"
- "巴黎北站发车信息"`,
      parameters: Type.Object({
        station: Type.String({ description: "车站名称或 stopId（建议先用 transit_search 获取精确 stopId）" }),
        count: Type.Optional(Type.Number({ description: "返回班次数（默认10，最大20）" })),
        time: Type.Optional(Type.String({ description: "查询时间，ISO 8601格式。默认=现在" })),
        modes: Type.Optional(Type.String({ description: "限制交通方式（如 HIGHSPEED_RAIL,LONG_DISTANCE 只看长途火车）" })),
        arrivals: Type.Optional(Type.Boolean({ description: "true=查到站信息，false=查出发信息（默认false）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const station = String(params.station || "").trim();
        if (!station) return { error: "请提供车站名称或stopId" };

        const count = Math.min(Number(params.count) || 10, 20);

        // Resolve station name to stopId
        let stopId = station;
        // If it doesn't look like a stopId, geocode it
        if (!station.includes(":") && !station.includes("_") && !/^\d+$/.test(station)) {
          try {
            const geoUrl = `${API_BASE}/api/v1/geocode?text=${encodeURIComponent(station)}`;
            const geoRes = await httpGet(geoUrl, 10_000);
            if (geoRes.status === 200) {
              const matches = JSON.parse(geoRes.data);
              const stop = matches.find((m: any) => m.type === "STOP");
              if (stop && stop.id) {
                stopId = stop.id;
              } else if (matches[0]?.id) {
                stopId = matches[0].id;
              } else {
                return { error: `未找到名为 "${station}" 的车站。建议用英文或当地语言搜索，或先用 transit_search 查找。` };
              }
            }
          } catch (err) {
            return { error: `车站搜索失败: ${String(err)}` };
          }
        }

        try {
          let url = `${API_BASE}/api/v5/stoptimes?stopId=${encodeURIComponent(stopId)}&n=${count}`;
          if (params.time) url += `&time=${encodeURIComponent(String(params.time))}`;
          if (params.arrivals) url += `&arriveBy=true&direction=EARLIER`;
          if (params.modes) url += `&mode=${encodeURIComponent(String(params.modes))}`;

          const res = await httpGet(url);
          if (res.status !== 200) {
            const errData = res.data.slice(0, 300);
            return { error: `时刻表查询失败 (HTTP ${res.status}): ${errData}` };
          }

          const data = JSON.parse(res.data);
          const place = data.place;
          const stopTimes = data.stopTimes || [];

          if (stopTimes.length === 0) {
            return {
              station: place?.name || station,
              stopId,
              departures: [],
              message: "当前无班次信息。可能已过末班车时间，或该站点数据未更新。",
            };
          }

          const departures = stopTimes.map((st: any) => {
            const leg = st.leg;
            if (!leg) return null;
            const dep: any = {
              time: fmtTime(params.arrivals ? leg.endTime : leg.startTime),
              scheduled: fmtTime(params.arrivals ? leg.scheduledEndTime : leg.scheduledStartTime),
              mode: modeLabel(leg.mode),
              line: leg.displayName || leg.routeShortName || leg.routeLongName || "",
              headsign: leg.headsign || leg.to?.name || "?",
              destination: leg.tripTo?.name || leg.to?.name || "",
            };
            // Platform/track info
            const fromPlace = params.arrivals ? leg.to : leg.from;
            if (fromPlace?.track) dep.platform = fromPlace.track;
            if (fromPlace?.scheduledTrack && fromPlace.scheduledTrack !== fromPlace.track) {
              dep.scheduled_platform = fromPlace.scheduledTrack;
            }
            if (leg.agencyName) dep.operator = leg.agencyName;
            // Delay detection
            if (leg.realTime) {
              const scheduled = params.arrivals ? leg.scheduledEndTime : leg.scheduledStartTime;
              const actual = params.arrivals ? leg.endTime : leg.startTime;
              const delay = diffSeconds(scheduled, actual);
              if (delay !== 0) dep.delay = `${delay > 0 ? "+" : ""}${delay}分钟`;
            }
            if (leg.cancelled) dep.cancelled = true;
            return dep;
          }).filter(Boolean);

          return {
            station: place?.name || station,
            stopId,
            timezone: place?.tz || "",
            type: params.arrivals ? "到达" : "出发",
            count: departures.length,
            departures,
          };
        } catch (err) {
          return { error: `时刻表查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[transit] Registered transit_search + transit_route + transit_departures tools");
  },
};

export default plugin;
