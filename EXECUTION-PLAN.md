# 祥子Bot 数据源接入执行计划

基于 GOD-PLAN.MD，将 ~30 个公开 API 按主题合并为 11 个新插件，分 4 期实施。

## 约束

- 服务器出站仅 80/443/53
- IPv6 不通，所有请求用 `family: 4`
- 插件用 TypeScript，OpenClaw 直接加载（无需编译）
- 复用 `node:https` + `node:http` + `node:zlib` 的 httpGet 模式
- 被墙 API 全部跳过

## 插件架构模板

每个插件：
- `~/.openclaw/extensions/{name}/index.ts` — 主逻辑
- `~/.openclaw/extensions/{name}/openclaw.plugin.json` — 清单
- 在 `~/.openclaw/openclaw.json` 的 `plugins.entries` 注册

---

## Phase 1: 高频实用

### 1.1 weather（天气+地震）
- **Open-Meteo**: 天气预报 `api.open-meteo.com/v1/forecast`
  - tools: `weather_forecast` — 按城市名/经纬度查天气（当前+未来7天）
- **USGS 地震**: `earthquake.usgs.gov/fdsnws/event/1/query`
  - tools: `earthquake_recent` — 查最近地震（按震级/区域/时间范围）

### 1.2 finance（汇率+加密货币）
- **Frankfurter**: `api.frankfurter.app`
  - tools: `exchange_rate` — 实时汇率查询/换算
- **CryptoCompare**: `data-api.cryptocompare.com`
  - tools: `crypto_price` — 加密货币实时价格

### 1.3 steam（Steam游戏）
- **Steam Store API**: `store.steampowered.com/api`
  - tools: `steam_game` — 按 appid 查游戏详情（价格/评分/描述）
  - tools: `steam_search` — 按关键词搜游戏

## Phase 2: ACG / 娱乐

### 2.1 acg-db（跨IP数据库）
- **PokeAPI**: `pokeapi.co/api/v2` — 宝可梦查询
- **Enka Network**: `enka.network/api/uid/{UID}` — 原神面板
- **SWAPI**: `swapi.dev/api` — 星球大战
- **D&D 5e**: `dnd5eapi.co/api` — 龙与地下城怪物/法术/物品

### 2.2 trivia（趣味问答）
- **Open Trivia DB**: `opentdb.com/api.php` — 随机问答题
- **Chuck Norris**: `api.chucknorris.io` — 笑话
- **PoetryDB**: `poetrydb.org` — 英文诗歌

### 2.3 douban（豆瓣）
- **豆瓣 suggest**: `book.douban.com/j/subject_suggest` — 书影搜索

## Phase 3: 知识 / 科学

### 3.1 space（太空）
- **NASA APOD**: 每日天文图（含图片URL）
- **WhereTheISS**: ISS 实时位置
- **SpaceX**: 最新发射信息

### 3.2 academia（学术）
- **arXiv**: 论文搜索（Atom XML 解析）
- **Semantic Scholar**: 论文搜索（JSON）
- **PubMed**: 医学文献搜索

### 3.3 arts（艺术/音乐/文学）
- **ArtIC 芝加哥艺术馆**: 搜索馆藏（13万件，含图片）
- **MusicBrainz**: 音乐搜索（艺术家/专辑/曲目）
- **Bible API**: 圣经章节查询

## Phase 4: 杂项

### 4.1 sports（体育）
- **Ergast F1**: F1 赛事结果
- **Chess.com**: 棋手数据
- **Lichess**: 棋手数据

### 4.2 lookup（查物）
- **Open Food Facts**: 食品条形码查询
- **NHTSA VIN**: 汽车VIN解码
- **OpenSky**: 实时航班
- **adsbdb**: 飞机注册信息

### 4.3 ecology（生态）
- **GBIF**: 生物多样性/物种分布
- **Smithsonian GVP**: 火山数据

---

## 实施顺序

1. 写 httpGet 公共工具函数模板（从 image-search 复制）
2. Phase 1 → Phase 2 → Phase 3 → Phase 4 顺序写
3. 每写完一个插件立即注册到 openclaw.json
4. 每期完成后 `openclaw gateway restart` 验证
5. 全部完成后整体测试

## Phase 5: 交通出行（2026-03-08 追加）

### 5.1 transit（全球公共交通）
- **Transitous (MOTIS 2)**: `api.transitous.org` — 免费全球公交路由
  - tools: `transit_search` — 搜索车站/站点（geocode）
  - tools: `transit_route` — 路线规划（两地间最优换乘方案）
  - tools: `transit_departures` — 车站发车时刻表
  - 覆盖：日本（JR/私铁/地铁）、欧洲（DB/SNCF/Trenitalia等）、北美等
  - 状态：✅ 已完成

## Phase 6: 主流体育联赛（2026-03-08 追加）

### 6.1 football（欧洲五大联赛+欧冠）
- **ESPN API**: `site.api.espn.com` — 免费公开API，无需Key
  - tools: `football_scores` — 某联赛某日比分（英超/西甲/德甲/意甲/法甲/欧冠）
  - tools: `football_standings` — 联赛积分榜
  - tools: `football_team` — 球队详情（阵容/近期赛果/下场比赛）
  - 状态：✅ 已完成

### 6.2 nba-mlb（NBA + MLB）
- **ESPN API**: NBA 比分 + 排名
  - tools: `nba_scores` — NBA 当日比分
  - tools: `nba_standings` — NBA 东/西部排名
- **ESPN API + MLB Stats API**: MLB 比分 + 排名 + 球员
  - tools: `mlb_scores` — MLB 当日比分
  - tools: `mlb_standings` — MLB 美联/国联排名
  - tools: `mlb_player` — MLB 球员搜索（大谷翔平等）
  - 状态：✅ 已完成

---

## 预期结果（更新）

- 新增 17 个插件（含 akshare + esports + transit + football + nba-mlb），~63 个工具
- 总插件数 30 个（含现有 13 个）
- 覆盖领域：天气、地震、汇率、加密货币、Steam、宝可梦、原神、星战、D&D、问答、笑话、诗歌、豆瓣、太空、论文、医学、艺术、音乐、圣经、F1、象棋、食品、汽车、航班、生物、火山、A股金融、电竞、公共交通、五大联赛足球、NBA、MLB
