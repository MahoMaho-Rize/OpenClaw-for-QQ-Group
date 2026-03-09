import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";
import * as net from "node:net";
import * as tls from "node:tls";

/* ------------------------------------------------------------------ */
/*  Commodities & Futures Plugin                                       */
/*  Global futures, precious metals, energy, agriculture via Yahoo     */
/*  Finance + Metals.dev API                                           */
/* ------------------------------------------------------------------ */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 20_000;

/* ---- SOCKS5 proxy helper (for WARP tunnel) ---- */

function socks5HttpsGet(
  proxyHost: string, proxyPort: number,
  targetHost: string, targetPort: number,
  path: string, headers: Record<string, string> = {},
  timeout = 15000
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let step = 0;
    sock.on("data", (data) => {
      if (step === 0) {
        if (data[0] !== 0x05 || data[1] !== 0x00) return reject(new Error("SOCKS5 auth failed"));
        step = 1;
        const buf = Buffer.alloc(7 + targetHost.length);
        buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x03;
        buf[4] = targetHost.length;
        buf.write(targetHost, 5);
        buf.writeUInt16BE(targetPort, 5 + targetHost.length);
        sock.write(buf);
      } else if (step === 1) {
        if (data[0] !== 0x05 || data[1] !== 0x00) return reject(new Error("SOCKS5 connect failed"));
        const tlsSock = tls.connect({ socket: sock, servername: targetHost }, () => {
          const req = https.get({
            hostname: targetHost, path,
            createConnection: () => tlsSock,
            headers: { "User-Agent": USER_AGENT, ...headers },
            timeout,
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
          });
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
        });
        tlsSock.on("error", reject);
      }
    });
    sock.on("error", reject);
    sock.setTimeout(timeout, () => { sock.destroy(); reject(new Error("SOCKS5 timeout")); });
  });
}

/* ---- HTTP helper ---- */

interface HttpResponse {
  status: number;
  data: string;
  url: string;
}

