# TOOLS.md — 工具路由决策树

你有 50+ 工具。**不要凭记忆回答可以查到的事实**，按下面的决策树选工具。
一次只调需要的工具；工具报错就坦诚说"查不到"，绝不编造数据。

---

## 第一层：用户在问什么大类？

读完用户消息后，先判断属于哪个大类，再进入对应分支。

```
用户消息
├─ 提到「股票/A股/个股/大盘/K线/板块/北向/ETF/龙虎榜/CPI/PPI/PMI/财经新闻」
│  → 进入 [A股/中国金融]
│
├─ 提到「汇率/外币/换算/美元/欧元/日元/英镑」（不涉及A股）
│  → exchange_rate
│
├─ 提到「比特币/BTC/ETH/加密货币/币价/crypto」
│  → crypto_price
│
├─ 提到「天气/气温/下雨/预报/几度」
│  → weather_forecast
│
├─ 提到「地震/earthquake/震级」
│  → earthquake_recent
│
├─ 提到「Steam/steam游戏/游戏价格」
│  → 进入 [Steam]
│
├─ 提到「宝可梦/pokemon/精灵/皮卡丘」+ 查数据
│  → pokemon_lookup
│
├─ 提到「原神/genshin/UID/角色面板」
│  → genshin_player
│
├─ 提到「D&D/龙与地下城/DnD/法术/怪物图鉴」
│  → dnd_lookup
│
├─ 提到「星球大战/Star Wars/达斯/绝地/原力」
│  → starwars_search
│
├─ 提到「番剧/动画/新番/追番/bgm.tv/bangumi」
│  → bangumi
│
├─ 提到「B站/bilibili/av号/BV号」
│  → bilibili
│
├─ 提到「东方/touhou/灵梦/魔理沙」+ 查wiki
│  → thbwiki
│
├─ 提到「萌娘百科/moegirl/某个ACG角色」+ 查百科
│  → moegirl
│
├─ 提到「fandom/wiki」+ 提到具体IP（战锤/高达/魔戒/克苏鲁等）
│  → fandom
│
├─ 想要「二次元图片/角色图/ACG图」
│  → image_search (source=safebooru 优先; 真实照片用 bing)
│
├─ 提到「豆瓣/电影推荐/书评/评分」
│  → douban_search
│
├─ 提到「NASA/天文图/astronomy」
│  → nasa_apod
│
├─ 提到「空间站/ISS/国际空间站」
│  → iss_position
│
├─ 提到「SpaceX/火箭发射/马斯克+发射」
│  → spacex_launches
│
├─ 提到「论文/paper/学术/研究」
│  → 进入 [学术]
│
├─ 提到「名画/艺术品/美术馆/芝加哥艺术」
│  → artic_artwork_search
│
├─ 提到「音乐人/歌手/专辑/唱片/乐队」+ 查信息
│  → musicbrainz_search
│
├─ 提到「圣经/经文/Bible/John 3:16」
│  → bible_verse
│
├─ 提到「F1/赛车/一级方程式/积分榜」
│  → f1_results
│
├─ 提到「国际象棋/chess/棋手等级分」
│  → 进入 [棋类]
│
├─ 提到「食品/条形码/营养成分/卡路里」+ 有条码
│  → food_lookup
│
├─ 提到「VIN码/车架号/汽车解码」+ 有17位码
│  → vin_decode
│
├─ 提到「航班/飞机/flight/航线」
│  → 进入 [航空]
│
├─ 提到「电车/地铁/火车/新干线/公交/换乘/车站/时刻表/坐车去/怎么到/transit/railway」
│  → 进入 [公共交通]
│
├─ 提到「英超/西甲/德甲/意甲/法甲/欧冠/足球比分/联赛积分榜/球队/转会/签约」
│  → 进入 [五大联赛]
│
├─ 提到「NBA/篮球/湖人/勇士/凯尔特人/东部西部/篮球比分」
│  → 进入 [NBA]
│
├─ 提到「MLB/棒球/大联盟/洋基/道奇/大谷翔平」
│  → 进入 [MLB]
│
├─ 提到「物种/动物/植物/分类学/学名」
│  → gbif_species_search
│
├─ 提到「火山/volcano/喷发」
│  → volcano_search
│
├─ 想要「冷知识/trivia/出题」
│  → trivia_question
│
├─ 想要「笑话/joke」
│  → random_joke
│
├─ 想要「诗歌/poem/poetry」
│  → random_poem
│
├─ 给了一个URL让你看内容
│  → url_reader
│
├─ 问「群里刚才聊了什么/总结一下」
│  → chat_summary
│
├─ 问「用了多少token/额度」
│  → usage
│
├─ 以上都不匹配 / 需要搜索互联网
│  → bing
│
└─ 给了一张图让你找来源
   → yandex (以图搜图)
```

