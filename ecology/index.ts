import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Ecology & Nature Plugin                                            */
/*  GBIF biodiversity + Smithsonian Volcano                            */
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
  id: "ecology",
  name: "Ecology & Nature",
  description: "GBIF全球生物多样性数据 + 史密森尼全球火山数据",

  register(api: OpenClawPluginApi) {
    /* ---- gbif_species_search ---- */
    api.registerTool({
      name: "gbif_species_search",
      label: "GBIF生物搜索",
      description: `搜索GBIF全球生物多样性数据库。
支持按物种名称搜索分类信息，或查询物种出现记录（采集地点、时间等）。
可使用英文名、拉丁学名或中文俗名进行检索。

使用场景：
- "查一下大熊猫的分类信息"
- "Ailuropoda melanoleuca的分布记录"`,
      parameters: Type.Object({
        query: Type.String({ description: "物种名称（英文名、拉丁学名或中文俗名）" }),
        type: Type.Optional(Type.String({ description: "搜索类型：species（物种分类信息）或 occurrence（出现记录），默认 species" })),
        limit: Type.Optional(Type.Number({ description: "返回结果数量，默认5，最大20" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = params.query as string;
        if (!query) return { error: "缺少必填参数: query" };
        const type = (params.type as string) || "species";
        const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);
        const encodedQuery = encodeURIComponent(query);

        try {
          if (type === "occurrence") {
            const url = `https://api.gbif.org/v1/occurrence/search?scientificName=${encodedQuery}&limit=${limit}`;
            const { status, data } = await httpGet(url);
            if (status !== 200) return { error: `GBIF occurrence API 返回状态码 ${status}` };
            const json = JSON.parse(data);
            const occurrences = (json.results ?? []).map((r: any) => ({
              species: r.species ?? r.scientificName ?? null,
              country: r.country ?? null,
              eventDate: r.eventDate ?? null,
              decimalLatitude: r.decimalLatitude ?? null,
              decimalLongitude: r.decimalLongitude ?? null,
              basisOfRecord: r.basisOfRecord ?? null,
              institutionCode: r.institutionCode ?? null,
              datasetName: r.datasetName ?? null,
            }));
            return { count: json.count ?? occurrences.length, data: occurrences };
          }

          // Default: species search
          const url = `https://api.gbif.org/v1/species/search?q=${encodedQuery}&limit=${limit}`;
          const { status, data } = await httpGet(url);
          if (status !== 200) return { error: `GBIF species API 返回状态码 ${status}` };
          const json = JSON.parse(data);
          const species = (json.results ?? []).map((r: any) => ({
            key: r.key ?? null,
            scientificName: r.scientificName ?? null,
            canonicalName: r.canonicalName ?? null,
            kingdom: r.kingdom ?? null,
            phylum: r.phylum ?? null,
            class: r.class ?? null,
            order: r.order ?? null,
            family: r.family ?? null,
            genus: r.genus ?? null,
            taxonomicStatus: r.taxonomicStatus ?? null,
            rank: r.rank ?? null,
          }));
          return { count: json.count ?? species.length, data: species };
        } catch (err) {
          return { error: `GBIF查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- volcano_search ---- */
    api.registerTool({
      name: "volcano_search",
      label: "火山数据查询",
      description: `搜索史密森尼全球火山计划（GVP）数据库。
可按火山名称搜索，或获取最近活跃的火山列表。
返回火山名称、所在国家、经纬度、海拔、类型、最近喷发年份等信息。

使用场景：
- "查一下富士山的火山数据"
- "最近有哪些火山活跃"`,
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "火山名称（英文），支持模糊匹配" })),
        recent: Type.Optional(Type.Boolean({ description: "是否获取最近活跃的火山，默认 false" })),
        limit: Type.Optional(Type.Number({ description: "返回结果数量，默认5，最大20" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = params.query as string | undefined;
        const recent = params.recent as boolean | undefined;
        const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);

        const BASE = "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows" +
          "?service=WFS&version=2.0.0&request=GetFeature" +
          "&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes" +
          "&outputFormat=application/json";

        try {
          let url: string;
          if (query && query.trim().length > 0 && !recent) {
            const cqlFilter = `Volcano_Name LIKE '%${query.trim()}%'`;
            url = `${BASE}&CQL_FILTER=${encodeURIComponent(cqlFilter)}&maxFeatures=${limit}`;
          } else {
            url = `${BASE}&maxFeatures=${limit}&sortBy=${encodeURIComponent("Last_Eruption_Year D")}`;
          }

          const { status, data } = await httpGet(url);
          if (status !== 200) return { error: `史密森尼火山 API 返回状态码 ${status}` };
          const json = JSON.parse(data);
          const features = json.features ?? [];
          const volcanoes = features.map((f: any) => {
            const p = f.properties ?? {};
            const geom = f.geometry?.coordinates ?? [null, null];
            return {
              name: p.Volcano_Name ?? null,
              country: p.Country ?? null,
              region: p.Subregion ?? p.Region ?? null,
              latitude: geom[1] ?? p.Latitude ?? null,
              longitude: geom[0] ?? p.Longitude ?? null,
              elevation_m: p.Elev ?? null,
              type: p.Primary_Volcano_Type ?? null,
              last_eruption_year: p.Last_Eruption_Year ?? null,
              rock_type: p.Major_Rock_Type ?? p.Dominant_Rock_Type ?? null,
            };
          });
          return { count: volcanoes.length, data: volcanoes };
        } catch (err) {
          return { error: `火山查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[ecology] Registered gbif_species_search + volcano_search tools");
  },
};

export default plugin;
