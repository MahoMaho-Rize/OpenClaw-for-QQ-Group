import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Weather & Earthquake Plugin                                        */
/*  Open-Meteo weather forecast + USGS earthquake data                 */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "OpenClaw-Bot/1.0";

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

/* ---- Common city → lat/lon mapping (no geocoding API needed) ---- */

const CITY_COORDS: Record<string, [number, number]> = {
  // China
  "北京": [39.90, 116.40], "上海": [31.23, 121.47], "广州": [23.13, 113.26],
  "深圳": [22.54, 114.06], "成都": [30.57, 104.07], "杭州": [30.27, 120.15],
  "南京": [32.06, 118.80], "武汉": [30.59, 114.31], "西安": [34.26, 108.94],
  "重庆": [29.56, 106.55], "天津": [39.13, 117.20], "苏州": [31.30, 120.62],
  "哈尔滨": [45.75, 126.65], "长春": [43.88, 125.32], "沈阳": [41.80, 123.43],
  "大连": [38.91, 121.60], "青岛": [36.07, 120.38], "厦门": [24.48, 118.09],
  "长沙": [28.23, 112.94], "郑州": [34.75, 113.65], "济南": [36.67, 116.98],
  "福州": [26.07, 119.30], "合肥": [31.82, 117.23], "昆明": [25.04, 102.68],
  "贵阳": [26.65, 106.63], "南宁": [22.82, 108.32], "太原": [37.87, 112.55],
  "石家庄": [38.04, 114.51], "呼和浩特": [40.84, 111.75], "兰州": [36.06, 103.83],
  "银川": [38.49, 106.23], "西宁": [36.62, 101.78], "乌鲁木齐": [43.83, 87.62],
  "拉萨": [29.65, 91.13], "海口": [20.04, 110.35], "台北": [25.03, 121.57],
  "香港": [22.32, 114.17], "澳门": [22.20, 113.55],
  // Japan
  "东京": [35.68, 139.69], "大阪": [34.69, 135.50], "京都": [35.01, 135.77],
  "札幌": [43.06, 141.35], "名古屋": [35.18, 136.91], "福冈": [33.59, 130.40],
  "横滨": [35.44, 139.64], "神户": [34.69, 135.20],
  // Korea
  "首尔": [37.57, 126.98], "釜山": [35.18, 129.08],
  // World
  "纽约": [40.71, -74.01], "洛杉矶": [34.05, -118.24], "伦敦": [51.51, -0.13],
  "巴黎": [48.86, 2.35], "柏林": [52.52, 13.41], "莫斯科": [55.76, 37.62],
  "悉尼": [-33.87, 151.21], "新加坡": [1.35, 103.82], "曼谷": [13.76, 100.50],
  "迪拜": [25.20, 55.27], "多伦多": [43.65, -79.38], "温哥华": [49.28, -123.12],
};

/* WMO weather code → Chinese description */
function wmoCodeToText(code: number): string {
  const map: Record<number, string> = {
    0: "晴", 1: "大部晴", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇", 51: "小毛毛雨", 53: "中毛毛雨", 55: "大毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻小雨", 67: "冻大雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "阵雨(小)", 81: "阵雨(中)", 82: "阵雨(大)",
    85: "阵雪(小)", 86: "阵雪(大)",
    95: "雷暴", 96: "雷暴+小冰雹", 99: "雷暴+大冰雹",
  };
  return map[code] || `天气代码${code}`;
}

