#!/usr/bin/env bash
# ====================================================================
# OpenClaw 插件 API 端点可达性测试
# 用法: bash test-endpoints.sh
#       bash test-endpoints.sh --verbose   (显示响应头)
#       bash test-endpoints.sh --json      (输出JSON格式)
# 
# 测试所有插件使用的外部 API 端点是否可达。
# 每个请求使用浏览器 UA，IPv4，超时 15 秒。
# ====================================================================

set -euo pipefail

VERBOSE=false
JSON_OUTPUT=false
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=true ;;
    --json|-j)    JSON_OUTPUT=true ;;
  esac
done

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TIMEOUT=15
CURL_OPTS="-4 -s -o /dev/null -w %{http_code}:%{time_total} --max-time $TIMEOUT -L"
CURL_VERBOSE="-4 -s -D - -o /dev/null --max-time $TIMEOUT -L"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

PASS=0
WARN=0
FAIL=0
TOTAL=0
RESULTS=()

test_endpoint() {
  local plugin="$1"
  local url="$2"
  local desc="$3"
  local extra_headers="${4:-}"
  
  TOTAL=$((TOTAL + 1))
  
  local cmd="curl $CURL_OPTS -H 'User-Agent: $UA'"
  if [ -n "$extra_headers" ]; then
    cmd="$cmd $extra_headers"
  fi
  cmd="$cmd '$url'"
  
  local result
  result=$(eval "$cmd" 2>/dev/null) || result="000:0.000"
  
  local code="${result%%:*}"
  local time="${result##*:}"
  
  local status_icon status_color status_text
  if [[ "$code" =~ ^2 ]]; then
    status_icon="✓"
    status_color="$GREEN"
    status_text="OK"
    PASS=$((PASS + 1))
  elif [[ "$code" =~ ^3 ]]; then
    status_icon="→"
    status_color="$YELLOW"
    status_text="REDIRECT"
    WARN=$((WARN + 1))
  elif [[ "$code" == "403" ]]; then
    status_icon="✗"
    status_color="$YELLOW"
    status_text="BLOCKED"
    WARN=$((WARN + 1))
  elif [[ "$code" == "429" ]]; then
    status_icon="⏱"
    status_color="$YELLOW"
    status_text="RATE-LIMITED"
    WARN=$((WARN + 1))
  elif [[ "$code" == "000" ]]; then
    status_icon="✗"
    status_color="$RED"
    status_text="TIMEOUT/DNS"
    FAIL=$((FAIL + 1))
  else
    status_icon="✗"
    status_color="$RED"
    status_text="HTTP $code"
    FAIL=$((FAIL + 1))
  fi
  
  if [ "$JSON_OUTPUT" = true ]; then
    RESULTS+=("{\"plugin\":\"$plugin\",\"url\":\"$url\",\"desc\":\"$desc\",\"status\":$code,\"time\":$time,\"result\":\"$status_text\"}")
  else
    printf "  ${status_color}${status_icon}${NC} %-18s %-12s ${GRAY}%5ss${NC}  %s\n" \
      "[$plugin]" "HTTP $code" "$time" "$desc"
    if [ "$VERBOSE" = true ] && [[ ! "$code" =~ ^2 ]]; then
      printf "    ${GRAY}URL: %s${NC}\n" "$url"
    fi
  fi
}

echo ""
if [ "$JSON_OUTPUT" != true ]; then
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║     OpenClaw 插件 API 端点可达性测试                        ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  超时: ${TIMEOUT}s | 强制IPv4 | UA: Chrome/131"
  echo -e "  时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo ""
fi

# ====================================================================
# academia (学术)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── academia ──${NC}"; fi
test_endpoint "academia" \
  "https://export.arxiv.org/api/query?search_query=all:electron&max_results=1" \
  "arXiv 搜索"
test_endpoint "academia" \
  "https://api.semanticscholar.org/graph/v1/paper/search?query=attention&limit=1" \
  "Semantic Scholar"
test_endpoint "academia" \
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=covid&retmax=1&retmode=json" \
  "PubMed eSearch"

# ====================================================================
# acg-db (ACG数据库)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── acg-db ──${NC}"; fi
test_endpoint "acg-db" \
  "https://pokeapi.co/api/v2/pokemon/pikachu" \
  "PokeAPI"
test_endpoint "acg-db" \
  "https://enka.network/api/uid/800000001" \
  "Enka (原神)"
test_endpoint "acg-db" \
  "https://swapi.dev/api/people/?search=luke" \
  "SWAPI (星战)"
test_endpoint "acg-db" \
  "https://www.dnd5eapi.co/api/classes/wizard" \
  "D&D 5e API"

# ====================================================================
# akshare (A股/东方财富)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── akshare ──${NC}"; fi
test_endpoint "akshare" \
  "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&np=1&fltt=2&fields=f12,f14&fid=f3&fs=m:1+t:2" \
  "东方财富行情" \
  "-H 'Referer: https://quote.eastmoney.com/'"
