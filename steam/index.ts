import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Steam Plugin                                                        */
/*  Steam store API — game details + search                             */
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
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      },
      (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGet(res.headers.location, timeout).then(resolve).catch(reject);
          return;
        }
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

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

const plugin = {
  id: "steam",
  name: "Steam",
  description: "Steam 游戏查询",

  register(api: OpenClawPluginApi) {
    /* ---- steam_game ---- */
    api.registerTool({
      name: "steam_game",
      label: "Steam游戏详情",
      description: `通过 Steam AppID 查询游戏详情（价格、评分、简介、配置要求等）。
如果不知道 AppID，先用 steam_search 搜索。

使用场景：
- "CS2 Steam多少钱"（先搜索获取 appid，再查详情）
- "查一下 Steam 上这个游戏"`,
      parameters: Type.Object({
        appid: Type.Number({ description: "Steam AppID（如 730 是 CS2）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const appid = Number(params.appid);
        if (!appid) return { error: "需要提供 appid" };

        try {
          const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=cn&l=schinese`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `Steam HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const entry = data[String(appid)];
          if (!entry?.success) return { error: "未找到该游戏" };
          const d = entry.data;

          return {
            name: d.name,
            appid,
            type: d.type,
            is_free: d.is_free,
            price: d.price_overview ? {
              currency: d.price_overview.currency,
              initial: d.price_overview.initial_formatted || undefined,
              final: d.price_overview.final_formatted,
              discount_percent: d.price_overview.discount_percent || 0,
            } : (d.is_free ? "免费" : "价格未知"),
            short_description: stripHtml(d.short_description || ""),
            developers: d.developers,
            publishers: d.publishers,
            genres: d.genres?.map((g: any) => g.description),
            release_date: d.release_date?.date,
            coming_soon: d.release_date?.coming_soon,
            metacritic: d.metacritic?.score,
            platforms: {
              windows: d.platforms?.windows,
              mac: d.platforms?.mac,
              linux: d.platforms?.linux,
            },
            categories: d.categories?.map((c: any) => c.description)?.slice(0, 8),
            header_image: d.header_image,
            website: d.website,
            steam_url: `https://store.steampowered.com/app/${appid}`,
          };
        } catch (err) {
          return { error: `Steam 查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- steam_search ---- */
    api.registerTool({
      name: "steam_search",
      label: "Steam游戏搜索",
      description: `在 Steam 商店搜索游戏。返回匹配的游戏列表及 appid。

使用场景：
- "Steam上搜一下艾尔登法环"
- "有没有叫 Celeste 的游戏"`,
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        count: Type.Optional(Type.Number({ description: "返回数量（默认5）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = String(params.query || "").trim();
        if (!query) return { error: "需要提供 query" };
        const count = Math.min(Number(params.count) || 5, 20);

        try {
          // Use Steam search suggestions API
          const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=schinese&cc=cn`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `Steam HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const items = (data.items || []).slice(0, count).map((item: any) => ({
            name: item.name,
            appid: item.id,
            price: item.price ? {
              final: item.price.final ? `¥${(item.price.final / 100).toFixed(2)}` : "免费",
              discount: item.price.discount_percent ? `${item.price.discount_percent}% off` : undefined,
            } : "价格未知",
            platforms: {
              windows: item.platforms?.windows,
              mac: item.platforms?.mac,
              linux: item.platforms?.linux,
            },
            img: item.tiny_image,
            steam_url: `https://store.steampowered.com/app/${item.id}`,
          }));

          return {
            query,
            result_count: items.length,
            results: items,
            hint: "使用 steam_game 工具传入 appid 可查看详细信息。",
          };
        } catch (err) {
          return { error: `Steam 搜索失败: ${String(err)}` };
        }
      },
    });

    console.log("[steam] Registered steam_game + steam_search tools");
  },
};

export default plugin;
