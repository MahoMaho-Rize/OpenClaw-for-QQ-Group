import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// HTTP helper (IPv4-only, gzip/deflate, 15 s timeout)
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
// Plugin
// ---------------------------------------------------------------------------

const plugin = {
  id: "space",
  name: "Space & Astronomy",
  description: "NASA每日天文图 + ISS国际空间站位置 + SpaceX发射记录",

  register(api: OpenClawPluginApi) {
    // -----------------------------------------------------------------------
    // Tool 1: nasa_apod — NASA 每日天文图片
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "nasa_apod",
      description: "获取NASA每日天文图片（Astronomy Picture of the Day）。返回标题、说明、图片链接等信息。",
      parameters: Type.Object({
        date: Type.Optional(
          Type.String({ description: "查询日期，格式 YYYY-MM-DD，默认为今天" })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const date = params.date as string | undefined;
          let url = "https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY";
          if (date) {
            url += `&date=${date}`;
          }

          const resp = await httpGet(url);
          if (resp.status !== 200) {
            return `NASA APOD API 返回状态码 ${resp.status}: ${resp.data.slice(0, 200)}`;
          }

          const data = JSON.parse(resp.data);
          const lines = [
            `标题: ${data.title ?? "无"}`,
            `日期: ${data.date ?? "无"}`,
            `类型: ${data.media_type ?? "无"}`,
            data.copyright ? `版权: ${data.copyright}` : null,
            `链接: ${data.url ?? "无"}`,
            `说明: ${data.explanation ?? "无"}`,
          ].filter(Boolean);
          return lines.join("\n");
        } catch (err: any) {
          return `获取NASA每日天文图片失败: ${err.message}`;
        }
      },
    });

    // -----------------------------------------------------------------------
    // Tool 2: iss_position — 国际空间站实时位置
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "iss_position",
      description: "获取国际空间站（ISS）的实时位置，包括经纬度、海拔高度、速度和可见性。",
      parameters: Type.Object({}),
      execute: async (_id: string, _params: Record<string, unknown>) => {
        try {
          const resp = await httpGet("https://api.wheretheiss.at/v1/satellites/25544");
          if (resp.status !== 200) {
            return `ISS API 返回状态码 ${resp.status}: ${resp.data.slice(0, 200)}`;
          }

          const data = JSON.parse(resp.data);
          const lines = [
            `纬度: ${data.latitude ?? "-"}`,
            `经度: ${data.longitude ?? "-"}`,
            `海拔: ${data.altitude != null ? data.altitude.toFixed(1) + " km" : "-"}`,
            `速度: ${data.velocity != null ? data.velocity.toFixed(1) + " km/h" : "-"}`,
            `可见性: ${data.visibility ?? "-"}`,
            `时间戳: ${data.timestamp ?? "-"}`,
          ];
          return lines.join("\n");
        } catch (err: any) {
          return `获取ISS位置失败: ${err.message}`;
        }
      },
    });

    // -----------------------------------------------------------------------
    // Tool 3: spacex_launches — SpaceX 发射记录
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "spacex_launches",
      description:
        "查询SpaceX发射数据。支持查询最近一次发射、即将到来的发射或历史发射记录。",
      parameters: Type.Object({
        type: Type.Optional(
          Type.String({
            description: "查询类型：latest（最近一次）、upcoming（即将发射）、past（历史记录），默认 latest",
          })
        ),
        limit: Type.Optional(
          Type.Number({
            description: "返回数量（仅对 upcoming/past 有效），默认 5，最大 10",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const queryType = (params.type as string) ?? "latest";
          const count = Math.min(Math.max((params.limit as number) ?? 5, 1), 10);
          const baseUrl = "https://api.spacexdata.com/v4/launches";

          const formatLaunch = (l: any, i?: number) => {
            const prefix = i != null ? `${i + 1}. ` : "";
            const lines = [
              `${prefix}任务: ${l.name ?? "未知"}`,
              `  时间(UTC): ${l.date_utc ?? "未知"}`,
              `  成功: ${l.success != null ? (l.success ? "是" : "否") : "未知"}`,
              l.details ? `  详情: ${l.details.slice(0, 200)}` : null,
              l.links?.webcast ? `  直播: ${l.links.webcast}` : null,
            ].filter(Boolean);
            return lines.join("\n");
          };

          if (queryType === "latest") {
            const resp = await httpGet(`${baseUrl}/latest`);
            if (resp.status !== 200) {
              return `SpaceX API 返回状态码 ${resp.status}`;
            }
            const data = JSON.parse(resp.data);
            return `SpaceX 最近一次发射:\n${formatLaunch(data)}`;
          }

          if (queryType === "upcoming") {
            const resp = await httpGet(`${baseUrl}/upcoming`);
            if (resp.status !== 200) {
              return `SpaceX API 返回状态码 ${resp.status}`;
            }
            const data: any[] = JSON.parse(resp.data);
            const items = data.slice(0, count);
            return `SpaceX 即将发射 (共${data.length}个, 显示${items.length}个):\n${items.map((l, i) => formatLaunch(l, i)).join("\n\n")}`;
          }

          // past
          const resp = await httpGet(`${baseUrl}/past`);
          if (resp.status !== 200) {
            return `SpaceX API 返回状态码 ${resp.status}`;
          }
          const data: any[] = JSON.parse(resp.data);
          const items = data.slice(-count).reverse();
          return `SpaceX 历史发射 (共${data.length}次, 显示最近${items.length}次):\n${items.map((l, i) => formatLaunch(l, i)).join("\n\n")}`;
        } catch (err: any) {
          return `获取SpaceX发射数据失败: ${err.message}`;
        }
      },
    });
  },
};

export default plugin;
