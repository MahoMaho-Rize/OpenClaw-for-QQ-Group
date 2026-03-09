import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as zlib from "node:zlib";

/* ================================================================== */
/*  Ekispert (駅すぱあと) Plugin                                       */
/*  Japanese transit route search powered by Val Laboratory's API      */
/*  Covers all JR, private railways, subways, buses, shinkansen       */
/*  with real timetable data — far superior to GTFS for Japan          */
/* ================================================================== */

const API_BASE = "https://api.ekispert.jp/v1/json";
const REQUEST_TIMEOUT = 20_000;
const UA = "OpenClaw-Ekispert/1.0";

let API_KEY = "";

/* ---- helpers ---- */

function text(str: string) {
  return { content: [{ type: "text" as const, text: str }] };
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function fmtMin(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}时${m}分` : `${h}时`;
}

function fmtYen(yen: number | string): string {
  return `¥${Number(yen).toLocaleString()}`;
}

/** Extract HH:MM from ISO datetime like "2026-03-09T14:48:00+09:00" */
function fmtTime(dt: string): string {
  if (!dt) return "?";
  const m = dt.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : dt;
}

/* ---- HTTPS GET helper (IPv4-only, gzip support) ---- */

function httpsGet(
  url: string,
  timeout = REQUEST_TIMEOUT,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: 443,
        family: 4,
        timeout,
        headers: {
          "User-Agent": UA,
          "Accept-Encoding": "gzip, deflate",
          Accept: "application/json",
        },
      },
      (res) => {
        let stream: NodeJS.ReadableStream = res;
        const enc = res.headers["content-encoding"];
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            data: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout ${timeout}ms`));
    });
  });
}

/* ---- API call wrapper ---- */

async function ekispertGet(
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const qs = new URLSearchParams({ key: API_KEY, ...params });
  const url = `${API_BASE}${path}?${qs.toString()}`;
  const { status, data } = await httpsGet(url);
  if (status !== 200) {
    let msg = `Ekispert API HTTP ${status}`;
    try {
      const err = JSON.parse(data);
      if (err?.ResultSet?.Error?.Message) msg += `：${err.ResultSet.Error.Message}`;
    } catch {}
    throw new Error(msg);
  }
  const parsed = JSON.parse(data);
  // Check for API-level error (status 200 but error in body)
  if (parsed?.ResultSet?.Error) {
    throw new Error(`Ekispert API 错误：${parsed.ResultSet.Error.Message || JSON.stringify(parsed.ResultSet.Error)}`);
  }
  return parsed;
}

/* ================================================================== */
/*  Tool: ekispert_station — search stations by name                  */
/* ================================================================== */

async function handleStationSearch(params: Record<string, unknown>): Promise<string> {
  const name = String(params.name || "");
  if (!name) return "错误：请提供车站名关键词。";

  const reqParams: Record<string, string> = { name };
  if (params.type) reqParams.type = String(params.type);

  const res = await ekispertGet("/station/light", reqParams);
  const stations = asArray(res?.ResultSet?.Point);

  if (stations.length === 0) return `未找到与「${name}」匹配的车站。`;

  const limit = Number(params.limit) || 10;
  const items = stations.slice(0, limit).map((pt: any) => {
    const s = pt.Station;
    const parts: string[] = [];
    parts.push(`🚉 ${s.Name}`);
    if (s.Yomi) parts.push(`（${s.Yomi}）`);

    const details: string[] = [];
    if (s.Type) {
      const typeLabels: Record<string, string> = {
        train: "铁路", plane: "航空", ship: "船舶", bus: "巴士",
      };
      details.push(typeLabels[s.Type] || s.Type);
    }
    const pref = pt.Prefecture || s.Prefecture;
    if (pref?.Name) details.push(pref.Name);
    if (details.length > 0) parts.push(`[${details.join("・")}]`);

    return parts.join(" ");
  });

  let result = `「${name}」的车站搜索结果（${stations.length}个）：\n\n`;
  result += items.join("\n");

  if (stations.length > limit) {
    result += `\n\n（仅显示前${limit}个，共${stations.length}个结果）`;
  }

  result += "\n\n数据来源：駅すぱあと (Ekispert)";
  return result;
}

/* ================================================================== */
/*  Tool: ekispert_route — route/course search                        */
/* ================================================================== */