---

## 第二层：子分支决策

### [A股/中国金融]

**关键判断：用户想看什么？**

```
├─ "今天大盘怎么样 / A股行情 / 涨跌排行"
│  → akshare_stock_spot (行情列表，可翻页)
│
├─ "茅台/宁德/某股票" + 想看当前价格/基本面
│  → akshare_stock_info (传6位代码，如 600519)
│
├─ "茅台/某股K线 / 最近走势 / 日K周K月K"
│  → akshare_stock_hist (传代码+period)
│
├─ "上证指数/沪深300/创业板指 + K线/走势"
│  → akshare_index_hist
│  常用代码: 000001=上证 399001=深证 000300=沪深300 399006=创业板
│
├─ "哪个板块涨得好 / 行业排名 / 板块轮动"
│  → akshare_board_industry (无需参数)
│
├─ "北向资金 / 外资流入 / 沪股通深股通"
│  → akshare_north_flow (无需参数)
│
├─ "ETF / 基金行情 / 指数基金"
│  → akshare_etf_spot
│
├─ "CPI / PPI / PMI / 通胀 / 宏观经济"
│  → akshare_macro (indicator: cpi/ppi/pmi)
│
├─ "龙虎榜 / 游资 / 机构买入"
│  → akshare_lhb (可指定日期)
│
└─ "财经新闻 / 今天有什么消息 / 7x24快讯"
   → akshare_news
```

**⚠ 易混淆点**：
- 用户说"汇率"→ `exchange_rate`（不是 akshare）
- 用户说"比特币"→ `crypto_price`（不是 akshare）
- 用户说"美股/港股"→ akshare 不支持，用 `bing` 搜索

### [Steam]

```
├─ 有具体 AppID 数字 → steam_game
└─ 有游戏名关键词    → steam_search
```

### [学术]

```
├─ 计算机/物理/数学/工程类 → arxiv_search (优先)
├─ 医学/生物/临床          → pubmed_search
└─ 其他 / 不确定学科       → semantic_scholar_search
```

### [棋类]

```
├─ 提到 chess.com / 用户名@chess.com → chess_com_player
└─ 提到 lichess / 用户名@lichess     → lichess_player
   (不确定平台时两个都查)
```

### [公共交通]

全球公共交通查询（日本JR/私铁/地铁、欧洲DB/SNCF、北美等）。
数据来自 Transitous（MOTIS路由引擎），免费无需API Key。

```
├─ "XX站在哪 / 搜索车站 / 有什么站"
│  → transit_search (输入站名，返回stopId/坐标/交通方式)
│
├─ "从A到B怎么坐车 / 换乘方案 / 路线规划"
│  → transit_route (自动geocode站名，返回最优路线+换乘详情)
│
└─ "XX站接下来有什么车 / 发车时刻表 / 出发信息"
   → transit_departures (返回即将出发的班次列表)
```

**⚠ 注意**：
- 中文地名需要先用 transit_search 或让 transit_route 自动 geocode
- 日本站名建议用日文/英文（如 Shinjuku, 新宿）
- 中国高铁/公交覆盖较弱（Transitous主要覆盖日本、欧洲、北美）
- 如果查不到路线，用 `bing` 兜底搜索

### [五大联赛]

欧洲五大联赛 + 欧冠足球数据（ESPN API）。

```
├─ "今天英超/西甲/某联赛比分 / 赛果"
│  → football_scores (league: epl/laliga/bundesliga/seriea/ligue1/ucl, 可选date)
│
├─ "英超积分榜 / 西甲排名 / 联赛排名"
│  → football_standings (league: epl/laliga/bundesliga/seriea/ligue1/ucl)
│
├─ "利物浦/巴萨/某球队 详情 / 阵容"
│  → football_team (league + teamName)
│
└─ "转会流言 / 转会市场 / 谁要转会 / 签约消息"
   → football_transfer_news (可选league筛选联赛，不指定则汇总五大联赛)
```

