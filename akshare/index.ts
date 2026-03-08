import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import https from "node:https";
import http from "node:http";

// ═══════════════════════════════════════════════════════════════════
// HTTP helpers — 东方财富 / 新浪 / 其他数据源通用请求层
// ═══════════════════════════════════════════════════════════════════

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Generic HTTPS GET, returns raw string */
function httpsGet(
  urlStr: string,
  headers: Record<string, string> = {},
  timeout = 20000,
): Promise<string> {
  const url = new URL(urlStr);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        family: 4,
        headers: { "User-Agent": UA, ...headers },
        timeout,
      },
      (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGet(res.headers.location, headers, timeout).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP request timeout"));
    });
  });
}

/** 东方财富 API JSON fetch — 自动处理 JSONP callback 包装 */
async function emGet(urlStr: string, headers?: Record<string, string>): Promise<any> {
  const raw = await httpsGet(urlStr, {
    Referer: "https://quote.eastmoney.com/",
    ...headers,
  });
  // 东方财富部分接口返回 JSONP: callback({"data":...})
  const jsonStr = raw.replace(/^[^({]*\(/, "").replace(/\);?\s*$/, "");
  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(`东方财富 API 返回非 JSON: ${raw.slice(0, 200)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 市场代码映射 — 东方财富 secid 编码
// ═══════════════════════════════════════════════════════════════════

/** 将用户输入的股票代码转为东方财富 secid (market.code) */
function toSecId(code: string): string {
  code = code.trim().toUpperCase();
  // 已经是 secid 格式
  if (/^\d+\.\d{6}$/.test(code)) return code;
  // 去掉可能的前缀
  code = code.replace(/^(SH|SZ|BJ|sh|sz|bj)/, "");
  if (!code.match(/^\d{6}$/)) return `1.${code}`; // fallback

  // 沪市主板 60xxxx, 科创板 688xxx
  if (code.startsWith("6") || code.startsWith("688")) return `1.${code}`;
  // 深市 00xxxx, 创业板 300xxx / 301xxx
  if (code.startsWith("0") || code.startsWith("3")) return `0.${code}`;
  // 北交所 8xxxxx / 43xxxx
  if (code.startsWith("8") || code.startsWith("4")) return `0.${code}`;
  return `1.${code}`;
}

/** 指数 secid */
function toIndexSecId(code: string): string {
  code = code.trim();
  if (/^\d+\.\d+$/.test(code)) return code;
  // 常见指数映射
  const map: Record<string, string> = {
    "000001": "1.000001", // 上证指数
    "399001": "0.399001", // 深证成指
    "399006": "0.399006", // 创业板指
    "000300": "1.000300", // 沪深300
    "000016": "1.000016", // 上证50
    "000905": "1.000905", // 中证500
    "000852": "1.000852", // 中证1000
  };
  return map[code] || (code.startsWith("0") || code.startsWith("3") ? `0.${code}` : `1.${code}`);
}

// ═══════════════════════════════════════════════════════════════════
// 格式化工具
// ═══════════════════════════════════════════════════════════════════

function fmtNum(n: number | string | null | undefined): string {
  if (n == null || n === "-") return "-";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "-";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(2);
}

function fmtPct(n: number | string | null | undefined): string {
  if (n == null || n === "-") return "-";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(n: number | string | null | undefined): string {
  if (n == null || n === "-") return "-";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "-";
  return v.toFixed(2);
}

// ═══════════════════════════════════════════════════════════════════
// 数据接口实现
// ═══════════════════════════════════════════════════════════════════

// ─── 1. A股实时行情 (stock_zh_a_spot_em) ───

interface SpotItem {
  代码: string;
  名称: string;
  最新价: number;
  涨跌幅: number;
  涨跌额: number;
  成交量: number;
  成交额: number;
  振幅: number;
  最高: number;
  最低: number;
  今开: number;
  昨收: number;
  换手率: number;
  量比: number;
  市盈率: number;
  市净率: number;
}

/**
 * 东方财富 A股实时行情列表
 * 对标 akshare: stock_zh_a_spot_em()
 * API: push2ex.eastmoney.com/getTopicQPick
 * 更轻量的方案: push2.eastmoney.com/api/qt/clist/get
 */
async function stockZhASpotEm(page = 1, pageSize = 20): Promise<SpotItem[]> {
  // fields: f2=最新价 f3=涨跌幅 f4=涨跌额 f5=成交量(手) f6=成交额 f7=振幅
  //         f8=换手率 f9=市盈率 f10=量比 f12=代码 f14=名称 f15=最高 f16=最低
  //         f17=今开 f18=昨收 f23=市净率
  const fields = "f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f23";
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=${fields}`;
  const data = await emGet(url);
  const items = data?.data?.diff;
  if (!items) return [];
  return Object.values(items).map((d: any) => ({
    代码: d.f12,
    名称: d.f14,
    最新价: d.f2,
    涨跌幅: d.f3,
    涨跌额: d.f4,
    成交量: d.f5,
    成交额: d.f6,
    振幅: d.f7,
    换手率: d.f8,
    市盈率: d.f9,
    量比: d.f10,
    最高: d.f15,
    最低: d.f16,
    今开: d.f17,
    昨收: d.f18,
    市净率: d.f23,
  }));
}

// ─── 2. A股历史K线 (stock_zh_a_hist) ───

interface KlineItem {
  日期: string;
  开盘: number;
  收盘: number;
  最高: number;
  最低: number;
  成交量: number;
  成交额: number;
  振幅: number;
  涨跌幅: number;
  涨跌额: number;
  换手率: number;
}

/**
 * 东方财富 个股历史K线
 * 对标 akshare: stock_zh_a_hist(symbol, period, start_date, end_date, adjust)
 * API: push2his.eastmoney.com/api/qt/stock/kline/get
 */
async function stockZhAHist(
  symbol: string,
  period: "daily" | "weekly" | "monthly" = "daily",
  startDate?: string,
  endDate?: string,
  adjust: "qfq" | "hfq" | "" = "qfq",
): Promise<KlineItem[]> {
  const secid = toSecId(symbol);
  const kltMap: Record<string, string> = { daily: "101", weekly: "102", monthly: "103" };
  const fqtMap: Record<string, string> = { qfq: "1", hfq: "2", "": "0" };
  const klt = kltMap[period] || "101";
  const fqt = fqtMap[adjust] || "1";
  const beg = startDate?.replace(/-/g, "") || "0";
  const end = endDate?.replace(/-/g, "") || "20500101";

  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${fqt}&beg=${beg}&end=${end}&lmt=1000000`;
  const data = await emGet(url);
  const klines = data?.data?.klines;
  if (!klines?.length) return [];
  return klines.map((line: string) => {
    const p = line.split(",");
    return {
      日期: p[0],
      开盘: parseFloat(p[1]),
      收盘: parseFloat(p[2]),
      最高: parseFloat(p[3]),
      最低: parseFloat(p[4]),
      成交量: parseInt(p[5], 10),
      成交额: parseFloat(p[6]),
      振幅: parseFloat(p[7]),
      涨跌幅: parseFloat(p[8]),
      涨跌额: parseFloat(p[9]),
      换手率: parseFloat(p[10]),
    };
  });
}

// ─── 3. 个股详情 (stock_individual_info_em) ───

async function stockIndividualInfoEm(symbol: string): Promise<string> {
  const secid = toSecId(symbol);
  // 个股基本面
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f84,f85,f116,f117,f162,f163,f167,f170,f171,f173,f186,f187,f188,f189,f190,f191,f192,f193,f194,f195,f196,f197,f199,f260,f261,f262,f263,f264,f267,f268,f269,f270,f271,f272,f273,f274,f275,f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f55,f60,f71,f92,f152`;
  const data = await emGet(url);
  const d = data?.data;
  if (!d) return "未找到该股票信息";

  const lines = [
    `股票代码: ${d.f57}`,
    `股票名称: ${d.f58}`,
    `最新价: ${fmtPrice(d.f43)}`,
    `涨跌幅: ${fmtPct(d.f170)}`,
    `涨跌额: ${fmtPrice(d.f169)}`,
    `今开: ${fmtPrice(d.f46)}  昨收: ${fmtPrice(d.f60)}`,
    `最高: ${fmtPrice(d.f44)}  最低: ${fmtPrice(d.f45)}`,
    `成交量: ${fmtNum(d.f47)}手  成交额: ${fmtNum(d.f48)}`,
    `换手率: ${fmtPct(d.f168)}`,
    `振幅: ${fmtPct(d.f171)}`,
    `量比: ${d.f50 != null ? (d.f50 as number).toFixed(2) : "-"}`,
    `市盈率(动): ${d.f162 != null ? (d.f162 as number).toFixed(2) : "-"}`,
    `市净率: ${d.f167 != null ? (d.f167 as number).toFixed(2) : "-"}`,
    `总市值: ${fmtNum(d.f116)}`,
    `流通市值: ${fmtNum(d.f117)}`,
    `总股本: ${fmtNum(d.f84)}`,
    `流通股本: ${fmtNum(d.f85)}`,
    `52周最高: ${fmtPrice(d.f192)}  52周最低: ${fmtPrice(d.f193)}`,
    `60日涨跌幅: ${fmtPct(d.f197)}`,
    `年初至今涨跌幅: ${fmtPct(d.f199)}`,
  ];
  return lines.join("\n");
}

// ─── 4. 指数历史K线 (index_zh_a_hist) ───

async function indexZhAHist(
  symbol: string,
  period: "daily" | "weekly" | "monthly" = "daily",
  startDate?: string,
  endDate?: string,
): Promise<KlineItem[]> {
  const secid = toIndexSecId(symbol);
  const kltMap: Record<string, string> = { daily: "101", weekly: "102", monthly: "103" };
  const klt = kltMap[period] || "101";
  const beg = startDate?.replace(/-/g, "") || "0";
  const end = endDate?.replace(/-/g, "") || "20500101";
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&beg=${beg}&end=${end}&lmt=1000000`;
  const data = await emGet(url);
  const klines = data?.data?.klines;
  if (!klines?.length) return [];
  return klines.map((line: string) => {
    const p = line.split(",");
    return {
      日期: p[0],
      开盘: parseFloat(p[1]),
      收盘: parseFloat(p[2]),
      最高: parseFloat(p[3]),
      最低: parseFloat(p[4]),
      成交量: parseInt(p[5], 10),
      成交额: parseFloat(p[6]),
      振幅: parseFloat(p[7]),
      涨跌幅: parseFloat(p[8]),
      涨跌额: parseFloat(p[9]),
      换手率: parseFloat(p[10]),
    };
  });
}

// ─── 5. 板块行情 (stock_board_industry_name_em) ───

interface BoardItem {
  板块名称: string;
  板块代码: string;
  最新价: number;
  涨跌幅: number;
  涨跌额: number;
  成交量: number;
  成交额: number;
  换手率: number;
  领涨股票: string;
  领涨涨跌幅: number;
}

async function stockBoardIndustryNameEm(): Promise<BoardItem[]> {
  const fields = "f2,f3,f4,f5,f6,f8,f12,f14,f104,f128,f136,f140";
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=${fields}`;
  const data = await emGet(url);
  const items = data?.data?.diff;
  if (!items) return [];
  return Object.values(items).map((d: any) => ({
    板块名称: d.f14,
    板块代码: d.f12,
    最新价: d.f2,
    涨跌幅: d.f3,
    涨跌额: d.f4,
    成交量: d.f5,
    成交额: d.f6,
    换手率: d.f8,
    领涨股票: d.f140 || "-",
    领涨涨跌幅: d.f136,
  }));
}

// ─── 6. 北向资金 (stock_hsgt_north_net_flow_in_em) ───

interface NorthFlowItem {
  日期: string;
  沪股通净流入: number;
  深股通净流入: number;
  北向资金净流入: number;
}

async function stockHsgtNorthNetFlowInEm(): Promise<NorthFlowItem[]> {
  const url =
    `https://push2his.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=30`;
  const data = await emGet(url);
  const d = data?.data;
  if (!d) return [];

  // API 返回 hk2sh(沪股通) 和 hk2sz(深股通) 两个数组
  const hk2sh: string[] = d.hk2sh || d.s2n || [];
  const hk2sz: string[] = d.hk2sz || [];

  if (!hk2sh.length) return [];

  // 按日期合并沪股通+深股通
  const result: NorthFlowItem[] = [];
  for (let i = 0; i < hk2sh.length; i++) {
    const sh = hk2sh[i].split(",");
    const sz = hk2sz[i]?.split(",") || [];
    const shNet = parseFloat(sh[1]) || 0;
    const szNet = parseFloat(sz[1]) || 0;
    result.push({
      日期: sh[0],
      沪股通净流入: shNet,
      深股通净流入: szNet,
      北向资金净流入: shNet + szNet,
    });
  }
  return result;
}

// ─── 7. ETF 实时行情 (fund_etf_spot_em) ───

async function fundEtfSpotEm(page = 1, pageSize = 20): Promise<SpotItem[]> {
  const fields = "f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f23";
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024&fields=${fields}`;
  const data = await emGet(url);
  const items = data?.data?.diff;
  if (!items) return [];
  return Object.values(items).map((d: any) => ({
    代码: d.f12,
    名称: d.f14,
    最新价: d.f2,
    涨跌幅: d.f3,
    涨跌额: d.f4,
    成交量: d.f5,
    成交额: d.f6,
    振幅: d.f7,
    换手率: d.f8,
    市盈率: d.f9,
    量比: d.f10,
    最高: d.f15,
    最低: d.f16,
    今开: d.f17,
    昨收: d.f18,
    市净率: d.f23,
  }));
}

// ─── 8. 宏观经济 CPI (macro_china_cpi) ───

async function macroChinaCpi(): Promise<string> {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI&columns=REPORT_DATE,NATIONAL_SAME,NATIONAL_BASE,NATIONAL_SEQUENTIAL,NATIONAL_ACCUMULATE&pageSize=12&sortColumns=REPORT_DATE&sortTypes=-1&pageNumber=1`;
  const data = await emGet(url);
  const items = data?.result?.data;
  if (!items?.length) return "暂无 CPI 数据";
  const header = "日期          同比(%)  定基(%)  环比(%)  累计(%)";
  const rows = items.map((d: any) => {
    const date = (d.REPORT_DATE || "").slice(0, 7);
    return `${date}      ${fmtPrice(d.NATIONAL_SAME)}   ${fmtPrice(d.NATIONAL_BASE)}   ${fmtPrice(d.NATIONAL_SEQUENTIAL)}   ${fmtPrice(d.NATIONAL_ACCUMULATE)}`;
  });
  return `CPI 消费者物价指数 (最近12期):\n${header}\n${rows.join("\n")}`;
}

// ─── 9. 宏观经济 PMI (macro_china_pmi) ───

async function macroChinaPmi(): Promise<string> {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_PMI&columns=REPORT_DATE,MAKE_INDEX,MAKE_SAME,NMAKE_INDEX,NMAKE_SAME&pageSize=12&sortColumns=REPORT_DATE&sortTypes=-1&pageNumber=1`;
  const data = await emGet(url);
  const items = data?.result?.data;
  if (!items?.length) return "暂无 PMI 数据";
  const header = "日期          制造业PMI  同比(%)    非制造业PMI  同比(%)";
  const rows = items.map((d: any) => {
    const date = (d.REPORT_DATE || "").slice(0, 7);
    return `${date}      ${fmtPrice(d.MAKE_INDEX)}      ${fmtPrice(d.MAKE_SAME)}      ${fmtPrice(d.NMAKE_INDEX)}       ${fmtPrice(d.NMAKE_SAME)}`;
  });
  return `PMI 采购经理指数 (最近12期):\n${header}\n${rows.join("\n")}`;
}

// ─── 10. 宏观经济 PPI (macro_china_ppi) ───

async function macroChinaPpi(): Promise<string> {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_PPI&columns=REPORT_DATE,BASE,BASE_SAME,BASE_ACCUMULATE&pageSize=12&sortColumns=REPORT_DATE&sortTypes=-1&pageNumber=1`;
  const data = await emGet(url);
  const items = data?.result?.data;
  if (!items?.length) return "暂无 PPI 数据";
  const header = "日期          当月(%)  同比(%)  累计(%)";
  const rows = items.map((d: any) => {
    const date = (d.REPORT_DATE || "").slice(0, 7);
    return `${date}      ${fmtPrice(d.BASE)}   ${fmtPrice(d.BASE_SAME)}   ${fmtPrice(d.BASE_ACCUMULATE)}`;
  });
  return `PPI 工业品出厂价格指数 (最近12期):\n${header}\n${rows.join("\n")}`;
}

// ─── 11. 龙虎榜 (stock_lhb_detail_em) ───

async function stockLhbDetailEm(date?: string): Promise<string> {
  const d = date || new Date().toISOString().slice(0, 10);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,CHANGE_RATE,CLOSE_PRICE,BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,BILLBOARD_DEAL_AMT,ACCUM_AMOUNT,DEAL_NET_RATIO,DEAL_AMOUNT_RATIO,TURNOVERRATE,FREE_MARKET_CAP,EXPLANATION&filter=(TRADE_DATE='${d}')&pageSize=50&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1&pageNumber=1`;
  const data = await emGet(url);
  const items = data?.result?.data;
  if (!items?.length) return `${d} 暂无龙虎榜数据（可能非交易日）`;
  const lines = items.slice(0, 30).map((d: any, i: number) => {
    return `${i + 1}. ${d.SECURITY_NAME_ABBR}(${d.SECURITY_CODE}) 涨跌幅:${fmtPct(d.CHANGE_RATE)} 龙虎榜净买入:${fmtNum(d.BILLBOARD_NET_AMT)} 买入:${fmtNum(d.BILLBOARD_BUY_AMT)} 卖出:${fmtNum(d.BILLBOARD_SELL_AMT)} 原因:${d.EXPLANATION || "-"}`;
  });
  return `龙虎榜 ${d} (共${items.length}只):\n${lines.join("\n")}`;
}

// ─── 12. 新闻快讯 (stock_news_em) ───

async function stockNewsEm(pageSize = 20): Promise<string> {
  const url = `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=important&order=1&needInteractData=0&page_index=1&page_size=${pageSize}`;
  try {
    const raw = await httpsGet(url);
    const data = JSON.parse(raw);
    const items = data?.data?.list;
    if (!items?.length) return "暂无新闻";
    const lines = items.map((d: any, i: number) => {
      const title = d.title || "";
      const time = d.showtime || d.display_time || "";
      const digest = (d.digest || "").slice(0, 100);
      return `${i + 1}. [${time}] ${title}${digest ? `\n   ${digest}` : ""}`;
    });
    return `财经要闻 (最新${items.length}条):\n${lines.join("\n\n")}`;
  } catch {
    // fallback: 东方财富7x24快讯
    const url2 = `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=express&order=1&needInteractData=0&page_index=1&page_size=${pageSize}`;
    const raw = await httpsGet(url2);
    const data = JSON.parse(raw);
    const items = data?.data?.list;
    if (!items?.length) return "暂无快讯";
    const lines = items.map((d: any, i: number) => {
      return `${i + 1}. [${d.showtime || ""}] ${d.title || ""}`;
    });
    return `7x24快讯:\n${lines.join("\n")}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 格式化 & 输出
// ═══════════════════════════════════════════════════════════════════

function formatSpotList(items: SpotItem[], title: string): string {
  if (!items.length) return `${title}: 暂无数据`;
  const header = `${title} (共${items.length}只):\n`;
  const lines = items.map(
    (d, i) =>
      `${String(i + 1).padStart(3)}. ${d.代码} ${d.名称.padEnd(6)} 现价:${fmtPrice(d.最新价)} ${fmtPct(d.涨跌幅)} 成交额:${fmtNum(d.成交额)} 换手:${fmtPct(d.换手率)} PE:${d.市盈率 != null ? d.市盈率.toFixed(1) : "-"}`,
  );
  return header + lines.join("\n");
}

function formatKlineList(items: KlineItem[], title: string): string {
  if (!items.length) return `${title}: 暂无K线数据`;
  // 只展示最近的(最多50条)避免太长
  const show = items.slice(-50);
  const header = `${title} (共${items.length}条, 显示最近${show.length}条):\n日期         开盘     收盘     最高     最低     涨跌幅    成交额        换手率\n`;
  const lines = show.map(
    (d) =>
      `${d.日期}  ${fmtPrice(d.开盘).padStart(8)} ${fmtPrice(d.收盘).padStart(8)} ${fmtPrice(d.最高).padStart(8)} ${fmtPrice(d.最低).padStart(8)} ${fmtPct(d.涨跌幅).padStart(8)} ${fmtNum(d.成交额).padStart(12)} ${fmtPct(d.换手率).padStart(8)}`,
  );
  return header + lines.join("\n");
}

function formatBoardList(items: BoardItem[]): string {
  if (!items.length) return "暂无板块数据";
  const show = items.slice(0, 30);
  const header = `行业板块行情 (共${items.length}个, 显示前${show.length}个):\n`;
  const lines = show.map(
    (d, i) =>
      `${String(i + 1).padStart(3)}. ${d.板块名称.padEnd(8)} ${fmtPct(d.涨跌幅).padStart(8)} 成交额:${fmtNum(d.成交额).padStart(10)} 换手:${fmtPct(d.换手率)} 领涨:${d.领涨股票}(${fmtPct(d.领涨涨跌幅)})`,
  );
  return header + lines.join("\n");
}

function formatNorthFlow(items: NorthFlowItem[]): string {
  if (!items.length) return "暂无北向资金数据";
  const header = `北向资金净流入 (最近${items.length}个交易日):\n日期         沪股通净流入    深股通净流入    北向合计\n`;
  const lines = items.map(
    (d) =>
      `${d.日期}  ${fmtNum(d.沪股通净流入).padStart(14)} ${fmtNum(d.深股通净流入).padStart(14)} ${fmtNum(d.北向资金净流入).padStart(14)}`,
  );
  return header + lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// OpenClaw Plugin 注册
// ═══════════════════════════════════════════════════════════════════

export default {
  id: "akshare",
  name: "AkShare",
  description: "AkShare 兼容的中国金融数据工具集 — A股行情/K线/板块/北向资金/ETF/宏观经济/龙虎榜/新闻",

  register(api: OpenClawPluginApi) {

    // ─── Tool 1: A股实时行情 ───
    api.registerTool({
      name: "akshare_stock_spot",
      description:
        "获取A股实时行情列表 — 最新价、涨跌幅、成交额、换手率、市盈率等。可翻页。对标 akshare.stock_zh_a_spot_em()",
      parameters: Type.Object({
        page: Type.Optional(Type.Number({ description: "页码, 默认1", default: 1 })),
        page_size: Type.Optional(
          Type.Number({ description: "每页数量(1-100), 默认20", default: 20 }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        const page = p.page || 1;
        const ps = Math.min(Math.max(p.page_size || 20, 1), 100);
        const items = await stockZhASpotEm(page, ps);
        return formatSpotList(items, `A股实时行情 (第${page}页)`);
      },
    });

    // ─── Tool 2: A股历史K线 ───
    api.registerTool({
      name: "akshare_stock_hist",
      description:
        "获取个股历史K线数据 — 日K/周K/月K, 支持前复权/后复权。输入股票代码(如 600519 或 000001)。对标 akshare.stock_zh_a_hist()",
      parameters: Type.Object({
        symbol: Type.String({ description: "股票代码, 如 600519, 000001, 300750" }),
        period: Type.Optional(
          Type.String({
            description: "K线周期: daily(日K) weekly(周K) monthly(月K), 默认daily",
            default: "daily",
          }),
        ),
        start_date: Type.Optional(
          Type.String({ description: "开始日期 YYYY-MM-DD, 如 2024-01-01" }),
        ),
        end_date: Type.Optional(
          Type.String({ description: "结束日期 YYYY-MM-DD, 如 2024-12-31" }),
        ),
        adjust: Type.Optional(
          Type.String({
            description: "复权类型: qfq(前复权) hfq(后复权) 空字符串(不复权), 默认qfq",
            default: "qfq",
          }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        const items = await stockZhAHist(
          p.symbol,
          (p.period || "daily") as any,
          p.start_date,
          p.end_date,
          (p.adjust ?? "qfq") as any,
        );
        return formatKlineList(items, `${p.symbol} ${p.period || "daily"} K线`);
      },
    });

    // ─── Tool 3: 个股详情 ───
    api.registerTool({
      name: "akshare_stock_info",
      description:
        "获取个股实时详情 — 最新价、涨跌幅、成交量、市值、PE/PB、52周高低等。输入股票代码。对标 akshare.stock_individual_info_em()",
      parameters: Type.Object({
        symbol: Type.String({ description: "股票代码, 如 600519, 000001" }),
      }),
      execute: async (_id: string, p: any) => {
        return stockIndividualInfoEm(p.symbol);
      },
    });

    // ─── Tool 4: 指数历史K线 ───
    api.registerTool({
      name: "akshare_index_hist",
      description:
        "获取指数历史K线 — 上证指数(000001), 深证成指(399001), 沪深300(000300), 创业板指(399006)等。对标 akshare.index_zh_a_hist()",
      parameters: Type.Object({
        symbol: Type.String({
          description:
            "指数代码: 000001(上证指数) 399001(深证成指) 399006(创业板指) 000300(沪深300) 000016(上证50) 000905(中证500)",
        }),
        period: Type.Optional(
          Type.String({ description: "K线周期: daily/weekly/monthly, 默认daily", default: "daily" }),
        ),
        start_date: Type.Optional(Type.String({ description: "开始日期 YYYY-MM-DD" })),
        end_date: Type.Optional(Type.String({ description: "结束日期 YYYY-MM-DD" })),
      }),
      execute: async (_id: string, p: any) => {
        const items = await indexZhAHist(
          p.symbol,
          (p.period || "daily") as any,
          p.start_date,
          p.end_date,
        );
        const nameMap: Record<string, string> = {
          "000001": "上证指数",
          "399001": "深证成指",
          "399006": "创业板指",
          "000300": "沪深300",
          "000016": "上证50",
          "000905": "中证500",
          "000852": "中证1000",
        };
        const name = nameMap[p.symbol] || p.symbol;
        return formatKlineList(items, `${name} ${p.period || "daily"} K线`);
      },
    });

    // ─── Tool 5: 行业板块行情 ───
    api.registerTool({
      name: "akshare_board_industry",
      description:
        "获取行业板块实时行情 — 涨跌幅排名、成交额、领涨股。对标 akshare.stock_board_industry_name_em()",
      parameters: Type.Object({}),
      execute: async () => {
        const items = await stockBoardIndustryNameEm();
        return formatBoardList(items);
      },
    });

    // ─── Tool 6: 北向资金 ───
    api.registerTool({
      name: "akshare_north_flow",
      description:
        "获取北向资金(沪股通+深股通)净流入数据, 最近30个交易日。对标 akshare.stock_hsgt_north_net_flow_in_em()",
      parameters: Type.Object({}),
      execute: async () => {
        const items = await stockHsgtNorthNetFlowInEm();
        return formatNorthFlow(items);
      },
    });

    // ─── Tool 7: ETF 实时行情 ───
    api.registerTool({
      name: "akshare_etf_spot",
      description:
        "获取ETF基金实时行情列表 — 最新价、涨跌幅、成交额等。对标 akshare.fund_etf_spot_em()",
      parameters: Type.Object({
        page: Type.Optional(Type.Number({ description: "页码, 默认1", default: 1 })),
        page_size: Type.Optional(
          Type.Number({ description: "每页数量(1-100), 默认20", default: 20 }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        const page = p.page || 1;
        const ps = Math.min(Math.max(p.page_size || 20, 1), 100);
        const items = await fundEtfSpotEm(page, ps);
        return formatSpotList(items, `ETF实时行情 (第${page}页)`);
      },
    });

    // ─── Tool 8: 宏观经济数据 ───
    api.registerTool({
      name: "akshare_macro",
      description:
        "获取中国宏观经济数据: CPI(消费者物价指数), PPI(工业品出厂价格指数), PMI(采购经理指数)。对标 akshare.macro_china_cpi/ppi/pmi()",
      parameters: Type.Object({
        indicator: Type.String({
          description: "指标类型: cpi, ppi, pmi",
        }),
      }),
      execute: async (_id: string, p: any) => {
        switch (p.indicator?.toLowerCase()) {
          case "cpi":
            return macroChinaCpi();
          case "ppi":
            return macroChinaPpi();
          case "pmi":
            return macroChinaPmi();
          default:
            return `未知指标: ${p.indicator}。支持: cpi, ppi, pmi`;
        }
      },
    });

    // ─── Tool 9: 龙虎榜 ───
    api.registerTool({
      name: "akshare_lhb",
      description:
        "获取龙虎榜数据 — 上榜个股、净买入额、上榜原因。默认今日, 可指定日期。对标 akshare.stock_lhb_detail_em()",
      parameters: Type.Object({
        date: Type.Optional(
          Type.String({ description: "日期 YYYY-MM-DD, 默认最近交易日" }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        return stockLhbDetailEm(p.date);
      },
    });

    // ─── Tool 10: 财经新闻 ───
    api.registerTool({
      name: "akshare_news",
      description: "获取最新财经要闻和7x24快讯。对标 akshare.stock_news_em()",
      parameters: Type.Object({
        count: Type.Optional(
          Type.Number({ description: "获取条数(1-50), 默认20", default: 20 }),
        ),
      }),
      execute: async (_id: string, p: any) => {
        const count = Math.min(Math.max(p.count || 20, 1), 50);
        return stockNewsEm(count);
      },
    });

    console.log("[akshare] Registered 10 financial data tools (A股行情/K线/板块/北向资金/ETF/宏观/龙虎榜/新闻)");
  },
};