const plugin = {
  id: "weather",
  name: "Weather & Earthquake",
  description: "天气预报 + 地震查询",

  register(api: OpenClawPluginApi) {
    /* ---- weather_forecast ---- */
    api.registerTool({
      name: "weather_forecast",
      label: "天气预报",
      description: `查询全球天气预报（Open-Meteo，无需API Key）。
支持中文城市名（内置 ~60 个常用城市）或直接传经纬度。
返回当前天气 + 未来7天预报。

使用场景：
- "北京天气怎么样"
- "东京明天会下雨吗"
- "哈尔滨这周天气"`,
      parameters: Type.Object({
        city: Type.Optional(Type.String({ description: "城市名（中文，如 北京、东京、纽约）" })),
        latitude: Type.Optional(Type.Number({ description: "纬度（直接指定坐标时用）" })),
        longitude: Type.Optional(Type.Number({ description: "经度（直接指定坐标时用）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        let lat: number | undefined, lon: number | undefined;
        const city = params.city as string | undefined;

        if (city && CITY_COORDS[city]) {
          [lat, lon] = CITY_COORDS[city];
        } else if (city) {
          // Try partial match
          const match = Object.entries(CITY_COORDS).find(([k]) => k.includes(city) || city.includes(k));
          if (match) [lat, lon] = match[1];
        }
        if (params.latitude !== undefined) lat = Number(params.latitude);
        if (params.longitude !== undefined) lon = Number(params.longitude);

        if (lat === undefined || lon === undefined) {
          return { error: `未找到城市 "${city}" 的坐标。支持的城市：${Object.keys(CITY_COORDS).join("、")}。或直接传 latitude + longitude。` };
        }

        try {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=7`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `Open-Meteo HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const current = data.current;
          const daily = data.daily;
          const tz = data.timezone || "Unknown";

          const forecast = daily.time.map((date: string, i: number) => ({
            date,
            weather: wmoCodeToText(daily.weather_code[i]),
            temp_max: `${daily.temperature_2m_max[i]}°C`,
            temp_min: `${daily.temperature_2m_min[i]}°C`,
            precipitation: `${daily.precipitation_sum[i]}mm`,
            rain_prob: `${daily.precipitation_probability_max[i]}%`,
            wind_max: `${daily.wind_speed_10m_max[i]}km/h`,
          }));

          return {
            location: city || `${lat},${lon}`,
            timezone: tz,
            current: {
              temperature: `${current.temperature_2m}°C`,
              feels_like: `${current.apparent_temperature}°C`,
              humidity: `${current.relative_humidity_2m}%`,
              weather: wmoCodeToText(current.weather_code),
              wind: `${current.wind_speed_10m}km/h`,
            },
            forecast_7day: forecast,
          };
        } catch (err) {
          return { error: `天气查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- earthquake_recent ---- */
    api.registerTool({
      name: "earthquake_recent",
      label: "地震查询",
      description: `查询全球最近地震（USGS 美国地质调查局）。
可按最小震级、时间范围、区域筛选。

使用场景：
- "最近有地震吗"
- "日本最近的地震"
- "查一下5级以上的地震"`,
      parameters: Type.Object({
        min_magnitude: Type.Optional(Type.Number({ description: "最小震级（默认4.0）" })),
        days: Type.Optional(Type.Number({ description: "过去多少天内（默认7，最大30）" })),
        limit: Type.Optional(Type.Number({ description: "返回条数（默认10，最大50）" })),
        latitude: Type.Optional(Type.Number({ description: "筛选中心纬度" })),
        longitude: Type.Optional(Type.Number({ description: "筛选中心经度" })),
        max_radius_km: Type.Optional(Type.Number({ description: "筛选半径km（需配合lat/lon）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const minMag = Number(params.min_magnitude) || 4.0;
        const days = Math.min(Number(params.days) || 7, 30);
        const limit = Math.min(Number(params.limit) || 10, 50);

        const end = new Date();
        const start = new Date(end.getTime() - days * 86400000);
        const startStr = start.toISOString().split("T")[0];
        const endStr = end.toISOString().split("T")[0];

        let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startStr}&endtime=${endStr}&minmagnitude=${minMag}&limit=${limit}&orderby=time`;

        if (params.latitude !== undefined && params.longitude !== undefined) {
          const rad = Number(params.max_radius_km) || 500;
          url += `&latitude=${params.latitude}&longitude=${params.longitude}&maxradiuskm=${rad}`;
        }

        try {
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `USGS HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const quakes = (data.features || []).map((f: any) => ({
            magnitude: f.properties.mag,
            location: f.properties.place,
            time: new Date(f.properties.time).toISOString(),
            depth_km: f.geometry?.coordinates?.[2],
            tsunami_alert: f.properties.tsunami === 1,
            url: f.properties.url,
          }));

          return {
            query: { min_magnitude: minMag, days, limit },
            total_found: data.metadata?.count || quakes.length,
            earthquakes: quakes,
          };
        } catch (err) {
          return { error: `地震查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[weather] Registered weather_forecast + earthquake_recent tools");
  },
};

export default plugin;