**⚠ 联赛代码映射**：
- 英超 = `epl`，西甲 = `laliga`，德甲 = `bundesliga`
- 意甲 = `seriea`，法甲 = `ligue1`，欧冠 = `ucl`
- 用户说"足球"但没指定联赛 → 默认 `epl`（英超）

### [NBA]

NBA 篮球数据（ESPN API）。

```
├─ "今天NBA比分 / 昨天NBA赛果"
│  → nba_scores (可选date，格式YYYYMMDD)
│
└─ "NBA排名 / 东部西部 / 战绩"
   → nba_standings (conference: all/east/west)
```

### [MLB]

美国职棒大联盟数据（ESPN + MLB Stats API）。

```
├─ "今天MLB比分 / 棒球赛果"
│  → mlb_scores (可选date)
│
├─ "MLB排名 / 美联国联 / 战绩"
│  → mlb_standings (league: all/al/nl)
│
└─ "大谷翔平 / 某球员数据"
   → mlb_player (playerName)
```

### [航空]

```
├─ 有航班号/呼号/想看实时位置 → flight_tracker
└─ 有飞机注册号/想查机型     → aircraft_lookup
```

---

## 易错场景速查

| 用户说的 | ❌ 错误选择 | ✅ 正确选择 | 理由 |
|---------|-----------|-----------|------|
| "美元兑人民币多少" | akshare_* | exchange_rate | 汇率不是A股 |
| "比特币现在多少" | akshare_* | crypto_price | 加密货币不是A股 |
| "帮我搜个论文" | bing | arxiv/scholar/pubmed | 有专用学术工具 |
| "这个角色是谁"(二次元) | bing | moegirl 或 bangumi | ACG角色用ACG百科 |
| "茅台股票怎么样" | bing | akshare_stock_info | 个股信息有专用工具 |
| "给我来张灵梦的图" | bing | image_search(safebooru) | 二次元角色图用safebooru |
| "今天A股怎么样" | exchange_rate | akshare_stock_spot | 大盘行情用akshare |
| "美股特斯拉" | akshare_* | bing | akshare只支持A股 |
| "东方project角色" | moegirl | thbwiki | 东方专用wiki更准 |
| "高达设定" | moegirl | fandom | 高达用fandom wiki |
| "东京到大阪怎么走" | bing | transit_route | 公交出行有专用工具 |
| "新宿站时刻表" | bing | transit_departures | 车站时刻表有专用工具 |
| "英超积分榜" | bing | football_standings | 五大联赛有专用工具 |
| "今天NBA比分" | bing | nba_scores | NBA有专用工具 |
| "大谷翔平数据" | bing | mlb_player | MLB有专用工具 |
| "足球比赛"(没说联赛) | football_standings | football_scores(epl) | 默认英超 |
| "转会消息/谁要签约" | bing | football_transfer_news | 转会流言有专用工具 |

---

## 组合调用规则

用户一句话包含多个意图时可以并行调用，但遵守以下限制：

- **最多同时调 3 个工具**，不要一次铺开 5 个
- **同类不重复**：不要同时调 `akshare_stock_info` + `akshare_stock_spot` 查同一只股票
- **合理组合示例**：
  - "东京天气+最近有地震吗" → `weather_forecast` + `earthquake_recent` ✅
  - "茅台股价和K线" → `akshare_stock_info` + `akshare_stock_hist` ✅
  - "帮我查个论文顺便看看NASA今日天文图" → `arxiv_search` + `nasa_apod` ✅
  - "东京到京都怎么坐车+京都天气" → `transit_route` + `weather_forecast` ✅
  - "英超和西甲今天比分" → `football_scores(epl)` + `football_scores(laliga)` ✅
  - "NBA排名+今天比分" → `nba_standings` + `nba_scores` ✅

---

## 兜底策略

如果决策树里找不到匹配的分支：
1. 先想想是不是可以用 `bing` 搜索解决
2. 如果用户给了 URL → `url_reader`
3. 如果纯粹闲聊/观点/情感 → **不需要任何工具**，直接回复
