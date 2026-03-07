import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import https from "node:https";

// ───── Bilibili API helpers ─────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function biliGet(path: string, timeout = 15000): Promise<any> {
  const url = new URL(path, "https://api.bilibili.com");
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        family: 4,
        headers: {
          "User-Agent": UA,
          Referer: "https://www.bilibili.com",
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (body.code !== 0) {
              reject(new Error(`Bilibili API error ${body.code}: ${body.message || ""}`));
            } else {
              resolve(body.data);
            }
          } catch (e) {
            reject(new Error("Bilibili API: invalid JSON response"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Bilibili API timeout")); });
  });
}

// ───── Formatters ─────

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "");
}

function formatDuration(d: number | string): string {
  if (typeof d === "string") {
    // "4:20" format from search
    return d;
  }
  const m = Math.floor(d / 60);
  const s = d % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatCount(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function formatSearchResult(r: any, idx: number): string {
  const title = stripHtmlTags(r.title || "");
  const author = r.author || "未知UP主";
  const play = formatCount(r.play || 0);
  const danmaku = formatCount(r.danmaku || 0);
  const duration = r.duration || "未知";
  const bvid = r.bvid || "";
  const aid = r.aid || "";
  const desc = (r.description || "").slice(0, 120);
  return [
    `${idx}. ${title}`,
    `   UP主: ${author} | 播放: ${play} | 弹幕: ${danmaku} | 时长: ${duration}`,
    `   BV号: ${bvid} | AV号: ${aid}`,
    desc ? `   简介: ${desc}` : "",
  ].filter(Boolean).join("\n");
}

function formatVideoDetail(d: any): string {
  const title = d.title || "未知";
  const owner = d.owner ? `${d.owner.name} (UID:${d.owner.mid})` : "未知";
  const stat = d.stat || {};
  const lines = [
    `标题: ${title}`,
    d.bvid ? `BV号: ${d.bvid}` : "",
    d.aid ? `AV号: ${d.aid}` : "",
    `UP主: ${owner}`,
    `发布时间: ${d.pubdate ? formatTimestamp(d.pubdate) : "未知"}`,
    `时长: ${formatDuration(d.duration || 0)}`,
    `播放: ${formatCount(stat.view || 0)} | 弹幕: ${formatCount(stat.danmaku || 0)} | 评论: ${formatCount(stat.reply || 0)}`,
    `点赞: ${formatCount(stat.like || 0)} | 投币: ${formatCount(stat.coin || 0)} | 收藏: ${formatCount(stat.favorite || 0)} | 分享: ${formatCount(stat.share || 0)}`,
    d.desc && d.desc !== "-" ? `简介: ${d.desc.slice(0, 500)}` : "",
    d.tname ? `分区: ${d.tname}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function formatComment(c: any, indent = ""): string {
  const name = c.member?.uname || "匿名";
  const content = c.content?.message || "";
  const like = c.like || 0;
  const time = c.ctime ? formatTimestamp(c.ctime) : "";
  const replies = c.rcount || 0;
  return [
    `${indent}${name} (${time}) 👍${like}${replies > 0 ? ` 💬${replies}条回复` : ""}`,
    `${indent}  ${content.slice(0, 300)}`,
  ].join("\n");
}

// ───── Plugin ─────

export default {
  id: "bilibili",
  name: "Bilibili",
  description: "Bilibili视频搜索与评论获取",
  register(api: OpenClawPluginApi) {

    // ─── Action 1: 视频搜索 ───
    api.registerTool({
      name: "bilibili_search",
      description: "在Bilibili搜索视频。返回标题、UP主、播放量、BV号等。使用BV号可进一步获取详情或评论。",
      parameters: Type.Object({
        keyword: Type.String({ description: "搜索关键词" }),
        page: Type.Optional(Type.Number({ description: "页码，默认1", default: 1 })),
        page_size: Type.Optional(Type.Number({ description: "每页结果数(1-20)，默认10", default: 10 })),
        order: Type.Optional(Type.String({
          description: "排序方式: totalrank(综合) click(播放) pubdate(发布时间) dm(弹幕) stow(收藏)，默认totalrank",
          default: "totalrank",
        })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const { keyword, page = 1, page_size = 10, order = "totalrank" } = params;
        if (!keyword?.trim()) return "请提供搜索关键词";
        const ps = Math.min(Math.max(page_size, 1), 20);
        const encoded = encodeURIComponent(keyword.trim());
        const data = await biliGet(
          `/x/web-interface/wbi/search/type?search_type=video&keyword=${encoded}&page=${page}&page_size=${ps}&order=${order}`,
        );
        const results = data?.result;
        if (!results?.length) return `未找到与"${keyword}"相关的视频`;
        const total = data.numResults || data.numPages * ps || results.length;
        const header = `Bilibili搜索"${keyword}" (共约${formatCount(total)}个结果, 第${page}页):\n`;
        return header + results.map((r: any, i: number) => formatSearchResult(r, (page - 1) * ps + i + 1)).join("\n\n");
      },
    });

    // ─── Action 2: 视频详情 ───
    api.registerTool({
      name: "bilibili_video",
      description: "获取Bilibili视频详情(标题、UP主、播放量、简介等)。支持BV号或AV号。",
      parameters: Type.Object({
        bvid: Type.Optional(Type.String({ description: "视频BV号，如 BV1GJ411x7h7" })),
        aid: Type.Optional(Type.Number({ description: "视频AV号(数字)" })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const { bvid, aid } = params;
        if (!bvid && !aid) return "请提供BV号或AV号";
        const query = bvid ? `bvid=${bvid}` : `aid=${aid}`;
        const data = await biliGet(`/x/web-interface/view?${query}`);
        return formatVideoDetail(data);
      },
    });

    // ─── Action 3: 获取评论 ───
    api.registerTool({
      name: "bilibili_comments",
      description: "获取Bilibili视频的评论。需要AV号(aid)或BV号。返回评论内容、点赞数、回复数。sort: 0=时间 1=点赞 2=回复数",
      parameters: Type.Object({
        bvid: Type.Optional(Type.String({ description: "视频BV号。会自动转换为AV号" })),
        aid: Type.Optional(Type.Number({ description: "视频AV号(数字)。优先使用" })),
        sort: Type.Optional(Type.Number({ description: "排序: 0=时间 1=点赞 2=回复数，默认1(点赞)", default: 1 })),
        page: Type.Optional(Type.Number({ description: "页码，默认1", default: 1 })),
        page_size: Type.Optional(Type.Number({ description: "每页条数(1-20)，默认10", default: 10 })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        let { bvid, aid, sort = 1, page = 1, page_size = 10 } = params;
        if (!bvid && !aid) return "请提供BV号或AV号";

        // If only bvid, resolve to aid first
        if (!aid && bvid) {
          const detail = await biliGet(`/x/web-interface/view?bvid=${bvid}`);
          aid = detail?.aid;
          if (!aid) return `无法获取BV号 ${bvid} 对应的AV号`;
        }

        const ps = Math.min(Math.max(page_size, 1), 20);
        const data = await biliGet(
          `/x/v2/reply?type=1&oid=${aid}&sort=${sort}&pn=${page}&ps=${ps}`,
        );
        const replies = data?.replies;
        if (!replies?.length) return "该视频暂无评论，或评论区已关闭";
        const total = data.page?.count || 0;
        const sortNames: Record<number, string> = { 0: "时间", 1: "点赞", 2: "回复数" };
        const header = `评论 (共${formatCount(total)}条, 按${sortNames[sort] || "默认"}排序, 第${page}页):\n`;
        const formatted = replies.map((c: any) => formatComment(c)).join("\n\n");
        return header + formatted;
      },
    });

    // ─── Action 4: 获取评论回复 ───
    api.registerTool({
      name: "bilibili_replies",
      description: "获取Bilibili某条评论的回复(楼中楼)。需要AV号和根评论ID(rpid)。",
      parameters: Type.Object({
        aid: Type.Number({ description: "视频AV号(数字)" }),
        rpid: Type.Number({ description: "根评论ID(从bilibili_comments结果中获取)" }),
        page: Type.Optional(Type.Number({ description: "页码，默认1", default: 1 })),
        page_size: Type.Optional(Type.Number({ description: "每页条数(1-10)，默认10", default: 10 })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const { aid, rpid, page = 1, page_size = 10 } = params;
        const ps = Math.min(Math.max(page_size, 1), 10);
        const data = await biliGet(
          `/x/v2/reply/reply?type=1&oid=${aid}&root=${rpid}&pn=${page}&ps=${ps}`,
        );
        const replies = data?.replies;
        if (!replies?.length) return "该评论暂无回复";
        const total = data.page?.count || 0;
        const header = `评论回复 (共${total}条, 第${page}页):\n`;
        const formatted = replies.map((c: any) => formatComment(c, "  ")).join("\n\n");
        return header + formatted;
      },
    });

    // ─── Action 5: 热门评论/评论搜索 ───
    api.registerTool({
      name: "bilibili_hot_comments",
      description: "获取Bilibili视频的热门评论(按点赞排序前N条)。快捷方式，等同于bilibili_comments sort=1。",
      parameters: Type.Object({
        bvid: Type.Optional(Type.String({ description: "视频BV号" })),
        aid: Type.Optional(Type.Number({ description: "视频AV号(数字)" })),
        count: Type.Optional(Type.Number({ description: "获取条数(1-20)，默认5", default: 5 })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        let { bvid, aid, count = 5 } = params;
        if (!bvid && !aid) return "请提供BV号或AV号";
        if (!aid && bvid) {
          const detail = await biliGet(`/x/web-interface/view?bvid=${bvid}`);
          aid = detail?.aid;
          if (!aid) return `无法获取BV号 ${bvid} 对应的AV号`;
        }
        const ps = Math.min(Math.max(count, 1), 20);
        const data = await biliGet(`/x/v2/reply?type=1&oid=${aid}&sort=1&pn=1&ps=${ps}`);
        const replies = data?.replies;
        if (!replies?.length) return "该视频暂无评论";
        const total = data.page?.count || 0;
        const header = `热门评论 Top${ps} (共${formatCount(total)}条评论):\n`;
        return header + replies.map((c: any) => formatComment(c)).join("\n\n");
      },
    });
  },
};
