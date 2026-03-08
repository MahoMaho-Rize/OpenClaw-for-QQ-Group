import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  GitHub Plugin                                                      */
/*  Uses GitHub's public REST API (no token, 60 req/hr rate limit)     */
/* ------------------------------------------------------------------ */

const API_BASE = "https://api.github.com";
const USER_AGENT = "OpenClaw-Bot/1.0";
const REQUEST_TIMEOUT = 20_000;

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
            Accept: "application/vnd.github+json",
            "Accept-Encoding": "gzip, deflate",
            "X-GitHub-Api-Version": "2022-11-28",
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

function relativeTime(isoDate: string): string {
  const diff = (Date.now() - new Date(isoDate).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}个月前`;
  return `${Math.floor(diff / 31536000)}年前`;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.substring(0, max) + "…" : s;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/* ---- Plugin ---- */

const plugin = {
  id: "github",
  name: "GitHub",
  description: "GitHub repository search, issues, and user profiles",

  register(api: OpenClawPluginApi) {
    /* ---- github_search ---- */
    api.registerTool({
      name: "github_search",
      label: "GitHub 仓库搜索",
      description: `在 GitHub 上搜索仓库/代码项目。
支持按关键词、语言、排序方式搜索。
适用场景：查找开源项目、工具库、框架、技术方案等。`,
      parameters: Type.Object({
        query: Type.String({
          description:
            "搜索关键词。支持 GitHub 搜索语法，如 language:python、stars:>1000、topic:machine-learning",
        }),
        language: Type.Optional(
          Type.String({
            description: "编程语言筛选，如 python、javascript、rust、go",
          })
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "排序方式：stars（星标数）、forks（分叉数）、updated（更新时间）、help-wanted-issues。默认按相关度",
          })
        ),
        order: Type.Optional(
          Type.String({
            description: "排序方向：desc（降序，默认）、asc（升序）",
          })
        ),
        count: Type.Optional(
          Type.Number({ description: "结果数量（默认 10，最大 30）" })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        let query = (params.query as string).trim();
        if (!query) return { error: "需要提供搜索关键词" };

        const language = params.language as string | undefined;
        if (language) query += ` language:${language}`;

        const sort = (params.sort as string) || "";
        const order = (params.order as string) || "desc";
        const count = Math.min(Math.max((params.count as number) || 10, 1), 30);

        const searchParams = new URLSearchParams({
          q: query,
          per_page: String(count),
          order,
        });
        if (sort) searchParams.set("sort", sort);

        try {
          const res = await httpGet(
            `${API_BASE}/search/repositories?${searchParams}`,
            { timeout: REQUEST_TIMEOUT }
          );

          if (res.status === 403) {
            return { error: "GitHub API 速率限制（每小时 60 次），请稍后再试" };
          }
          if (res.status !== 200) {
            return { error: `GitHub 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          const repos = (data.items || []).map((r: any, i: number) => ({
            index: i + 1,
            name: r.full_name,
            description: truncate(r.description || "", 200),
            language: r.language || "未知",
            stars: formatNumber(r.stargazers_count || 0),
            forks: formatNumber(r.forks_count || 0),
            open_issues: r.open_issues_count || 0,
            url: r.html_url,
            topics: (r.topics || []).slice(0, 5),
            updated: relativeTime(r.updated_at || r.pushed_at || ""),
            license: r.license?.spdx_id || "无",
          }));

          console.log(`[github] search "${query}" → ${repos.length} repos`);

          return {
            query,
            total_count: formatNumber(data.total_count || 0),
            result_count: repos.length,
            repos,
            数据来源: "GitHub",
          };
        } catch (err) {
          return { error: `GitHub 搜索失败: ${String(err)}` };
        }
      },
    });

    /* ---- github_repo ---- */
    api.registerTool({
      name: "github_repo",
      label: "GitHub 仓库详情",
      description: `获取 GitHub 某个仓库的详细信息，包括描述、星标、最近活动等。
需要提供仓库的 owner/name 格式。
适用场景：了解某个开源项目的详细情况。`,
      parameters: Type.Object({
        repo: Type.String({
          description:
            "仓库全名（owner/name），如 torvalds/linux、microsoft/vscode、python/cpython",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const repo = (params.repo as string).trim();
        if (!repo || !repo.includes("/")) {
          return { error: "请提供 owner/name 格式的仓库名，如 torvalds/linux" };
        }

        try {
          // Fetch repo info and recent commits in parallel
          const [repoRes, commitsRes, releasesRes] = await Promise.all([
            httpGet(`${API_BASE}/repos/${repo}`, { timeout: REQUEST_TIMEOUT }),
            httpGet(`${API_BASE}/repos/${repo}/commits?per_page=5`, {
              timeout: REQUEST_TIMEOUT,
            }).catch(() => null),
            httpGet(`${API_BASE}/repos/${repo}/releases?per_page=3`, {
              timeout: REQUEST_TIMEOUT,
            }).catch(() => null),
          ]);

          if (repoRes.status === 403) {
            return { error: "GitHub API 速率限制，请稍后再试" };
          }
          if (repoRes.status === 404) {
            return { error: `仓库 ${repo} 不存在` };
          }
          if (repoRes.status !== 200) {
            return { error: `GitHub 返回 HTTP ${repoRes.status}` };
          }

          const r = JSON.parse(repoRes.data);

          const result: Record<string, unknown> = {
            name: r.full_name,
            description: r.description || "",
            language: r.language || "未知",
            stars: formatNumber(r.stargazers_count || 0),
            forks: formatNumber(r.forks_count || 0),
            watchers: formatNumber(r.subscribers_count || 0),
            open_issues: r.open_issues_count || 0,
            url: r.html_url,
            homepage: r.homepage || "",
            license: r.license?.spdx_id || "无",
            topics: r.topics || [],
            default_branch: r.default_branch || "main",
            created: relativeTime(r.created_at || ""),
            updated: relativeTime(r.updated_at || ""),
            pushed: relativeTime(r.pushed_at || ""),
            is_fork: r.fork || false,
            is_archived: r.archived || false,
            size_kb: r.size || 0,
          };

          // Recent commits
          if (commitsRes && commitsRes.status === 200) {
            try {
              const commits = JSON.parse(commitsRes.data);
              result.recent_commits = commits.slice(0, 5).map((c: any) => ({
                message: truncate(c.commit?.message || "", 100),
                author: c.commit?.author?.name || c.author?.login || "unknown",
                date: relativeTime(c.commit?.author?.date || ""),
                sha: (c.sha || "").substring(0, 7),
              }));
            } catch {}
          }

          // Recent releases
          if (releasesRes && releasesRes.status === 200) {
            try {
              const releases = JSON.parse(releasesRes.data);
              if (releases.length > 0) {
                result.recent_releases = releases.slice(0, 3).map((rel: any) => ({
                  tag: rel.tag_name || "",
                  name: rel.name || "",
                  date: relativeTime(rel.published_at || ""),
                  prerelease: rel.prerelease || false,
                }));
              }
            } catch {}
          }

          result["数据来源"] = "GitHub";

          console.log(`[github] repo "${repo}" → OK`);
          return result;
        } catch (err) {
          return { error: `获取仓库信息失败: ${String(err)}` };
        }
      },
    });

    /* ---- github_issues ---- */
    api.registerTool({
      name: "github_issues",
      label: "GitHub Issues",
      description: `获取 GitHub 某个仓库的 Issues 列表。
适用场景：查看某个项目的 bug 报告、功能请求、讨论等。`,
      parameters: Type.Object({
        repo: Type.String({
          description: "仓库全名（owner/name），如 facebook/react",
        }),
        state: Type.Optional(
          Type.String({
            description: "状态筛选：open（开放，默认）、closed（已关闭）、all（全部）",
          })
        ),
        labels: Type.Optional(
          Type.String({
            description: "标签筛选（逗号分隔），如 bug、enhancement、help wanted",
          })
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "排序：created（创建时间，默认）、updated（更新时间）、comments（评论数）",
          })
        ),
        query: Type.Optional(
          Type.String({ description: "在 issue 标题中搜索关键词" })
        ),
        count: Type.Optional(
          Type.Number({ description: "数量（默认 10，最大 30）" })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const repo = (params.repo as string).trim();
        if (!repo || !repo.includes("/")) {
          return { error: "请提供 owner/name 格式的仓库名" };
        }

        const state = (params.state as string) || "open";
        const sort = (params.sort as string) || "created";
        const count = Math.min(Math.max((params.count as number) || 10, 1), 30);
        const labels = (params.labels as string) || "";
        const query = (params.query as string) || "";

        // If query is provided, use search API
        if (query) {
          const q = `${query} repo:${repo} is:issue state:${state}${labels ? ` label:${labels}` : ""}`;
          const searchParams = new URLSearchParams({
            q,
            sort: sort === "created" ? "created" : sort,
            order: "desc",
            per_page: String(count),
          });

          try {
            const res = await httpGet(
              `${API_BASE}/search/issues?${searchParams}`,
              { timeout: REQUEST_TIMEOUT }
            );
            if (res.status === 403) {
              return { error: "GitHub API 速率限制，请稍后再试" };
            }
            if (res.status !== 200) {
              return { error: `GitHub 返回 HTTP ${res.status}` };
            }

            const data = JSON.parse(res.data);
            const issues = (data.items || []).map((i: any, idx: number) => ({
              index: idx + 1,
              number: i.number,
              title: i.title || "",
              state: i.state,
              author: i.user?.login || "unknown",
              comments: i.comments || 0,
              labels: (i.labels || []).map((l: any) => l.name),
              created: relativeTime(i.created_at || ""),
              updated: relativeTime(i.updated_at || ""),
              url: i.html_url,
            }));

            return {
              repo,
              query,
              result_count: issues.length,
              issues,
              数据来源: "GitHub",
            };
          } catch (err) {
            return { error: `搜索 Issues 失败: ${String(err)}` };
          }
        }

        // Otherwise list issues
        const listParams = new URLSearchParams({
          state,
          sort,
          direction: "desc",
          per_page: String(count),
        });
        if (labels) listParams.set("labels", labels);

        try {
          const res = await httpGet(
            `${API_BASE}/repos/${repo}/issues?${listParams}`,
            { timeout: REQUEST_TIMEOUT }
          );
          if (res.status === 403) {
            return { error: "GitHub API 速率限制，请稍后再试" };
          }
          if (res.status === 404) {
            return { error: `仓库 ${repo} 不存在` };
          }
          if (res.status !== 200) {
            return { error: `GitHub 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          // Filter out pull requests (they also appear in issues endpoint)
          const issues = data
            .filter((i: any) => !i.pull_request)
            .slice(0, count)
            .map((i: any, idx: number) => ({
              index: idx + 1,
              number: i.number,
              title: i.title || "",
              state: i.state,
              author: i.user?.login || "unknown",
              comments: i.comments || 0,
              labels: (i.labels || []).map((l: any) => l.name),
              created: relativeTime(i.created_at || ""),
              updated: relativeTime(i.updated_at || ""),
              url: i.html_url,
              body: truncate(i.body || "", 200),
            }));

          console.log(`[github] issues ${repo} → ${issues.length} issues`);

          return {
            repo,
            state,
            result_count: issues.length,
            issues,
            数据来源: "GitHub",
          };
        } catch (err) {
          return { error: `获取 Issues 失败: ${String(err)}` };
        }
      },
    });

    /* ---- github_user ---- */
    api.registerTool({
      name: "github_user",
      label: "GitHub 用户信息",
      description: `获取 GitHub 用户或组织的公开信息。
适用场景：了解某个开发者或组织的 GitHub 活动情况。`,
      parameters: Type.Object({
        username: Type.String({
          description: "GitHub 用户名，如 torvalds、octocat",
        }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const username = (params.username as string).trim();
        if (!username) return { error: "需要提供用户名" };

        try {
          const [userRes, reposRes] = await Promise.all([
            httpGet(`${API_BASE}/users/${encodeURIComponent(username)}`, {
              timeout: REQUEST_TIMEOUT,
            }),
            httpGet(
              `${API_BASE}/users/${encodeURIComponent(username)}/repos?sort=stars&direction=desc&per_page=5`,
              { timeout: REQUEST_TIMEOUT }
            ).catch(() => null),
          ]);

          if (userRes.status === 403) {
            return { error: "GitHub API 速率限制，请稍后再试" };
          }
          if (userRes.status === 404) {
            return { error: `用户 ${username} 不存在` };
          }
          if (userRes.status !== 200) {
            return { error: `GitHub 返回 HTTP ${userRes.status}` };
          }

          const u = JSON.parse(userRes.data);

          const result: Record<string, unknown> = {
            username: u.login,
            name: u.name || "",
            type: u.type || "User",
            bio: u.bio || "",
            company: u.company || "",
            location: u.location || "",
            blog: u.blog || "",
            public_repos: u.public_repos || 0,
            public_gists: u.public_gists || 0,
            followers: formatNumber(u.followers || 0),
            following: u.following || 0,
            created: relativeTime(u.created_at || ""),
            url: u.html_url,
          };

          // Top repos
          if (reposRes && reposRes.status === 200) {
            try {
              const repos = JSON.parse(reposRes.data);
              result.top_repos = repos
                .filter((r: any) => !r.fork)
                .slice(0, 5)
                .map((r: any) => ({
                  name: r.name,
                  description: truncate(r.description || "", 100),
                  language: r.language || "",
                  stars: formatNumber(r.stargazers_count || 0),
                  url: r.html_url,
                }));
            } catch {}
          }

          result["数据来源"] = "GitHub";

          console.log(`[github] user "${username}" → OK`);
          return result;
        } catch (err) {
          return { error: `获取用户信息失败: ${String(err)}` };
        }
      },
    });

    /* ---- github_trending ---- */
    api.registerTool({
      name: "github_trending",
      label: "GitHub 趋势",
      description: `获取 GitHub 近期热门/趋势仓库。
通过搜索近期创建或获得大量 star 的项目实现。
适用场景：了解开源社区最近的热门项目和趋势。`,
      parameters: Type.Object({
        language: Type.Optional(
          Type.String({
            description: "编程语言筛选，如 python、javascript、rust",
          })
        ),
        since: Type.Optional(
          Type.String({
            description:
              "时间范围：daily（今日，默认）、weekly（本周）、monthly（本月）",
          })
        ),
        count: Type.Optional(
          Type.Number({ description: "数量（默认 10，最大 25）" })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const language = params.language as string | undefined;
        const since = (params.since as string) || "daily";
        const count = Math.min(Math.max((params.count as number) || 10, 1), 25);

        // Calculate date range
        const now = new Date();
        let daysBack = 1;
        if (since === "weekly") daysBack = 7;
        else if (since === "monthly") daysBack = 30;

        const fromDate = new Date(now.getTime() - daysBack * 86400000);
        const dateStr = fromDate.toISOString().split("T")[0];

        let q = `created:>${dateStr}`;
        if (language) q += ` language:${language}`;

        const searchParams = new URLSearchParams({
          q,
          sort: "stars",
          order: "desc",
          per_page: String(count),
        });

        try {
          const res = await httpGet(
            `${API_BASE}/search/repositories?${searchParams}`,
            { timeout: REQUEST_TIMEOUT }
          );
          if (res.status === 403) {
            return { error: "GitHub API 速率限制，请稍后再试" };
          }
          if (res.status !== 200) {
            return { error: `GitHub 返回 HTTP ${res.status}` };
          }

          const data = JSON.parse(res.data);
          const repos = (data.items || []).map((r: any, i: number) => ({
            index: i + 1,
            name: r.full_name,
            description: truncate(r.description || "", 150),
            language: r.language || "未知",
            stars: formatNumber(r.stargazers_count || 0),
            forks: formatNumber(r.forks_count || 0),
            url: r.html_url,
            topics: (r.topics || []).slice(0, 5),
            created: relativeTime(r.created_at || ""),
          }));

          console.log(
            `[github] trending ${language || "all"} ${since} → ${repos.length} repos`
          );

          return {
            language: language || "全部语言",
            period: since,
            result_count: repos.length,
            repos,
            数据来源: "GitHub",
          };
        } catch (err) {
          return { error: `获取趋势失败: ${String(err)}` };
        }
      },
    });

    console.log(
      "[github] Registered 5 tools: github_search, github_repo, github_issues, github_user, github_trending"
    );
  },
};

export default plugin;
