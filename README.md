# OpenClaw Extensions

一组用于 [OpenClaw](https://github.com/nicepkg/openclaw) AI Agent 框架的自定义插件，提供 ACG 数据库查询、网页搜索、以图搜图、Wiki 百科、B站视频搜索等工具能力，以及完整的 QQ 群聊渠道接入（含语音合成和图片生成）。

## 插件一览

| 插件 | 类型 | 功能 | 需要 API Key |
|------|------|------|:---:|
| [bangumi](#bangumi) | 工具 | Bangumi 动画/漫画/游戏数据库查询 | 可选 |
| [bilibili](#bilibili) | 工具 | B站视频搜索、视频详情、评论 | 否 |
| [bing](#bing) | 工具 | 必应网页搜索 + 页面内容抓取 | 否 |
| [yandex](#yandex) | 工具 | Yandex 以图搜图（识别角色/物体/来源） | 否 |
| [thbwiki](#thbwiki) | 工具 | THBWiki 东方 Project 百科查询 | 否 |
| [moegirl](#moegirl) | 工具 | 萌娘百科查询 | 否 |
| [fandom](#fandom) | 工具 | Fandom Wiki 查询（支持任意子站） | 否 |
| [qq](#qq) | 渠道 | QQ 群聊/私聊接入，含 TTS、图片生成 | 需要 |

**工具插件**与渠道无关——无论你用 QQ、飞书、Slack 还是 CLI，只要是 OpenClaw 实例都可以使用。

---

## 快速开始

### 安装单个工具插件

以 `bangumi` 为例：

```bash
# 1. 复制插件文件夹到 OpenClaw 扩展目录
cp -r bangumi/ ~/.openclaw/extensions/bangumi/

# 2. 安装依赖
cd ~/.openclaw/extensions/bangumi/
npm install @sinclair/typebox

# 3. 在 openclaw.json 的 plugins.entries 中启用
# "bangumi": { "enabled": true }

# 4. 重启 gateway
openclaw gateway restart
```

### 安装所有工具插件

```bash
# 复制所有插件（排除 qq 渠道插件和 feishu 官方插件）
for plugin in bangumi bilibili bing yandex thbwiki moegirl fandom; do
  cp -r $plugin/ ~/.openclaw/extensions/$plugin/
  cd ~/.openclaw/extensions/$plugin/
  npm install @sinclair/typebox
  cd -
done
```

然后在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "entries": {
      "bangumi": { "enabled": true },
      "bilibili": { "enabled": true },
      "bing": { "enabled": true },
      "yandex": { "enabled": true },
      "thbwiki": { "enabled": true },
      "moegirl": { "enabled": true },
      "fandom": { "enabled": true }
    }
  }
}
```

---

## 工具插件详情

### bangumi

查询 [Bangumi](https://bgm.tv)（番组计划）上的动画、漫画、游戏、音乐条目。

**注册工具名**: `bangumi`

| 操作 | 说明 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `search` | 按关键词搜索条目 | `keyword` | `type`（anime/book/game/music/real）, `limit`（默认 5，最大 25） |
| `detail` | 获取条目详情 | `subject_id` | - |
| `characters` | 获取条目角色列表 | `subject_id` | `limit`（默认 10） |
| `related` | 获取关联条目（续作、前传、外传等） | `subject_id` | - |
| `persons` | 获取制作人员/声优 | `subject_id` | `limit`（默认 10） |

**配置**（可选）：

```json
"bangumi": {
  "enabled": true,
  "config": {
    "token": "你的 Bangumi API Token"
  }
}
```

Token 从 [bgm.tv/dev/app](https://bgm.tv/dev/app) 获取，也可通过环境变量 `BANGUMI_TOKEN` 设置。不配置 token 也能使用基本功能。

---

### bilibili

搜索和查询 [B站](https://www.bilibili.com) 视频、评论。

**注册工具名**: 5 个独立工具

| 工具 | 说明 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `bilibili_search` | 搜索视频 | `keyword` | `page`, `page_size`（1-20）, `order`（totalrank/click/pubdate/dm/stow） |
| `bilibili_video` | 获取视频详情 | `bvid` 或 `aid` | - |
| `bilibili_comments` | 获取视频评论 | `bvid` 或 `aid` | `sort`（0=时间/1=点赞/2=回复数）, `page`, `page_size` |
| `bilibili_replies` | 获取评论回复（楼中楼） | `aid`, `rpid` | `page`, `page_size` |
| `bilibili_hot_comments` | 获取热门评论 | `bvid` 或 `aid` | `count`（1-20，默认 5） |

无需 API Key，使用 B站公开接口。支持 BV号/AV号 自动转换。

---

### bing

通过抓取 [cn.bing.com](https://cn.bing.com) 实现网页搜索。

**注册工具名**: `bing`

| 操作 | 说明 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `search` | 搜索关键词，返回标题/URL/摘要 | `query` | `count`（默认 10，最大 30） |
| `fetch` | 抓取指定 URL 的页面正文 | `url` | `max_chars`（默认 8000，最大 30000） |

无需 API Key。支持 Bing 搜索语法（如 `site:xxx.com`）。

---

### yandex

通过 [Yandex](https://yandex.ru/images/) CBIR 实现以图搜图。

**注册工具名**: `yandex`

| 参数 | 说明 |
|------|------|
| `image`（必填） | 本地文件路径、HTTP(S) URL 或 `data:image/...` base64 |

**返回内容**:
- `tags`: Yandex 图像识别标签（角色名、作品名、物体名称等）
- `matching_sites`: 包含该图片的网页列表（标题、URL、描述）

**适用场景**: 识别动漫/游戏角色、查找图片来源、识别实物/地标。无需 API Key。

---

### thbwiki

查询 [THBWiki](https://thwiki.cc)（东方 Project 中文维基百科）。

**注册工具名**: `thbwiki`

| 操作 | 说明 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `search` | 搜索页面 | `keyword` | `limit`（默认 5，最大 20） |
| `page` | 获取页面简介 + 目录 | `title` | - |
| `sections` | 列出页面所有章节 | `title` | - |
| `read_section` | 读取指定章节内容 | `title`, `section`（章节索引） | - |

无需 API Key。使用 MediaWiki API，自动处理 IPv6 不可达问题。

---

### moegirl

查询[萌娘百科](https://zh.moegirl.org.cn)（ACG 中文百科）。

**注册工具名**: `moegirl`

| 操作 | 说明 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `search` | 搜索页面 | `keyword` | `limit`（默认 5，最大 10） |
| `page` | 获取页面全文内容 | `title` | - |
| `categories` | 获取页面所属分类 | `title` | `limit`（默认 10） |

无需 API Key。内置镜像站 `moegirl.uk` 加速访问，官方站不稳定时自动切换。

---

### fandom

查询任意 [Fandom](https://www.fandom.com) Wiki 子站。

**注册工具名**: `fandom`

| 操作 | 说明 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `search` | 搜索页面 | `wiki`, `keyword` | `lang`, `limit`（默认 5，最大 10） |
| `page` | 获取页面简介 | `wiki`, `title` | `lang` |
| `sections` | 列出页面章节 | `wiki`, `title` | `lang` |
| `read_section` | 读取指定章节 | `wiki`, `title`, `section` | `lang` |

`wiki` 参数为 Fandom 子站名，例如：

| 子站名 | Wiki |
|--------|------|
| `onepiece` | 海贼王 |
| `genshin-impact` | 原神 |
| `honkai-star-rail` | 崩坏：星穹铁道 |
| `minecraft` | Minecraft |
| `typemoon` | TYPE-MOON |
| `touhou` | 东方 |
| `pokemon` | 宝可梦 |

`lang` 参数可选，如 `zh`、`ja`、`es` 等。无需 API Key。

---

## 渠道插件

### qq

完整的 QQ 群聊/私聊接入方案，基于 [OneBot v11](https://github.com/botuniverse/onebot-11) WebSocket 协议。需要配合 [NapCat](https://github.com/NapNeko/NapCatQQ) 或 go-cqhttp 等 OneBot 实现使用。

> 这是渠道插件（channel plugin），与上面的工具插件不同。它负责将 QQ 消息接入 OpenClaw Agent，而工具插件则为 Agent 提供外部能力。

#### 功能特性

- **消息处理**: 群聊 @/回复/关键词触发、私聊直接对话、消息队列与防抖、会话冷却
- **图片输入/输出**: 接收图片作为视觉输入传给模型；从模型回复中提取图片 URL 自动发送为 QQ 图片
- **语音合成 (TTS)**: 集成 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)，通过 `/voice` 命令生成角色语音
- **图片生成**: 通过 `/grok_draw` 命令调用 Grok Imagine API 生成图片
- **临时会话**: 命名式会话槽位，支持多个隔离对话上下文
- **多层上下文**: 递归解析回复链和转发消息，注入结构化上下文
- **长文转发**: 超长回复自动转为 QQ 合并转发消息
- **群管功能**: 禁言 (`/mute`)、踢人 (`/kick`)
- **安全控制**: 管理员权限、用户黑名单、群白名单
- **自动重连**: WebSocket 断线自动重连（指数退避，最大 60s）

#### 斜杠命令

| 命令 | 权限 | 说明 |
|------|------|------|
| `/voice <提示词>` | 所有人 | 生成语音回复（仅发送语音，不发文字） |
| `/grok_draw <提示词>` | 所有人 | 生成 AI 图片 |
| `/reset` 或 `/newsession` | 管理员 | 重置当前会话上下文 |
| `/临时 <名称>` 或 `/tmp <名称>` | 所有人 | 进入临时会话 |
| `/退出临时` 或 `/exittemp` | 所有人 | 返回主会话 |
| `/临时列表` 或 `/tmplist` | 所有人 | 列出所有临时会话 |
| `/status` | 所有人 | 查看 bot 状态 |
| `/help` | 所有人 | 显示帮助 |
| `/mute @用户 [分钟]` | 管理员 | 禁言群成员 |
| `/kick @用户` | 管理员 | 踢出群成员 |

#### 安装

QQ 插件的安装比工具插件复杂，需要：

1. 部署 OneBot v11 服务端（推荐 [NapCat Docker](https://github.com/NapNeko/NapCatQQ)）
2. 配置 WebSocket 连接和访问令牌
3. （可选）部署 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 用于语音合成

```bash
# 安装插件依赖
cd ~/.openclaw/extensions/qq/
npm install ws zod

# NapCat Docker 部署示例
sudo docker run -d \
  --name napcat \
  --restart unless-stopped \
  -p 3001:3001 \
  -p 6099:6099 \
  mlikiowa/napcat-docker:latest
```

配置示例见 [openclaw.json.example](./openclaw.json.example) 中的 `channels.qq` 部分。

#### 关键配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `wsUrl` | 必填 | OneBot WebSocket 地址（如 `ws://127.0.0.1:3001`） |
| `accessToken` | - | OneBot 访问令牌 |
| `admins` | `""` | 管理员 QQ 号（逗号分隔） |
| `allowedGroups` | `""` | 允许的群号（逗号分隔，空=全部） |
| `requireMention` | `true` | 群聊中需要 @ 才触发 |
| `enableSoVITS` | `false` | 启用 GPT-SoVITS 语音合成 |
| `sovitsApiUrl` | `http://127.0.0.1:9880` | SoVITS API 地址 |
| `sovitsRefAudioPath` | - | 参考音频文件路径 |
| `sovitsPromptText` | - | 参考音频对应文本 |
| `sovitsPromptLang` | `ja` | 参考音频语言 |
| `queueDebounceMs` | `3000` | 消息防抖时间（ms） |
| `sessionCooldownMs` | `20000` | 会话冷却时间（ms） |
| `formatMarkdown` | `false` | 去除 Markdown 格式 |

---

## 配置文件

- **`openclaw.json.example`** — 脱敏的 OpenClaw 配置模板，包含所有插件的配置示例
- **`.env.example`** — 环境变量模板

将 `openclaw.json.example` 复制为 `~/.openclaw/openclaw.json`，替换其中的 `YOUR_*` 占位符为实际值。

---

## 技术细节

### 依赖关系

所有工具插件仅依赖 `@sinclair/typebox`（用于参数 schema 定义），通过 OpenClaw SDK 的 `api.registerTool()` 注册。HTTP 请求使用 Node.js 内置的 `node:https` 模块（强制 IPv4，适配部分 IPv6 不可达的环境）。

QQ 渠道插件额外依赖 `ws`（WebSocket 客户端）和 `zod`（配置校验）。

### 网络要求

| 插件 | 访问域名 | 备注 |
|------|----------|------|
| bangumi | api.bgm.tv | - |
| bilibili | api.bilibili.com | 需要 `Referer: https://www.bilibili.com` |
| bing | cn.bing.com | 网页抓取 |
| yandex | yandex.ru | 部分地区可能需要代理 |
| thbwiki | thwiki.cc | 强制 IPv4 |
| moegirl | moegirl.uk, zh.moegirl.org.cn | 镜像优先 |
| fandom | *.fandom.com | - |
| qq | 自定义 WebSocket 地址 | 连接本地/远程 OneBot 服务 |

### 插件接口规范

每个工具插件遵循相同的结构：

```
plugin-name/
  index.ts              # 入口文件，export default { id, name, description, register(api) }
  openclaw.plugin.json  # 插件清单（id + configSchema）
  package.json          # 可选
  node_modules/         # @sinclair/typebox
```

`register(api)` 中调用 `api.registerTool()` 注册工具，模型即可通过 function calling 调用。

---

## 许可

MIT