async function handleRouteSearch(params: Record<string, unknown>): Promise<string> {
  const from = String(params.from || "");
  const to = String(params.to || "");
  if (!from || !to) return "错误：请提供出发站和到达站。";

  // Build viaList: from:via1:via2:...:to
  let viaList = from;
  if (params.via) viaList += `:${String(params.via)}`;
  viaList += `:${to}`;

  const reqParams: Record<string, string> = {
    viaList,
    answerCount: String(Math.min(Number(params.count) || 3, 20)),
  };

  if (params.date) reqParams.date = String(params.date);
  if (params.time) reqParams.time = String(params.time);
  if (params.searchType) reqParams.searchType = String(params.searchType);
  if (params.sort) reqParams.sort = String(params.sort);

  const res = await ekispertGet("/search/course/extreme", reqParams);
  const courses = asArray(res?.ResultSet?.Course);

  if (courses.length === 0) {
    return `未找到从「${from}」到「${to}」的路线。请确认站名是否正确（可先用 ekispert_station 搜索确认）。`;
  }

  const results: string[] = [];

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const route = course.Route;
    const lines: string[] = [];

    lines.push(`━━ 方案${i + 1} ━━`);

    // Time info — direct string values on Route
    const totalMin = Number(route?.timeOther) || 0;
    const boardMin = Number(route?.timeOnBoard) || 0;
    const walkMin = Number(route?.timeWalk) || 0;
    const transfers = Number(route?.transferCount) ?? 0;

    const summaryParts: string[] = [];
    if (totalMin > 0 || boardMin > 0) {
      const total = totalMin > 0 ? totalMin : boardMin + walkMin;
      summaryParts.push(`总计${fmtMin(total)}`);
    }
    if (boardMin > 0) summaryParts.push(`乘车${fmtMin(boardMin)}`);
    if (walkMin > 0) summaryParts.push(`步行${fmtMin(walkMin)}`);
    summaryParts.push(`换乘${transfers}次`);
    lines.push(summaryParts.join(" / "));

    // Price info — Oneway is a direct string value
    const prices = asArray(course.Price);
    const priceParts: string[] = [];
    for (const p of prices) {
      const kind = p.kind;
      const yen = p.Oneway;
      if (!yen) continue;
      if (kind === "FareSummary") priceParts.push(`车费${fmtYen(yen)}`);
      else if (kind === "ChargeSummary") priceParts.push(`特急费${fmtYen(yen)}`);
      else if (kind === "Teiki1Summary") priceParts.push(`1月定期${fmtYen(yen)}`);
      else if (kind === "Teiki3Summary") priceParts.push(`3月定期${fmtYen(yen)}`);
      else if (kind === "Teiki6Summary") priceParts.push(`6月定期${fmtYen(yen)}`);
    }
    if (priceParts.length > 0) lines.push(`💰 ${priceParts.join(" / ")}`);

    // Route legs: Line[i] connects Point[i] → Point[i+1]
    // Departure/arrival times are on Line, not on Point
    const routeLines = asArray(route?.Line);
    const points = asArray(route?.Point);

    for (let j = 0; j < routeLines.length; j++) {
      const line = routeLines[j];
      const fromPt = points[j];
      const toPt = points[j + 1];

      const fromName = fromPt?.Station?.Name || "?";
      const toName = toPt?.Station?.Name || "?";

      // Times are on Line.DepartureState/ArrivalState
      const depDt = line?.DepartureState?.Datetime?.text || "";
      const arrDt = line?.ArrivalState?.Datetime?.text || "";
      const depStr = depDt ? fmtTime(depDt) : "";
      const arrStr = arrDt ? fmtTime(arrDt) : "";

      const lineName = line.Name || "?";
      const dest = line.Destination ? `（${line.Destination}方面）` : "";

      // Track/platform info
      const depPlatform = line?.DepartureState?.no ? `${line.DepartureState.no}番线` : "";
      const arrPlatform = line?.ArrivalState?.no ? `${line.ArrivalState.no}番线` : "";

      lines.push(`  🚃 ${lineName}${dest}`);

      let legStr = "     ";
      if (depStr) legStr += `${depStr}发`;
      legStr += ` ${fromName}`;
      if (depPlatform) legStr += `(${depPlatform})`;
      legStr += ` → `;
      if (arrStr) legStr += `${arrStr}着`;
      legStr += ` ${toName}`;
      if (arrPlatform) legStr += `(${arrPlatform})`;
      lines.push(legStr);
    }

    results.push(lines.join("\n"));
  }

  let output = `🚅 ${from} → ${to} 路线查询\n\n`;
  output += results.join("\n\n");
  output += "\n\n数据来源：駅すぱあと (Ekispert)";
  return output;
}

/* ================================================================== */
/*  Tool: ekispert_disruption — train service disruption info         */
/* ================================================================== */