test_endpoint "akshare" \
  "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI&columns=ALL&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1" \
  "东方财富宏观数据"

# ====================================================================
# arts (艺术/音乐)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── arts ──${NC}"; fi
test_endpoint "arts" \
  "https://api.artic.edu/api/v1/artworks/search?q=monet&limit=1" \
  "芝加哥艺术馆"
test_endpoint "arts" \
  "https://musicbrainz.org/ws/2/artist/?query=beatles&limit=1&fmt=json" \
  "MusicBrainz" \
  "-H 'User-Agent: OpenClaw-Bot/1.0 (openclaw@example.com)'"
test_endpoint "arts" \
  "https://bible-api.com/John+3:16" \
  "Bible API"

# ====================================================================
# bangumi
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── bangumi ──${NC}"; fi
test_endpoint "bangumi" \
  "https://api.bgm.tv/search/subject/%E9%AD%94%E6%B3%95?responseGroup=small&type=2&max_results=1" \
  "Bangumi API" \
  "-H 'Accept: application/json'"

# ====================================================================
# bilibili
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── bilibili ──${NC}"; fi
test_endpoint "bilibili" \
  "https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD" \
  "Bilibili 视频"

# ====================================================================
# bing
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── bing ──${NC}"; fi
test_endpoint "bing" \
  "https://cn.bing.com/search?q=test&count=1" \
  "Bing 网页搜索"

# ====================================================================
# douban (豆瓣)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── douban ──${NC}"; fi
test_endpoint "douban" \
  "https://book.douban.com/j/subject_suggest?q=python" \
  "豆瓣图书"
test_endpoint "douban" \
  "https://movie.douban.com/j/subject_suggest?q=inception" \
  "豆瓣电影"

# ====================================================================
# ecology (生态)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── ecology ──${NC}"; fi
test_endpoint "ecology" \
  "https://api.gbif.org/v1/species/search?q=Panthera+tigris&limit=1" \
  "GBIF 物种搜索"
test_endpoint "ecology" \
  "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&maxFeatures=1&outputFormat=application/json" \
  "Smithsonian 火山"

# ====================================================================
# esports (电竞)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── esports ──${NC}"; fi
test_endpoint "esports" \
  "https://liquipedia.net/dota2/api.php?action=query&list=search&srsearch=Team+Spirit&srlimit=1&format=json" \
  "Liquipedia (Dota2)" \
  "-H 'User-Agent: OpenClaw-Esports/1.0 (https://github.com/openclaw; openclaw-esports-plugin)'"

# ====================================================================
# fandom
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── fandom ──${NC}"; fi
test_endpoint "fandom" \
  "https://genshin-impact.fandom.com/api.php?action=opensearch&search=Nahida&limit=3&format=json" \
  "Fandom (原神Wiki)"

# ====================================================================
# finance (金融)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── finance ──${NC}"; fi
test_endpoint "finance" \
  "https://api.frankfurter.app/latest?from=USD&to=CNY" \
  "Frankfurter 汇率"
test_endpoint "finance" \
  "https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD" \
  "CryptoCompare 币价"

# ====================================================================
# football (足球)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── football ──${NC}"; fi
test_endpoint "football" \
  "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard" \
  "ESPN 英超比分"

# ====================================================================
# image-search (图片搜索)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── image-search ──${NC}"; fi
test_endpoint "image-search" \
  "https://danbooru.donmai.us/posts.json?tags=hakurei_reimu&limit=1" \
  "Danbooru 搜索"
test_endpoint "image-search" \
  "https://danbooru.donmai.us/autocomplete.json?search[query]=reimu&search[type]=tag_query&limit=3" \
  "Danbooru 自动补全"
test_endpoint "image-search" \
  "https://cn.bing.com/images/search?q=cat&count=1" \
  "Bing 图片搜索"
test_endpoint "image-search" \
  "https://yandex.ru/images/search?text=cat&noreask=1" \
  "Yandex 图片搜索"

# ====================================================================
# jp-shopping (日本购物)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── jp-shopping ──${NC}"; fi
test_endpoint "jp-shopping" \
  "https://www.amazon.co.jp/s?k=test&language=ja" \
  "Amazon JP"
test_endpoint "jp-shopping" \
  "https://search.rakuten.co.jp/search/mall/test/" \
  "乐天搜索"
test_endpoint "jp-shopping" \
  "https://www.suruga-ya.jp/search?category=&search_word=test" \
  "骏河屋"
test_endpoint "jp-shopping" \
  "https://jp.mercari.com/search?keyword=test" \
  "Mercari"
test_endpoint "jp-shopping" \
  "https://www.animate-onlineshop.jp/products/list.php?name=test" \
  "Animate"

# ====================================================================
# lookup (百科查询)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── lookup ──${NC}"; fi
test_endpoint "lookup" \
  "https://world.openfoodfacts.org/api/v2/product/3017620422003.json" \
  "OpenFoodFacts"
