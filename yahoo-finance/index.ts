import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";
import * as net from "node:net";
import * as tls from "node:tls";

/* ------------------------------------------------------------------ */
/*  Yahoo Finance Plugin                                               */
/*  Global stocks: US (AAPL, TSLA), HK (0700.HK), JP (7203.T), etc.  */
/*  Uses Yahoo Finance unofficial JSON endpoints (no API key needed)   */
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
            "Accept-Language": "en-US,en;q=0.9",
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

function formatNumber(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "N/A";
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function formatPrice(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "N/A";
  return n.toFixed(2);
}

function formatPercent(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "N/A";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

// Common ticker symbol aliases (Chinese → Yahoo symbol)
const TICKER_ALIASES: Record<string, string> = {
  // US
  "苹果": "AAPL", "特斯拉": "TSLA", "谷歌": "GOOGL", "微软": "MSFT",
  "亚马逊": "AMZN", "英伟达": "NVDA", "脸书": "META", "meta": "META",
  "奈飞": "NFLX", "网飞": "NFLX", "英特尔": "INTC", "AMD": "AMD",
  "波音": "BA", "可口可乐": "KO", "迪士尼": "DIS", "高通": "QCOM",
  "台积电": "TSM", "阿里巴巴美股": "BABA", "拼多多美股": "PDD",
  "京东美股": "JD", "百度美股": "BIDU", "哔哩哔哩美股": "BILI",
  "蔚来": "NIO", "小鹏": "XPEV", "理想": "LI",
  // HK
  "腾讯": "0700.HK", "阿里巴巴": "9988.HK", "美团": "3690.HK",
  "小米": "1810.HK", "京东": "9618.HK", "百度": "9888.HK",
  "网易": "9999.HK", "哔哩哔哩": "9626.HK", "快手": "1024.HK",
  "比亚迪": "1211.HK", "华为": "0700.HK", // 华为没上市，映射到腾讯提示
  "恒生指数": "^HSI", "恒指": "^HSI", "国企指数": "^HSCE",
  // JP
  "丰田": "7203.T", "索尼": "6758.T", "任天堂": "7974.T",
  "软银": "9984.T", "日经指数": "^N225", "日经": "^N225",
  // Index
  "标普500": "^GSPC", "标普": "^GSPC", "道琼斯": "^DJI", "道指": "^DJI",
  "纳斯达克": "^IXIC", "纳指": "^IXIC",
  "罗素2000": "^RUT",
};

function resolveSymbol(input: string): string {
  const trimmed = input.trim();
  // Check alias first
  const alias = TICKER_ALIASES[trimmed] || TICKER_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  // Already a ticker symbol
  return trimmed.toUpperCase();
}

/* ---- Yahoo Finance API helpers ---- */

// Quote API v6 — realtime quote (with SOCKS5 fallback for rate-limited IPs)
async function fetchQuote(symbols: string[]): Promise<any> {
  const symStr = symbols.join(",");
  const YAHOO_HOST = "query2.finance.yahoo.com";

  // Try direct v6 first
  const url = `https://${YAHOO_HOST}/v6/finance/quote?symbols=${symStr}`;
  const res = await httpGet(url, { timeout: REQUEST_TIMEOUT });

  if (res.status === 200) return JSON.parse(res.data);

  // Try direct v7
  const url7 = `https://${YAHOO_HOST}/v7/finance/quote?symbols=${symStr}`;
  const res7 = await httpGet(url7, { timeout: REQUEST_TIMEOUT });

  if (res7.status === 200) return JSON.parse(res7.data);

  // Both failed (likely 429 rate-limit) — fallback through WARP SOCKS5 proxy
  console.log(`[yahoo-finance] direct quote failed (v6=${res.status}, v7=${res7.status}), trying SOCKS5 proxy...`);

  try {
    const proxyRes = await socks5HttpsGet(
      "127.0.0.1", 40000,
      YAHOO_HOST, 443,
      `/v6/finance/quote?symbols=${symStr}`,
      { Accept: "application/json" }
    );
    if (proxyRes.status === 200) return JSON.parse(proxyRes.data);

    // Try v7 through proxy
    const proxyRes7 = await socks5HttpsGet(
      "127.0.0.1", 40000,
      YAHOO_HOST, 443,
      `/v7/finance/quote?symbols=${symStr}`,
      { Accept: "application/json" }
    );
    if (proxyRes7.status === 200) return JSON.parse(proxyRes7.data);

    throw new Error(`Yahoo Finance 返回 HTTP ${proxyRes7.status} (via proxy)`);
  } catch (proxyErr) {
    throw new Error(`Yahoo Finance quote 失败: direct v6=${res.status} v7=${res7.status}, proxy error: ${String(proxyErr)}`);
  }
}

// Search API — symbol search
async function fetchSearch(query: string): Promise<any> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=true&quotesQueryId=tss_match_phrase_query`;
  const res = await httpGet(url, { timeout: REQUEST_TIMEOUT });
  if (res.status !== 200) throw new Error(`Yahoo Finance Search 返回 HTTP ${res.status}`);
  return JSON.parse(res.data);
}

// Chart API — historical data
async function fetchChart(
  symbol: string,
  range: string,
  interval: string
): Promise<any> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await httpGet(url, { timeout: REQUEST_TIMEOUT });
  if (res.status !== 200) throw new Error(`Yahoo Finance Chart 返回 HTTP ${res.status}`);
  return JSON.parse(res.data);
}

/* ---- Plugin ---- */

const plugin = {
  id: "yahoo-finance",
  name: "Yahoo Finance",
  description: "Global stock quotes, charts, and search via Yahoo Finance",

  register(api: OpenClawPluginApi) {
    /* ---- stock_quote: 实时行情 ---- */
    api.registerTool({
      name: "stock_quote",
      label: "股票实时行情",
      description: `查询美股、港股、日股、全球指数的实时行情。
支持直接输入股票代码（如 AAPL、0700.HK、7203.T）或中文名称（如 特斯拉、腾讯、丰田）。
可同时查询多个股票。

常用代码：
- 美股：AAPL（苹果）、TSLA（特斯拉）、NVDA（英伟达）、MSFT（微软）
- 港股：0700.HK（腾讯）、9988.HK（阿里）、3690.HK（美团）、1810.HK（小米）
- 日股：7203.T（丰田）、6758.T（索尼）、7974.T（任天堂）
- 中概美股：BABA（阿里）、PDD（拼多多）、NIO（蔚来）、XPEV（小鹏）
- 指数：^GSPC（标普500）、^DJI（道琼斯）、^IXIC（纳斯达克）、^HSI（恒生）、^N225（日经）

注意：A股请使用 akshare 系列工具，本工具不支持 A 股。`,
      parameters: Type.Object({
        symbols: Type.String({
          description:
            "股票代码或中文名，多个用逗号分隔。如 AAPL,TSLA 或 特斯拉,苹果 或 0700.HK",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const raw = (params.symbols as string).trim();
        if (!raw) return { error: "需要提供股票代码或名称" };

        const inputs = raw.split(/[,，\s]+/).filter(Boolean);
        const symbols = inputs.map(resolveSymbol);

        try {
          const data = await fetchQuote(symbols);
          const results =
            data?.quoteResponse?.result || data?.finance?.result?.[0]?.quotes || [];

          if (!results || results.length === 0) {
            return {
              error: `未找到 ${symbols.join(", ")} 的行情数据`,
              提示: "请检查股票代码是否正确。美股直接用代码如 AAPL，港股加 .HK 如 0700.HK",
            };
          }

          const quotes = results.map((q: any) => {
            const item: Record<string, unknown> = {
              代码: q.symbol,
              名称: q.shortName || q.longName || q.symbol,
              价格: formatPrice(q.regularMarketPrice),
              货币: q.currency || "",
              涨跌额: formatPrice(q.regularMarketChange),
              涨跌幅: formatPercent(q.regularMarketChangePercent),
              今开: formatPrice(q.regularMarketOpen),
              最高: formatPrice(q.regularMarketDayHigh),
              最低: formatPrice(q.regularMarketDayLow),
              昨收: formatPrice(q.regularMarketPreviousClose),
              成交量: formatNumber(q.regularMarketVolume),
              市场状态: q.marketState || "",
            };

            // Market cap (if available)
            if (q.marketCap) {
              item["市值"] = formatNumber(q.marketCap);
            }
            // PE ratio
            if (q.trailingPE) {
              item["市盈率(TTM)"] = q.trailingPE.toFixed(2);
            }
            // 52-week range
            if (q.fiftyTwoWeekHigh && q.fiftyTwoWeekLow) {
              item["52周范围"] = `${formatPrice(q.fiftyTwoWeekLow)} - ${formatPrice(q.fiftyTwoWeekHigh)}`;
            }
            // Pre/post market
            if (q.preMarketPrice) {
              item["盘前价格"] = `${formatPrice(q.preMarketPrice)} (${formatPercent(q.preMarketChangePercent)})`;
            }
            if (q.postMarketPrice) {
              item["盘后价格"] = `${formatPrice(q.postMarketPrice)} (${formatPercent(q.postMarketChangePercent)})`;
            }
            // Exchange info
            item["交易所"] = q.fullExchangeName || q.exchange || "";

            return item;
          });

          console.log(`[yahoo-finance] quote ${symbols.join(",")} → ${quotes.length} results`);

          return {
            result_count: quotes.length,
            quotes,
            数据来源: "Yahoo Finance",
          };
        } catch (err) {
          return { error: `查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- stock_search: 搜索股票 ---- */
    api.registerTool({
      name: "stock_search",
      label: "股票搜索",
      description: `按关键词搜索全球股票/ETF/指数/基金的代码和基本信息。
当不确定股票代码时使用此工具。输入公司名或关键词，返回匹配的证券列表。
注意：A股请使用 akshare 系列工具。`,
      parameters: Type.Object({
        query: Type.String({
          description: "搜索关键词，如公司名、代码、行业等",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = (params.query as string).trim();
        if (!query) return { error: "需要提供搜索关键词" };

        try {
          const data = await fetchSearch(query);
          const quotes = (data?.quotes || []).slice(0, 10);

          if (quotes.length === 0) {
            return { query, results: [], message: "未找到匹配的证券" };
          }

          const results = quotes.map((q: any, i: number) => ({
            index: i + 1,
            代码: q.symbol,
            名称: q.shortname || q.longname || "",
            类型: q.quoteType || "",
            交易所: q.exchDisp || q.exchange || "",
            行业: q.industry || "",
            分数: q.score || 0,
          }));

          console.log(`[yahoo-finance] search "${query}" → ${results.length} results`);

          return {
            query,
            result_count: results.length,
            results,
            数据来源: "Yahoo Finance",
          };
        } catch (err) {
          return { error: `搜索失败: ${String(err)}` };
        }
      },
    });

    /* ---- stock_chart: K线/历史行情 ---- */
    api.registerTool({
      name: "stock_chart",
      label: "股票K线/历史行情",
      description: `查询美股、港股、日股的历史K线数据。
返回指定时间范围内的开/高/低/收/量数据。

时间范围选项：1d（当日分时）、5d（5天）、1mo（1月）、3mo（3月）、6mo（6月）、1y（1年）、5y（5年）、max（全部）
K线周期：1m/5m/15m/1h（日内）、1d（日K）、1wk（周K）、1mo（月K）

注意：A股请使用 akshare_stock_hist，本工具不支持 A 股。`,
      parameters: Type.Object({
        symbol: Type.String({
          description: "股票代码或中文名。如 TSLA、腾讯、0700.HK",
        }),
        range: Type.Optional(
          Type.String({
            description:
              "时间范围：1d、5d、1mo、3mo、6mo、1y、2y、5y、max。默认 1mo",
          })
        ),
        interval: Type.Optional(
          Type.String({
            description:
              "K线周期：1m、5m、15m、1h、1d、1wk、1mo。默认根据range自动选择",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const rawSymbol = (params.symbol as string).trim();
        if (!rawSymbol) return { error: "需要提供股票代码" };

        const symbol = resolveSymbol(rawSymbol);
        const range = (params.range as string) || "1mo";

        // Auto-select interval based on range
        let interval = params.interval as string;
        if (!interval) {
          const autoMap: Record<string, string> = {
            "1d": "5m",
            "5d": "15m",
            "1mo": "1d",
            "3mo": "1d",
            "6mo": "1d",
            "1y": "1wk",
            "2y": "1wk",
            "5y": "1mo",
            "max": "1mo",
          };
          interval = autoMap[range] || "1d";
        }

        try {
          const data = await fetchChart(symbol, range, interval);
          const chartData = data?.chart?.result?.[0];

          if (!chartData) {
            return { error: `未找到 ${symbol} 的K线数据` };
          }

          const meta = chartData.meta || {};
          const timestamps = chartData.timestamp || [];
          const quote = chartData.indicators?.quote?.[0] || {};

          // Build candles (last N, limit to keep response size reasonable)
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

          // Summary
          const allClose = (quote.close || []).filter(
            (v: any) => v != null && !isNaN(v)
          );
          let periodChange = "N/A";
          let periodChangePercent = "N/A";
          if (allClose.length >= 2) {
            const first = allClose[0];
            const last = allClose[allClose.length - 1];
            const change = last - first;
            const pct = (change / first) * 100;
            periodChange = formatPrice(change);
            periodChangePercent = formatPercent(pct);
          }

          console.log(
            `[yahoo-finance] chart ${symbol} ${range}/${interval} → ${candles.length} candles`
          );

          return {
            代码: symbol,
            名称: meta.shortName || meta.longName || symbol,
            货币: meta.currency || "",
            交易所: meta.fullExchangeName || meta.exchangeName || "",
            时间范围: range,
            K线周期: interval,
            区间涨跌: periodChange,
            区间涨跌幅: periodChangePercent,
            数据点数: candles.length,
            K线数据: candles,
            数据来源: "Yahoo Finance",
          };
        } catch (err) {
          return { error: `获取K线失败: ${String(err)}` };
        }
      },
    });

    /* ---- market_overview: 全球市场概览 ---- */
    api.registerTool({
      name: "market_overview",
      label: "全球市场概览",
      description: `一键查看全球主要市场指数行情：美股三大指数、港股恒指、日经、欧洲主要指数。
适用场景：用户问"全球股市怎么样"、"美股今天如何"、"海外市场"等。
注意：A股大盘请使用 akshare_stock_spot 或 akshare_index_hist。`,
      parameters: Type.Object({
        region: Type.Optional(
          Type.String({
            description:
              "区域筛选：us（美股）、hk（港股）、jp（日股）、eu（欧洲）、all（全部，默认）",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const region = (params.region as string) || "all";

        const regionSymbols: Record<string, string[]> = {
          us: ["^GSPC", "^DJI", "^IXIC", "^RUT", "^VIX"],
          hk: ["^HSI", "^HSCE"],
          jp: ["^N225"],
          eu: ["^FTSE", "^GDAXI", "^FCHI"],
        };

        let symbols: string[];
        if (region === "all") {
          symbols = [
            ...regionSymbols.us,
            ...regionSymbols.hk,
            ...regionSymbols.jp,
            ...regionSymbols.eu,
          ];
        } else {
          symbols = regionSymbols[region] || regionSymbols.us;
        }

        try {
          const data = await fetchQuote(symbols);
          const results =
            data?.quoteResponse?.result || data?.finance?.result?.[0]?.quotes || [];

          if (!results || results.length === 0) {
            return { error: "无法获取市场数据" };
          }

          const indexNames: Record<string, string> = {
            "^GSPC": "标普500",
            "^DJI": "道琼斯",
            "^IXIC": "纳斯达克",
            "^RUT": "罗素2000",
            "^VIX": "恐慌指数VIX",
            "^HSI": "恒生指数",
            "^HSCE": "国企指数",
            "^N225": "日经225",
            "^FTSE": "富时100",
            "^GDAXI": "德国DAX",
            "^FCHI": "法国CAC40",
          };

          const indices = results.map((q: any) => ({
            指数: indexNames[q.symbol] || q.shortName || q.symbol,
            代码: q.symbol,
            点位: formatPrice(q.regularMarketPrice),
            涨跌: formatPrice(q.regularMarketChange),
            涨跌幅: formatPercent(q.regularMarketChangePercent),
            市场状态: q.marketState || "",
          }));

          console.log(`[yahoo-finance] market overview ${region} → ${indices.length} indices`);

          return {
            区域: region === "all" ? "全球" : region.toUpperCase(),
            indices,
            数据来源: "Yahoo Finance",
          };
        } catch (err) {
          return { error: `获取市场概览失败: ${String(err)}` };
        }
      },
    });

    console.log(
      "[yahoo-finance] Registered 4 tools: stock_quote, stock_search, stock_chart, market_overview"
    );
  },
};

export default plugin;