function httpGet(
  url: string,
  opts: { timeout?: number; maxRedirects?: number } = {}
): Promise<HttpResponse> {
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  const maxRedirects = opts.maxRedirects ?? 5;

  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function doRequest(currentUrl: string) {
      const u = new URL(currentUrl);
      const isHttps = u.protocol === "https:";
      const mod = isHttps ? https : http;

      const req = mod.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: u.port || (isHttps ? 443 : 80),
          family: 4,
          timeout,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (++redirectCount > maxRedirects) {
              reject(new Error(`Too many redirects (>${maxRedirects})`));
              return;
            }
            const next = new URL(res.headers.location, currentUrl).href;
            res.resume();
            doRequest(next);
            return;
          }

          let stream: NodeJS.ReadableStream = res;
          const encoding = res.headers["content-encoding"];
          if (encoding === "gzip") {
            stream = res.pipe(zlib.createGunzip());
          } else if (encoding === "deflate") {
            stream = res.pipe(zlib.createInflate());
          }

          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              data: Buffer.concat(chunks).toString("utf8"),
              url: currentUrl,
            });
          });
          stream.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timeout (${timeout}ms)`));
      });
    }

    doRequest(url);
  });
}

/* ---- Helpers ---- */

function formatPrice(n: number | undefined | null, decimals = 2): string {
  if (n == null || isNaN(n)) return "N/A";
  return n.toFixed(decimals);
}

function formatPercent(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "N/A";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatNumber(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "N/A";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

/* ---- Commodity symbol mappings ---- */

// Category → { displayName: yahooSymbol }
const COMMODITY_CATEGORIES: Record<
  string,
  Record<string, { symbol: string; unit: string }>
> = {
  贵金属: {
    黄金: { symbol: "GC=F", unit: "美元/盎司" },
    白银: { symbol: "SI=F", unit: "美元/盎司" },
    铂金: { symbol: "PL=F", unit: "美元/盎司" },
    钯金: { symbol: "PA=F", unit: "美元/盎司" },
    铜: { symbol: "HG=F", unit: "美元/磅" },
  },
  能源: {
    "WTI原油": { symbol: "CL=F", unit: "美元/桶" },
    "布伦特原油": { symbol: "BZ=F", unit: "美元/桶" },
    天然气: { symbol: "NG=F", unit: "美元/百万BTU" },
    汽油: { symbol: "RB=F", unit: "美元/加仑" },
    取暖油: { symbol: "HO=F", unit: "美元/加仑" },
  },
  农产品: {
    玉米: { symbol: "ZC=F", unit: "美分/蒲式耳" },
    大豆: { symbol: "ZS=F", unit: "美分/蒲式耳" },
    小麦: { symbol: "ZW=F", unit: "美分/蒲式耳" },
    棉花: { symbol: "CT=F", unit: "美分/磅" },
    咖啡: { symbol: "KC=F", unit: "美分/磅" },
    可可: { symbol: "CC=F", unit: "美元/吨" },
    糖: { symbol: "SB=F", unit: "美分/磅" },
    活牛: { symbol: "LE=F", unit: "美分/磅" },
    瘦猪: { symbol: "HE=F", unit: "美分/磅" },
    木材: { symbol: "LBS=F", unit: "美元/千板英尺" },
  },
};

// Chinese alias → Yahoo symbol
const ALIAS_MAP: Record<string, string> = {};
for (const [_cat, items] of Object.entries(COMMODITY_CATEGORIES)) {
  for (const [name, info] of Object.entries(items)) {
    ALIAS_MAP[name] = info.symbol;
    ALIAS_MAP[name.toLowerCase()] = info.symbol;
  }
}
// Extra aliases
Object.assign(ALIAS_MAP, {
  gold: "GC=F", "金": "GC=F", "金价": "GC=F",
  silver: "SI=F", "银": "SI=F", "银价": "SI=F",
  platinum: "PL=F", palladium: "PA=F",
  copper: "HG=F", "铜价": "HG=F",
  oil: "CL=F", "原油": "CL=F", "石油": "CL=F", "油价": "CL=F",
  crude: "CL=F", "wti": "CL=F",
  brent: "BZ=F", "布油": "BZ=F", "北海布伦特": "BZ=F",
  "天然气价格": "NG=F", gas: "NG=F", natgas: "NG=F",
  corn: "ZC=F", soybean: "ZS=F", "大豆价格": "ZS=F",
  wheat: "ZW=F", "小麦价格": "ZW=F",
  cotton: "CT=F", coffee: "KC=F", cocoa: "CC=F", sugar: "SB=F",
  "猪肉": "HE=F", "牛肉": "LE=F",
});

function resolveSymbol(input: string): string {
  const trimmed = input.trim();
  if (ALIAS_MAP[trimmed]) return ALIAS_MAP[trimmed];
  if (ALIAS_MAP[trimmed.toLowerCase()]) return ALIAS_MAP[trimmed.toLowerCase()];
  // Already a Yahoo symbol (contains =F)
  if (trimmed.includes("=F") || trimmed.includes("=f"))
    return trimmed.toUpperCase();
  return trimmed.toUpperCase();
}

/* ---- Yahoo Finance quote fetcher (with SOCKS5 fallback for rate-limited IPs) ---- */

async function fetchQuotes(symbols: string[]): Promise<any[]> {
  const symStr = symbols.join(",");
  const YAHOO_HOST = "query2.finance.yahoo.com";

  // Try direct v7 first
  const url = `https://${YAHOO_HOST}/v7/finance/quote?symbols=${symStr}`;
  const res = await httpGet(url, { timeout: REQUEST_TIMEOUT });

  if (res.status === 200) {
    const data = JSON.parse(res.data);
    return data?.quoteResponse?.result || data?.finance?.result?.[0]?.quotes || [];
  }

  // Try direct v6 fallback
  const url6 = `https://${YAHOO_HOST}/v6/finance/quote?symbols=${symStr}`;
  const res6 = await httpGet(url6, { timeout: REQUEST_TIMEOUT });

  if (res6.status === 200) {
    const data6 = JSON.parse(res6.data);
    return data6?.quoteResponse?.result || [];
  }

  // Both failed (likely 429 rate-limit) — fallback through WARP SOCKS5 proxy
  console.log(`[commodities] direct quote failed (v7=${res.status}, v6=${res6.status}), trying SOCKS5 proxy...`);

  try {
    const proxyRes = await socks5HttpsGet(
      "127.0.0.1", 40000,
      YAHOO_HOST, 443,
      `/v7/finance/quote?symbols=${symStr}`,
      { Accept: "application/json" }
    );
    if (proxyRes.status === 200) {
      const data = JSON.parse(proxyRes.data);
      return data?.quoteResponse?.result || data?.finance?.result?.[0]?.quotes || [];
    }

    // Try v6 through proxy
    const proxyRes6 = await socks5HttpsGet(
      "127.0.0.1", 40000,
      YAHOO_HOST, 443,
      `/v6/finance/quote?symbols=${symStr}`,
      { Accept: "application/json" }
    );
    if (proxyRes6.status === 200) {
      const data6 = JSON.parse(proxyRes6.data);
      return data6?.quoteResponse?.result || [];
    }

    throw new Error(`Yahoo Finance 返回 HTTP ${proxyRes.status} (via proxy)`);
  } catch (proxyErr) {
    throw new Error(`Yahoo Finance quote 失败: direct v7=${res.status} v6=${res6.status}, proxy error: ${String(proxyErr)}`);
  }
}

