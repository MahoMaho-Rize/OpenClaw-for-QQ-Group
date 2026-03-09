import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

/* ------------------------------------------------------------------ */
/*  Reddit Plugin                                                      */
/*  Uses Reddit's public JSON API (no auth required)                   */
/*  Routes through WARP SOCKS5 proxy to avoid datacenter IP blocking   */
/* ------------------------------------------------------------------ */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 20_000;

/* ---- SOCKS5 + TLS helper (via WARP proxy) ---- */

const WARP_HOST = "127.0.0.1";
const WARP_PORT = 40000;

function socks5HttpsGet(
  targetHost: string, path: string,
  headers: Record<string, string> = {},
  timeout = 15000
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(WARP_PORT, WARP_HOST, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let step = 0;
    sock.on("data", (data) => {
      if (step === 0) {
        if (data[0] !== 0x05 || data[1] !== 0x00) return reject(new Error("SOCKS5 auth fail"));
        step = 1;
        const buf = Buffer.alloc(7 + targetHost.length);
        buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x03;
        buf[4] = targetHost.length;
        buf.write(targetHost, 5);
        buf.writeUInt16BE(443, 5 + targetHost.length);
        sock.write(buf);
      } else if (step === 1) {
        if (data[0] !== 0x05 || data[1] !== 0x00) return reject(new Error("SOCKS5 connect fail"));
        const tlsSock = tls.connect({ socket: sock, servername: targetHost }, () => {
          const req = https.get({
            hostname: targetHost, path,
            createConnection: () => tlsSock,
            headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
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

/* ---- Convenience wrapper ---- */

function redditGet(path: string): Promise<{ status: number; data: string }> {
  return socks5HttpsGet("www.reddit.com", path, {}, REQUEST_TIMEOUT);
}

/* ---- Helpers ---- */

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function relativeTime(epochSec: number): string {
  const now = Date.now() / 1000;
  const diff = now - epochSec;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}个月前`;
  return `${Math.floor(diff / 31536000)}年前`;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  s = decodeHtmlEntities(s).trim();
  return s.length > max ? s.substring(0, max) + "…" : s;
}

/* ---- Plugin ---- */

const plugin = {
  id: "reddit",
  name: "Reddit",
  description: "Reddit search, hot posts, and post details",

  register(api: OpenClawPluginApi) {
    /* ---- reddit_search ---- */
    api.registerTool({
      name: "reddit_search",
      label: "Reddit 搜索",
      description: `在 Reddit 上搜索帖子。
支持按关键词搜索，可指定 subreddit、排序方式和时间范围。
适用场景：查找 Reddit 上的讨论、评价、经验分享、技术问答等。`,
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        subreddit: Type.Optional(
          Type.String({
            description:
              "限定在某个 subreddit 搜索，如 programming、anime、games。不填则全站搜索",
          })
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "排序方式：relevance（相关度，默认）、hot（热门）、top（最高分）、new（最新）、comments（最多评论）",
          })
        ),
        time: Type.Optional(
          Type.String({
            description:
              "时间范围（sort=top 时有效）：hour、day、week、month、year、all（默认 all）",
          })
        ),
        count: Type.Optional(
          Type.Number({ description: "结果数量（默认 10，最大 25）" })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const query = (params.query as string).trim();
        if (!query) return { error: "需要提供搜索关键词" };

        const subreddit = params.subreddit as string | undefined;
        const sort = (params.sort as string) || "relevance";
        const time = (params.time as string) || "all";
        const count = Math.min(Math.max((params.count as number) || 10, 1), 25);

        const basePath = subreddit
          ? `/r/${encodeURIComponent(subreddit)}/search.json`
          : `/search.json`;

        const searchParams = new URLSearchParams({
          q: query,
          sort,
          t: time,
          limit: String(count),
          restrict_sr: subreddit ? "true" : "false",
        });

        try {
          const res = await redditGet(`${basePath}?${searchParams}`);
          if (res.status === 429) {
            return { error: "Reddit 速率限制，请稍后再试" };
          }
          if (res.status !== 200) {
            return { error: `Reddit 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          const posts = (data?.data?.children || []).map((child: any) => {
            const p = child.data;
            return {
              title: decodeHtmlEntities(p.title || ""),
              subreddit: p.subreddit_name_prefixed || "",
              author: p.author || "[deleted]",
              score: p.score || 0,
              upvote_ratio: p.upvote_ratio || 0,
              comments: p.num_comments || 0,
              url: `https://www.reddit.com${p.permalink}`,
              link_url: p.url_overridden_by_dest || p.url || "",
              selftext: truncate(p.selftext || "", 300),
              created: relativeTime(p.created_utc || 0),
              flair: p.link_flair_text || "",
              is_nsfw: p.over_18 || false,
            };
          });

          console.log(`[reddit] search "${query}" → ${posts.length} results`);

          return {
            query,
            subreddit: subreddit || "全站",
            result_count: posts.length,
            posts,
            数据来源: "Reddit",
          };
        } catch (err) {
          return { error: `Reddit 搜索失败: ${String(err)}` };
        }
      },
    });

    /* ---- reddit_hot ---- */
    api.registerTool({
      name: "reddit_hot",
      label: "Reddit 热帖",
      description: `获取 Reddit 某个 subreddit 的热门帖子。
不指定 subreddit 则返回 Reddit 首页热帖。
适用场景：了解某个社区的当前热门话题。`,
      parameters: Type.Object({
        subreddit: Type.Optional(
          Type.String({
            description:
              "subreddit 名称，如 worldnews、programming、anime。不填则首页热帖",
          })
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "排序：hot（热门，默认）、new（最新）、top（最高分）、rising（上升中）",
          })
        ),
        time: Type.Optional(
          Type.String({
            description:
              "时间范围（sort=top 时有效）：hour、day、week、month、year、all",
          })
        ),
        count: Type.Optional(
          Type.Number({ description: "数量（默认 10，最大 25）" })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const subreddit = params.subreddit as string | undefined;
        const sort = (params.sort as string) || "hot";
        const time = (params.time as string) || "day";
        const count = Math.min(Math.max((params.count as number) || 10, 1), 25);

        const basePath = subreddit
          ? `/r/${encodeURIComponent(subreddit)}/${sort}.json`
          : `/${sort}.json`;

        const searchParams = new URLSearchParams({
          limit: String(count),
          t: time,
        });

        try {
          const res = await redditGet(`${basePath}?${searchParams}`);
          if (res.status === 429) {
            return { error: "Reddit 速率限制，请稍后再试" };
          }
          if (res.status !== 200) {
            return { error: `Reddit 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          const posts = (data?.data?.children || []).map((child: any) => {
            const p = child.data;
            return {
              title: decodeHtmlEntities(p.title || ""),
              subreddit: p.subreddit_name_prefixed || "",
              author: p.author || "[deleted]",
              score: p.score || 0,
              comments: p.num_comments || 0,
              url: `https://www.reddit.com${p.permalink}`,
              selftext: truncate(p.selftext || "", 200),
              created: relativeTime(p.created_utc || 0),
              flair: p.link_flair_text || "",
            };
          });

          console.log(
            `[reddit] ${sort} r/${subreddit || "frontpage"} → ${posts.length} posts`
          );

          return {
            subreddit: subreddit ? `r/${subreddit}` : "首页",
            sort,
            result_count: posts.length,
            posts,
            数据来源: "Reddit",
          };
        } catch (err) {
          return { error: `获取热帖失败: ${String(err)}` };
        }
      },
    });

    /* ---- reddit_post ---- */
    api.registerTool({
      name: "reddit_post",
      label: "Reddit 帖子详情",
      description: `获取 Reddit 某个帖子的详情和热门评论。
需要提供帖子 URL 或 subreddit + post ID。
适用场景：深入阅读某个 Reddit 讨论帖及其评论。`,
      parameters: Type.Object({
        url: Type.Optional(
          Type.String({
            description:
              "Reddit 帖子完整 URL，如 https://www.reddit.com/r/xxx/comments/xxx/...",
          })
        ),
        subreddit: Type.Optional(
          Type.String({ description: "subreddit 名称（与 post_id 配合使用）" })
        ),
        post_id: Type.Optional(
          Type.String({ description: "帖子 ID（与 subreddit 配合使用）" })
        ),
        comment_count: Type.Optional(
          Type.Number({
            description: "返回的热门评论数量（默认 10，最大 30）",
          })
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "评论排序：best（最佳，默认）、top（最高分）、new（最新）、controversial（争议）",
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        let postPath: string;

        if (params.url) {
          let raw = (params.url as string).trim();
          // Normalize URL — strip domain, keep path
          raw = raw.replace(/^https?:\/\/(www\.|old\.|new\.|np\.)?reddit\.com/, "");
          raw = raw.replace(/\?.*$/, "");
          if (!raw.endsWith("/")) raw += "/";
          postPath = raw + ".json";
        } else if (params.subreddit && params.post_id) {
          postPath = `/r/${params.subreddit}/comments/${params.post_id}/.json`;
        } else {
          return { error: "需要提供 url 或 subreddit + post_id" };
        }

        const commentCount = Math.min(
          Math.max((params.comment_count as number) || 10, 1),
          30
        );
        const sort = (params.sort as string) || "best";

        const separator = postPath.includes("?") ? "&" : "?";
        const fetchPath = `${postPath}${separator}sort=${sort}&limit=${commentCount}`;

        try {
          const res = await redditGet(fetchPath);
          if (res.status === 429) {
            return { error: "Reddit 速率限制，请稍后再试" };
          }
          if (res.status !== 200) {
            return { error: `Reddit 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          if (!Array.isArray(data) || data.length < 2) {
            return { error: "无法解析帖子数据" };
          }

          // Post info
          const postData = data[0]?.data?.children?.[0]?.data;
          if (!postData) return { error: "帖子不存在或已删除" };

          const post = {
            title: decodeHtmlEntities(postData.title || ""),
            subreddit: postData.subreddit_name_prefixed || "",
            author: postData.author || "[deleted]",
            score: postData.score || 0,
            upvote_ratio: postData.upvote_ratio || 0,
            total_comments: postData.num_comments || 0,
            selftext: truncate(postData.selftext || "", 2000),
            link_url: postData.url_overridden_by_dest || "",
            created: relativeTime(postData.created_utc || 0),
            flair: postData.link_flair_text || "",
            is_nsfw: postData.over_18 || false,
          };

          // Comments
          const commentChildren = data[1]?.data?.children || [];
          const comments = commentChildren
            .filter((c: any) => c.kind === "t1")
            .slice(0, commentCount)
            .map((c: any) => {
              const cd = c.data;
              return {
                author: cd.author || "[deleted]",
                score: cd.score || 0,
                body: truncate(cd.body || "", 500),
                created: relativeTime(cd.created_utc || 0),
                is_op: cd.is_submitter || false,
                replies: cd.replies?.data?.children
                  ? cd.replies.data.children
                      .filter((r: any) => r.kind === "t1")
                      .slice(0, 3)
                      .map((r: any) => ({
                        author: r.data.author || "[deleted]",
                        score: r.data.score || 0,
                        body: truncate(r.data.body || "", 300),
                        created: relativeTime(r.data.created_utc || 0),
                      }))
                  : [],
              };
            });

          console.log(
            `[reddit] post "${post.title.substring(0, 40)}" → ${comments.length} comments`
          );

          return {
            post,
            comment_count: comments.length,
            comments,
            数据来源: "Reddit",
          };
        } catch (err) {
          return { error: `获取帖子失败: ${String(err)}` };
        }
      },
    });

    /* ---- reddit_subreddit ---- */
    api.registerTool({
      name: "reddit_subreddit",
      label: "Reddit 社区信息",
      description: `获取 Reddit 某个 subreddit 的基本信息。
适用场景：了解某个 Reddit 社区的规模、描述、规则等。`,
      parameters: Type.Object({
        subreddit: Type.String({
          description: "subreddit 名称，如 programming、anime、worldnews",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const subreddit = (params.subreddit as string).trim();
        if (!subreddit) return { error: "需要提供 subreddit 名称" };

        try {
          const res = await redditGet(
            `/r/${encodeURIComponent(subreddit)}/about.json`
          );
          if (res.status === 429) {
            return { error: "Reddit 速率限制，请稍后再试" };
          }
          if (res.status !== 200) {
            return { error: `Reddit 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          const d = data?.data;
          if (!d) return { error: "subreddit 不存在" };

          return {
            name: d.display_name_prefixed || `r/${subreddit}`,
            title: d.title || "",
            description: truncate(d.public_description || d.description || "", 500),
            subscribers: d.subscribers || 0,
            active_users: d.accounts_active || 0,
            created: relativeTime(d.created_utc || 0),
            is_nsfw: d.over18 || false,
            url: `https://www.reddit.com/r/${subreddit}`,
            数据来源: "Reddit",
          };
        } catch (err) {
          return { error: `获取社区信息失败: ${String(err)}` };
        }
      },
    });

    console.log(
      "[reddit] Registered 4 tools: reddit_search, reddit_hot, reddit_post, reddit_subreddit"
    );
  },
};

export default plugin;
