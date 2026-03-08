import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  Finance Plugin                                                      */
/*  Frankfurter exchange rates + CryptoCompare crypto prices            */
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

/* Currency name mapping */
const CURRENCY_NAMES: Record<string, string> = {
  CNY: "人民币", USD: "美元", EUR: "欧元", JPY: "日元", GBP: "英镑",
  KRW: "韩元", HKD: "港币", TWD: "新台币", SGD: "新加坡元", AUD: "澳元",
  CAD: "加元", CHF: "瑞士法郎", RUB: "卢布", INR: "印度卢比", THB: "泰铢",
  MYR: "马来西亚林吉特", PHP: "菲律宾比索", IDR: "印尼盾", VND: "越南盾",
  BRL: "巴西雷亚尔", MXN: "墨西哥比索", SEK: "瑞典克朗", NOK: "挪威克朗",
  DKK: "丹麦克朗", NZD: "新西兰元", ZAR: "南非兰特", TRY: "土耳其里拉",
  PLN: "波兰兹罗提", CZK: "捷克克朗", HUF: "匈牙利福林", RON: "罗马尼亚列伊",
  BGN: "保加利亚列弗", ISK: "冰岛克朗", ILS: "以色列谢克尔",
};

/* Chinese alias → ISO code */
const CN_TO_ISO: Record<string, string> = {
  "人民币": "CNY", "美元": "USD", "欧元": "EUR", "日元": "JPY", "英镑": "GBP",
  "韩元": "KRW", "港币": "HKD", "港元": "HKD", "新台币": "TWD", "台币": "TWD",
  "新加坡元": "SGD", "澳元": "AUD", "加元": "CAD", "瑞郎": "CHF", "瑞士法郎": "CHF",
  "卢布": "RUB", "俄罗斯卢布": "RUB", "印度卢比": "INR", "泰铢": "THB",
  "马来西亚林吉特": "MYR", "林吉特": "MYR", "比索": "PHP",
  "越南盾": "VND", "巴西雷亚尔": "BRL", "墨西哥比索": "MXN",
  "瑞典克朗": "SEK", "挪威克朗": "NOK", "丹麦克朗": "DKK",
  "新西兰元": "NZD", "南非兰特": "ZAR", "土耳其里拉": "TRY", "里拉": "TRY",
  "元": "CNY", "块": "CNY", "刀": "USD", "刀乐": "USD",
};

function resolveCurrency(input: string): string {
  const upper = input.trim().toUpperCase();
  if (CURRENCY_NAMES[upper]) return upper;
  const cn = CN_TO_ISO[input.trim()];
  if (cn) return cn;
  return upper;
}

const plugin = {
  id: "finance",
  name: "Finance",
  description: "汇率查询 + 加密货币价格",

  register(api: OpenClawPluginApi) {
    /* ---- exchange_rate ---- */
    api.registerTool({
      name: "exchange_rate",
      label: "汇率查询",
      description: `查询实时汇率（Frankfurter，欧央行数据源）。
支持中文货币名和ISO代码，可换算金额。

使用场景：
- "日元兑人民币多少"
- "1000美元换多少人民币"
- "今天欧元汇率"`,
      parameters: Type.Object({
        from: Type.String({ description: "源货币（如 USD、美元、日元、JPY）" }),
        to: Type.Optional(Type.String({ description: "目标货币（默认 CNY）" })),
        amount: Type.Optional(Type.Number({ description: "换算金额（默认1）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const from = resolveCurrency(String(params.from || "USD"));
        const to = resolveCurrency(String(params.to || "CNY"));
        const amount = Number(params.amount) || 1;

        try {
          const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}&amount=${amount}`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `Frankfurter HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          const rate = data.rates?.[to];
          return {
            from: `${from} (${CURRENCY_NAMES[from] || from})`,
            to: `${to} (${CURRENCY_NAMES[to] || to})`,
            amount,
            result: rate,
            rate_per_unit: amount === 1 ? rate : (rate / amount),
            date: data.date,
            source: "European Central Bank via Frankfurter",
          };
        } catch (err) {
          return { error: `汇率查询失败: ${String(err)}` };
        }
      },
    });

    /* ---- crypto_price ---- */
    api.registerTool({
      name: "crypto_price",
      label: "加密货币价格",
      description: `查询加密货币实时价格（CryptoCompare）。
支持 BTC、ETH、SOL、DOGE 等主流币种。

使用场景：
- "比特币现在多少钱"
- "以太坊价格"
- "狗狗币多少美元"`,
      parameters: Type.Object({
        symbol: Type.String({ description: "币种符号（如 BTC、ETH、SOL、DOGE、XRP）" }),
        currency: Type.Optional(Type.String({ description: "计价货币（默认 USD，支持 CNY/JPY/EUR 等）" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const CN_CRYPTO: Record<string, string> = {
          "比特币": "BTC", "以太坊": "ETH", "以太": "ETH", "狗狗币": "DOGE",
          "莱特币": "LTC", "瑞波": "XRP", "索拉纳": "SOL", "柴犬币": "SHIB",
          "泰达": "USDT", "币安币": "BNB",
        };
        let sym = String(params.symbol || "BTC").trim();
        if (CN_CRYPTO[sym]) sym = CN_CRYPTO[sym];
        sym = sym.toUpperCase();

        const cur = resolveCurrency(String(params.currency || "USD"));

        try {
          const url = `https://min-api.cryptocompare.com/data/price?fsym=${sym}&tsyms=${cur},USD`;
          const res = await httpGet(url);
          if (res.status !== 200) return { error: `CryptoCompare HTTP ${res.status}` };
          const data = JSON.parse(res.data);

          if (data.Response === "Error") return { error: data.Message || "未知错误" };

          return {
            symbol: sym,
            prices: Object.entries(data).map(([k, v]) => ({
              currency: `${k} (${CURRENCY_NAMES[k] || k})`,
              price: v,
            })),
          };
        } catch (err) {
          return { error: `加密货币查询失败: ${String(err)}` };
        }
      },
    });

    console.log("[finance] Registered exchange_rate + crypto_price tools");
  },
};

export default plugin;