async function handleDisruption(params: Record<string, unknown>): Promise<string> {
  let res: any;
  try {
    res = await ekispertGet(
      "/operationLine/service/rescuenow/information",
      {},
    );
  } catch (e: any) {
    if (e.message?.includes("403") || e.message?.includes("401") || e.message?.includes("E904")) {
      return "运行情报功能需要正式API密钥，当前试用密钥不支持此功能。";
    }
    throw e;
  }

  const infos = asArray(res?.ResultSet?.Information);

  if (infos.length === 0) return "当前无运行异常情报。所有线路运行正常。\n\n数据来源：駅すぱあと (Ekispert)";

  const areaFilter = params.area ? String(params.area).toLowerCase() : "";

  const items: string[] = [];
  for (const info of infos) {
    const lineName = info.LineName || info.Line?.Name || "未知线路";
    const status = info.Status || info.StatusText || "";
    const cause = info.Cause || "";
    const detail = info.Detail || info.Text || "";
    const dateStr = info.Date || "";
    const area = info.AreaName || info.Area?.Name || "";

    if (areaFilter && !lineName.toLowerCase().includes(areaFilter) && !area.toLowerCase().includes(areaFilter)) {
      continue;
    }

    const parts: string[] = [];
    parts.push(`⚠️ ${lineName}`);
    if (area) parts.push(`[${area}]`);
    if (status) parts.push(`状态：${status}`);
    if (cause) parts.push(`原因：${cause}`);
    if (detail) parts.push(detail);
    if (dateStr) parts.push(`时间：${dateStr}`);
    items.push(parts.join("\n"));
  }

  if (items.length === 0) {
    if (areaFilter) return `「${params.area}」区域当前无运行异常情报。\n\n数据来源：駅すぱあと (Ekispert)`;
    return "当前无运行异常情报。所有线路运行正常。\n\n数据来源：駅すぱあと (Ekispert)";
  }

  let result = `🚨 列车运行异常情报（${items.length}条）\n\n`;
  result += items.join("\n\n");
  result += "\n\n数据来源：駅すぱあと (Ekispert)";
  return result;
}

/* ================================================================== */
/*  Plugin export                                                      */
/* ================================================================== */

export default {
  id: "ekispert",
  name: "Ekispert (駅すぱあと)",
  description: "Japanese transit route search — stations, routes, fares, timetables",
  register(api: OpenClawPluginApi) {
    API_KEY = String(
      api.pluginConfig?.apiKey || process.env.EKISPERT_API_KEY || "",
    );
    if (!API_KEY) {
      console.warn(
        "[ekispert] WARNING: No API key configured. Set plugins.entries.ekispert.config.apiKey in openclaw.json or EKISPERT_API_KEY env var.",
      );
    }

    console.log("[ekispert] Registering Ekispert tools...");

    // ── Tool 1: Station Search ──
    api.registerTool({
      name: "ekispert_station",
      label: "日本车站搜索",
      description:
        "搜索日本车站名称（铁路、地铁、巴士等）。用于确认站名或获取精确站名后再查路线。支持日文汉字、假名、罗马字搜索。",
      parameters: Type.Object({
        name: Type.String({
          description: "车站名关键词（日文汉字、假名或罗马字均可，如「新宿」「しんじゅく」「Shinjuku」）",
        }),
        type: Type.Optional(
          Type.String({
            description:
              "车站类型过滤：train（铁路）、bus（巴士）、plane（航空）、ship（船舶）",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "返回结果数上限，默认10",
          }),
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          return text(await handleStationSearch(params));
        } catch (e: any) {
          return text(`车站搜索失败：${e.message}`);
        }
      },
    });

    // ── Tool 2: Route Search ──
    api.registerTool({
      name: "ekispert_route",
      label: "日本铁路路线查询",
      description:
        "查询日本铁路/地铁/巴士路线（含时刻表、票价、换乘方案）。覆盖JR全线、私铁、地铁、新干线、巴士。比GTFS数据更准确。如果不确定站名，请先用 ekispert_station 搜索确认。",
      parameters: Type.Object({
        from: Type.String({
          description: "出发站名（日文，如「新宿」「東京」）",
        }),
        to: Type.String({
          description: "到达站名（日文，如「池袋」「大阪」）",
        }),
        via: Type.Optional(
          Type.String({
            description:
              "途经站（多个用冒号分隔，如「横浜:名古屋」）",
          }),
        ),
        date: Type.Optional(
          Type.String({
            description: "出发/到达日期，格式YYYYMMDD（如20260310）",
          }),
        ),
        time: Type.Optional(
          Type.String({
            description: "出发/到达时间，格式HHMM（如0930表示9:30）",
          }),
        ),
        searchType: Type.Optional(
          Type.String({
            description:
              "搜索类型：departure（出发时间，默认）、arrival（到达时间）、firstTrain（始发）、lastTrain（末班）",
          }),
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "排序方式：time（耗时最短）、price（最便宜）、transfer（最少换乘）、ekispert（综合推荐）",
          }),
        ),
        count: Type.Optional(
          Type.Number({
            description: "返回方案数，默认3，最多20",
          }),
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          return text(await handleRouteSearch(params));
        } catch (e: any) {
          return text(`路线查询失败：${e.message}`);
        }
      },
    });

    // ── Tool 3: Disruption Info ──
    api.registerTool({
      name: "ekispert_disruption",
      label: "日本铁路运行情报",
      description:
        "查询日本铁路运行异常情报（延误、停运、事故等）。可按区域或线路名过滤。注意：此功能可能需要正式API密钥。",
      parameters: Type.Object({
        area: Type.Optional(
          Type.String({
            description:
              "按区域或线路名过滤（如「東京」「中央線」），留空返回全部",
          }),
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          return text(await handleDisruption(params));
        } catch (e: any) {
          return text(`运行情报查询失败：${e.message}`);
        }
      },
    });

    console.log("[ekispert] Registered 3 tools: ekispert_station, ekispert_route, ekispert_disruption");
  },
};