async function fetchChart(
  symbol: string,
  range: string,
  interval: string
): Promise<any> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await httpGet(url, { timeout: REQUEST_TIMEOUT });
  if (res.status !== 200)
    throw new Error(`Yahoo Finance Chart 返回 HTTP ${res.status}`);
  return JSON.parse(res.data);
}

/* ---- Plugin ---- */

const plugin = {
  id: "commodities",
  name: "Commodities & Futures",
  description:
    "Global commodity futures: precious metals, energy, agriculture",

  register(api: OpenClawPluginApi) {
    /* ---- commodity_price: 大宗商品实时价格 ---- */
    api.registerTool({
      name: "commodity_price",
      label: "大宗商品/期货价格",
      description: `查询全球大宗商品和期货的实时价格。

覆盖品种：
- 贵金属：黄金、白银、铂金、钯金、铜
- 能源：WTI原油、布伦特原油、天然气、汽油、取暖油
- 农产品：玉米、大豆、小麦、棉花、咖啡、可可、糖、活牛、瘦猪、木材

可直接输入中文名（如"黄金"、"原油"）或期货代码（如 GC=F、CL=F）。
支持同时查多个品种。`,
      parameters: Type.Object({
        names: Type.String({
          description:
            "商品名称或期货代码，多个用逗号分隔。如：黄金,原油,白银 或 GC=F,CL=F",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const raw = (params.names as string).trim();
        if (!raw) return { error: "需要提供商品名称或期货代码" };

        const inputs = raw.split(/[,，\s]+/).filter(Boolean);
        const symbols = inputs.map(resolveSymbol);

        try {
          const results = await fetchQuotes(symbols);

          if (!results || results.length === 0) {
            return {
              error: `未找到 ${inputs.join(", ")} 的行情数据`,
              提示: "请检查品种名称。支持：黄金、白银、原油、天然气、玉米、大豆等",
            };
          }

          // Build reverse map: symbol → Chinese name + unit
          const infoMap: Record<string, { name: string; unit: string }> = {};
          for (const [_cat, items] of Object.entries(COMMODITY_CATEGORIES)) {
            for (const [name, info] of Object.entries(items)) {
              infoMap[info.symbol] = { name, unit: info.unit };
            }
          }

          const quotes = results.map((q: any) => {
            const info = infoMap[q.symbol];
            return {
              品种: info?.name || q.shortName || q.symbol,
              代码: q.symbol,
              价格: formatPrice(q.regularMarketPrice),
              单位: info?.unit || q.currency || "",
              涨跌: formatPrice(q.regularMarketChange),
              涨跌幅: formatPercent(q.regularMarketChangePercent),
              今开: formatPrice(q.regularMarketOpen),
              最高: formatPrice(q.regularMarketDayHigh),
              最低: formatPrice(q.regularMarketDayLow),
              昨收: formatPrice(q.regularMarketPreviousClose),
              成交量: formatNumber(q.regularMarketVolume),
              市场状态: q.marketState || "",
            };
          });

          console.log(
            `[commodities] price ${symbols.join(",")} → ${quotes.length} results`
          );

          return {
            result_count: quotes.length,
            quotes,
            数据来源: "Yahoo Finance (CME/NYMEX/CBOT 期货)",
          };
        } catch (err) {
          return { error: `查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- commodity_overview: 大宗商品市场概览 ---- */
    api.registerTool({
      name: "commodity_overview",
      label: "大宗商品市场概览",
      description: `一键查看大宗商品市场全景：贵金属、能源、农产品主要品种的实时价格。
适用场景：用户问"大宗商品行情"、"期货市场怎么样"、"今天金价油价"等。
可按类别筛选：metals（贵金属）、energy（能源）、agriculture（农产品）、all（全部）。`,
      parameters: Type.Object({
        category: Type.Optional(
          Type.String({
            description:
              "类别筛选：metals（贵金属）、energy（能源）、agriculture（农产品）、all（全部，默认）",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const category = (params.category as string) || "all";

        const catMap: Record<string, string[]> = {
          metals: ["GC=F", "SI=F", "PL=F", "HG=F"],
          energy: ["CL=F", "BZ=F", "NG=F", "RB=F"],
          agriculture: [
            "ZC=F",
            "ZS=F",
            "ZW=F",
            "CT=F",
            "KC=F",
            "CC=F",
            "SB=F",
          ],
        };

        let symbols: string[];
        if (category === "all") {
          symbols = [
            ...catMap.metals,
            ...catMap.energy,
            ...catMap.agriculture,
          ];
        } else {
          symbols = catMap[category] || catMap.metals;
        }

        try {
          const results = await fetchQuotes(symbols);

          if (!results || results.length === 0) {
            return { error: "无法获取大宗商品数据" };
          }

          // Reverse map
          const infoMap: Record<string, { name: string; unit: string }> = {};
          for (const [_cat, items] of Object.entries(COMMODITY_CATEGORIES)) {
            for (const [name, info] of Object.entries(items)) {
              infoMap[info.symbol] = { name, unit: info.unit };
            }
          }

          const quotes = results.map((q: any) => {
            const info = infoMap[q.symbol];
            return {
              品种: info?.name || q.shortName || q.symbol,
              价格: formatPrice(q.regularMarketPrice),
              单位: info?.unit || "",
              涨跌幅: formatPercent(q.regularMarketChangePercent),
            };
          });

          // Group by category
          const grouped: Record<string, any[]> = {};
          for (const q of results) {
            let cat = "其他";
            if (
              catMap.metals.includes(q.symbol)
            )
              cat = "贵金属";
            else if (catMap.energy.includes(q.symbol)) cat = "能源";
            else if (catMap.agriculture.includes(q.symbol)) cat = "农产品";

            if (!grouped[cat]) grouped[cat] = [];
            const info = infoMap[q.symbol];
            grouped[cat].push({
              品种: info?.name || q.shortName || q.symbol,
              价格: formatPrice(q.regularMarketPrice),
              单位: info?.unit || "",
              涨跌幅: formatPercent(q.regularMarketChangePercent),
            });
          }

          console.log(
            `[commodities] overview ${category} → ${results.length} items`
          );

          return {
            类别: category === "all" ? "全部" : category,
            市场概览: grouped,
            数据来源: "Yahoo Finance (CME/NYMEX/CBOT 期货)",
          };
        } catch (err) {
          return { error: `获取市场概览失败: ${String(err)}` };
        }
      },
    });

    /* ---- commodity_chart: 大宗商品K线 ---- */
    api.registerTool({
      name: "commodity_chart",
      label: "大宗商品K线/走势",
      description: `查询大宗商品/期货的历史K线走势数据。
支持中文名称（如"黄金"、"原油"）或期货代码（如 GC=F）。

时间范围：1d（当日分时）、5d、1mo、3mo、6mo、1y、5y、max
K线周期：自动根据范围选择，也可手动指定（1d/1wk/1mo）`,
      parameters: Type.Object({
        name: Type.String({
          description: "商品名称或期货代码。如：黄金、原油、GC=F、CL=F",
        }),
        range: Type.Optional(
          Type.String({
            description:
              "时间范围：1d、5d、1mo、3mo、6mo、1y、5y、max。默认 1mo",
          })
        ),
        interval: Type.Optional(
          Type.String({
            description:
              "K线周期：5m、15m、1h、1d、1wk、1mo。默认自动选择",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const rawName = (params.name as string).trim();
        if (!rawName) return { error: "需要提供商品名称或代码" };

        const symbol = resolveSymbol(rawName);
        const range = (params.range as string) || "1mo";

        let interval = params.interval as string;
        if (!interval) {
          const autoMap: Record<string, string> = {
            "1d": "5m",
            "5d": "15m",
            "1mo": "1d",
            "3mo": "1d",
            "6mo": "1d",
            "1y": "1wk",
            "5y": "1mo",
            max: "1mo",
          };
          interval = autoMap[range] || "1d";
        }

        // Find friendly name
        let friendlyName = rawName;
        for (const [_cat, items] of Object.entries(COMMODITY_CATEGORIES)) {
          for (const [name, info] of Object.entries(items)) {
            if (info.symbol === symbol) {
              friendlyName = name;
              break;
            }
          }
        }

        try {
          const data = await fetchChart(symbol, range, interval);
          const chartData = data?.chart?.result?.[0];

          if (!chartData) {
            return { error: `未找到 ${friendlyName}(${symbol}) 的K线数据` };
          }

          const timestamps = chartData.timestamp || [];
          const quote = chartData.indicators?.quote?.[0] || {};

          const maxCandles = 30;
          const startIdx = Math.max(0, timestamps.length - maxCandles);
          const candles = [];

          for (let i = startIdx; i < timestamps.length; i++) {
            const ts = timestamps[i];
            if (!ts) continue;

            const date = new Date(ts * 1000);
            const dateStr =
              interval.includes("m") || interval === "1h"
                ? date.toISOString().replace("T", " ").substring(0, 16)
                : date.toISOString().substring(0, 10);

            candles.push({
              日期: dateStr,
              开盘: formatPrice(quote.open?.[i]),
              最高: formatPrice(quote.high?.[i]),
              最低: formatPrice(quote.low?.[i]),
              收盘: formatPrice(quote.close?.[i]),
              成交量: formatNumber(quote.volume?.[i]),
            });
          }

          // Period change
          const allClose = (quote.close || []).filter(
            (v: any) => v != null && !isNaN(v)
          );
          let periodChange = "N/A";
          let periodChangePercent = "N/A";
          if (allClose.length >= 2) {
            const first = allClose[0];
            const last = allClose[allClose.length - 1];
            periodChange = formatPrice(last - first);
            periodChangePercent = formatPercent(
              ((last - first) / first) * 100
            );
          }

          console.log(
            `[commodities] chart ${symbol} ${range}/${interval} → ${candles.length} candles`
          );

          return {
            品种: friendlyName,
            代码: symbol,
            时间范围: range,
            K线周期: interval,
            区间涨跌: periodChange,
            区间涨跌幅: periodChangePercent,
            数据点数: candles.length,
            K线数据: candles,
            数据来源: "Yahoo Finance (CME/NYMEX/CBOT 期货)",
          };
        } catch (err) {
          return { error: `获取K线失败: ${String(err)}` };
        }
      },
    });

    console.log(
      "[commodities] Registered 3 tools: commodity_price, commodity_overview, commodity_chart"
    );
  },
};

export default plugin;
