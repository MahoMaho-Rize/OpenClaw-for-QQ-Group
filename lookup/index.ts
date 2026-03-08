import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Lookup Tools Plugin                                                */
/*  OpenFoodFacts + NHTSA VIN + OpenSky + adsbdb                       */
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
  id: "lookup",
  name: "Lookup Tools",
  description: "食品条码查询 + 汽车VIN解码 + 实时航班查询 + 飞机注册号查询",

  register(api: OpenClawPluginApi) {
    /* ---- food_lookup ---- */
    api.registerTool({
      name: "food_lookup",
      label: "食品条码查询",
      description: `通过条形码查询食品信息（营养成分、配料、品牌等），数据来自 OpenFoodFacts 开放数据库。

使用场景：
- "帮我查一下条形码3017620422003是什么食品"
- "这个条码的营养成分是什么"`,
      parameters: Type.Object({
        barcode: Type.String({ description: "商品条形码，例如 \"3017620422003\"（Nutella）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const barcode = params.barcode as string;
        if (!barcode) return { error: "缺少必填参数: barcode" };
        try {
          const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `OpenFoodFacts 返回 HTTP ${res.status}` };
          const json = JSON.parse(res.data);
          if (json.status !== 1 || !json.product) return { error: "未找到该条码对应的商品" };
          const p = json.product;
          const n = p.nutriments ?? {};
          return {
            product_name: p.product_name ?? null,
            brands: p.brands ?? null,
            categories: p.categories ?? null,
            nutriscore_grade: p.nutriscore_grade ?? null,
            ingredients_text: p.ingredients_text ?? null,
            nutriments: {
              energy_kcal: n["energy-kcal_100g"] ?? n["energy-kcal"] ?? null,
              fat: n.fat_100g ?? n.fat ?? null,
              sugars: n.sugars_100g ?? n.sugars ?? null,
              proteins: n.proteins_100g ?? n.proteins ?? null,
              salt: n.salt_100g ?? n.salt ?? null,
            },
            image_url: p.image_url ?? null,
            countries: p.countries ?? null,
          };
        } catch (err) {
          return { error: `食品查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- vin_decode ---- */
    api.registerTool({
      name: "vin_decode",
      label: "汽车VIN解码",
      description: `通过17位VIN码（车辆识别号）解码汽车详细信息。
包括品牌、型号、发动机、变速箱等，数据来自美国NHTSA数据库。

使用场景：
- "帮我解码这个VIN: 1HGBH41JXMN109186"
- "查一下这辆车的信息"`,
      parameters: Type.Object({
        vin: Type.String({ description: "17位车辆识别号（VIN），例如 \"1HGBH41JXMN109186\"" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const vin = params.vin as string;
        if (!vin) return { error: "缺少必填参数: vin" };
        try {
          const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${encodeURIComponent(vin)}?format=json`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `NHTSA 返回 HTTP ${res.status}` };
          const json = JSON.parse(res.data);
          const results: { Variable: string; Value: string | null }[] = json.Results ?? [];
          const wanted = new Set([
            "Make", "Model", "Model Year", "Body Class", "Drive Type",
            "Fuel Type - Primary", "Displacement (L)", "Engine Number of Cylinders",
            "Transmission Style", "Plant City", "Plant Country",
            "Vehicle Type", "Gross Vehicle Weight Rating From",
          ]);
          const keyMap: Record<string, string> = {
            "Make": "Make", "Model": "Model", "Model Year": "ModelYear",
            "Body Class": "BodyClass", "Drive Type": "DriveType",
            "Fuel Type - Primary": "FuelTypePrimary", "Displacement (L)": "EngineDisplacement",
            "Engine Number of Cylinders": "EngineCylinders", "Transmission Style": "TransmissionStyle",
            "Plant City": "PlantCity", "Plant Country": "PlantCountry",
            "Vehicle Type": "VehicleType", "Gross Vehicle Weight Rating From": "GVWR",
          };
          const out: Record<string, string> = {};
          for (const r of results) {
            if (wanted.has(r.Variable) && r.Value && r.Value.trim() !== "") {
              const key = keyMap[r.Variable] ?? r.Variable;
              out[key] = r.Value.trim();
            }
          }
          if (Object.keys(out).length === 0) return { error: "VIN 解码未返回有效数据，请检查VIN是否正确" };
          return { vin: vin.toUpperCase(), ...out };
        } catch (err) {
          return { error: `VIN解码失败: ${String(err)}` };
        }
      },
    });

    /* ---- flight_tracker ---- */
    api.registerTool({
      name: "flight_tracker",
      label: "实时航班查询",
      description: `实时查询航班位置信息，数据来自 OpenSky Network。
支持按ICAO24地址、呼号或地理区域（经纬度边界框）查询。

使用场景：
- "查一下CCA981航班在哪"
- "上海附近有什么航班"`,
      parameters: Type.Object({
        icao24: Type.Optional(Type.String({ description: "ICAO24 十六进制地址，例如 \"a0b1c2\"" })),
        callsign: Type.Optional(Type.String({ description: "航班呼号，例如 \"CCA981\" 或 \"UAL123\"" })),
        bbox_lat1: Type.Optional(Type.Number({ description: "边界框最小纬度（南）" })),
        bbox_lon1: Type.Optional(Type.Number({ description: "边界框最小经度（西）" })),
        bbox_lat2: Type.Optional(Type.Number({ description: "边界框最大纬度（北）" })),
        bbox_lon2: Type.Optional(Type.Number({ description: "边界框最大经度（东）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const icao24 = params.icao24 as string | undefined;
        const callsign = params.callsign as string | undefined;
        const bbox_lat1 = params.bbox_lat1 as number | undefined;
        const bbox_lon1 = params.bbox_lon1 as number | undefined;
        const bbox_lat2 = params.bbox_lat2 as number | undefined;
        const bbox_lon2 = params.bbox_lon2 as number | undefined;
        const OPENSKY_TIMEOUT = 20_000;
        try {
          let url: string;
          const hasBbox = bbox_lat1 !== undefined && bbox_lon1 !== undefined && bbox_lat2 !== undefined && bbox_lon2 !== undefined;
          if (icao24) {
            url = `https://opensky-network.org/api/states/all?icao24=${encodeURIComponent(icao24.toLowerCase())}`;
          } else if (hasBbox) {
            url = `https://opensky-network.org/api/states/all?lamin=${bbox_lat1}&lomin=${bbox_lon1}&lamax=${bbox_lat2}&lomax=${bbox_lon2}`;
          } else if (callsign) {
            url = `https://opensky-network.org/api/states/all`;
          } else {
            return { error: "请至少提供 icao24、callsign 或完整的边界框参数" };
          }
          const res = await httpGet(url, OPENSKY_TIMEOUT);
          if (res.status !== 200) return { error: `OpenSky 返回 HTTP ${res.status}` };
          const json = JSON.parse(res.data);
          let states: any[] = json.states ?? [];
          if (callsign && !icao24) {
            const needle = callsign.trim().toUpperCase();
            states = states.filter((s: any[]) => {
              const cs = (s[1] ?? "").toString().trim().toUpperCase();
              return cs === needle || cs.startsWith(needle);
            });
          }
          states = states.slice(0, 20);
          if (states.length === 0) return { flights: [], message: "未找到匹配的航班" };
          const flights = states.map((s: any[]) => ({
            icao24: s[0] ?? null,
            callsign: (s[1] ?? "").toString().trim() || null,
            origin_country: s[2] ?? null,
            lat: s[6] ?? null,
            lon: s[5] ?? null,
            altitude_m: s[7] ?? s[13] ?? null,
            velocity_kmh: s[9] != null ? Math.round(s[9] * 3.6) : null,
            heading: s[10] ?? null,
            vertical_rate: s[11] ?? null,
          }));
          return { time: json.time ?? null, flights };
        } catch (err) {
          return { error: `航班查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- aircraft_lookup ---- */
    api.registerTool({
      name: "aircraft_lookup",
      label: "飞机注册号查询",
      description: `通过飞机注册号查询飞机详细信息（机型、制造商、所有者等），数据来自 adsbdb 数据库。

使用场景：
- "查一下注册号N12345是什么飞机"
- "B-1234是谁的飞机"`,
      parameters: Type.Object({
        registration: Type.String({ description: "飞机注册号，例如 \"N12345\" 或 \"B-1234\"" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const registration = params.registration as string;
        if (!registration) return { error: "缺少必填参数: registration" };
        try {
          const url = `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(registration.toUpperCase())}`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `adsbdb 返回 HTTP ${res.status}` };
          const json = JSON.parse(res.data);
          const ac = json.response?.aircraft;
          if (!ac) return { error: "未找到该注册号对应的飞机信息" };
          return {
            type: ac.type ?? null,
            icao_type: ac.icao_type ?? null,
            manufacturer: ac.manufacturer ?? null,
            owner: ac.registered_owner ?? ac.owner ?? null,
            registered_owner_country: ac.registered_owner_country_name ?? ac.registered_owner_country_iso_name ?? null,
            url: ac.url ?? null,
          };
        } catch (err) {
          return { error: `飞机查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[lookup] Registered food_lookup + vin_decode + flight_tracker + aircraft_lookup tools");
  },
};

export default plugin;