test_endpoint "lookup" \
  "https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/1HGBH41JXMN109186?format=json" \
  "NHTSA VIN"
test_endpoint "lookup" \
  "https://opensky-network.org/api/states/all?icao24=a0b1c2" \
  "OpenSky 航班"
test_endpoint "lookup" \
  "https://api.adsbdb.com/v0/aircraft/N12345" \
  "adsbdb 飞机"

# ====================================================================
# moegirl (萌娘百科)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── moegirl ──${NC}"; fi
test_endpoint "moegirl" \
  "https://moegirl.uk/api.php?action=opensearch&search=reimu&limit=1&format=json" \
  "萌百镜像(moegirl.uk)"
test_endpoint "moegirl" \
  "https://zh.moegirl.org.cn/api.php?action=opensearch&search=reimu&limit=1&format=json" \
  "萌百官方(moegirl.org.cn)"

# ====================================================================
# nba-mlb
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── nba-mlb ──${NC}"; fi
test_endpoint "nba-mlb" \
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard" \
  "ESPN NBA"
test_endpoint "nba-mlb" \
  "https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025&standingsTypes=regularSeason" \
  "MLB Stats API"

# ====================================================================
# space (太空)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── space ──${NC}"; fi
test_endpoint "space" \
  "https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY" \
  "NASA APOD"
test_endpoint "space" \
  "https://api.wheretheiss.at/v1/satellites/25544" \
  "ISS 位置"
test_endpoint "space" \
  "https://api.spacexdata.com/v4/launches/latest" \
  "SpaceX 发射"

# ====================================================================
# sports (体育)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── sports ──${NC}"; fi
test_endpoint "sports" \
  "https://api.jolpi.ca/ergast/f1/current/driverStandings.json" \
  "F1 车手榜"
test_endpoint "sports" \
  "https://api.chess.com/pub/player/hikaru/stats" \
  "Chess.com"
test_endpoint "sports" \
  "https://lichess.org/api/user/DrNykterstein" \
  "Lichess" \
  "-H 'Accept: application/json'"

# ====================================================================
# steam
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── steam ──${NC}"; fi
test_endpoint "steam" \
  "https://store.steampowered.com/api/storesearch/?term=portal&cc=cn&l=schinese" \
  "Steam 搜索"
test_endpoint "steam" \
  "https://store.steampowered.com/api/appdetails?appids=730&cc=cn&l=schinese" \
  "Steam 详情"

# ====================================================================
# thbwiki (东方Wiki)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── thbwiki ──${NC}"; fi
test_endpoint "thbwiki" \
  "https://thwiki.cc/api.php?action=opensearch&search=reimu&limit=1&format=json" \
  "THBWiki"

# ====================================================================
# transit (公交)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── transit ──${NC}"; fi
test_endpoint "transit" \
  "https://api.transitous.org/api/v1/geocode?text=tokyo+station" \
  "Transitous 地理编码"

# ====================================================================
# trivia (趣味)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── trivia ──${NC}"; fi
test_endpoint "trivia" \
  "https://opentdb.com/api.php?amount=1" \
  "Open Trivia DB"
test_endpoint "trivia" \
  "https://api.chucknorris.io/jokes/random" \
  "Chuck Norris"
test_endpoint "trivia" \
  "https://poetrydb.org/random/1" \
  "PoetryDB"

# ====================================================================
# weather (天气)
# ====================================================================
if [ "$JSON_OUTPUT" != true ]; then echo -e "${CYAN}── weather ──${NC}"; fi
test_endpoint "weather" \
  "https://api.open-meteo.com/v1/forecast?latitude=35.6762&longitude=139.6503&current_weather=true" \
  "Open-Meteo 天气"
test_endpoint "weather" \
  "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=1&orderby=time" \
  "USGS 地震"

# ====================================================================
# 汇总
# ====================================================================
echo ""
if [ "$JSON_OUTPUT" = true ]; then
  echo "["
  for ((i=0; i<${#RESULTS[@]}; i++)); do
    if [ $i -gt 0 ]; then echo ","; fi
    echo "  ${RESULTS[$i]}"
  done
  echo "]"
else
  echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
  echo -e "  测试完成: ${GREEN}$PASS 通过${NC} / ${YELLOW}$WARN 警告${NC} / ${RED}$FAIL 失败${NC} / 共 $TOTAL 个端点"
  echo ""
  if [ $FAIL -gt 0 ]; then
    echo -e "  ${RED}有 $FAIL 个端点不可达，请检查网络或API状态${NC}"
  elif [ $WARN -gt 0 ]; then
    echo -e "  ${YELLOW}有 $WARN 个端点返回非200状态（可能是速率限制/反爬/重定向）${NC}"
  else
    echo -e "  ${GREEN}所有端点均可达！${NC}"
  fi
  echo ""
fi
