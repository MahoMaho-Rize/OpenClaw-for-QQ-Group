import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as https from "node:https";
import * as http from "node:http";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/*  ACG Database Plugin                                                */
/*  PokeAPI + Enka Network (Genshin) + SWAPI (Star Wars) + D&D 5e     */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = "OpenClaw-ACG-DB/1.0";

/* ---- HTTP helper (IPv4-only, gzip support) ---- */

function httpGet(url: string, timeout = REQUEST_TIMEOUT): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        family: 4,
        timeout,
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate" },
      },
      (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGet(res.headers.location, timeout).then(resolve).catch(reject);
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = res.headers["content-encoding"];
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout ${timeout}ms`)); });
  });
}

/* ---- Helpers ---- */

function truncate(s: string, max = 300): string {
  if (!s || s.length <= max) return s || "";
  return s.slice(0, max) + "...";
}

/* ================================================================== */
/*  1. PokeAPI                                                         */
/* ================================================================== */

async function fetchPokemon(name: string) {
  const key = encodeURIComponent(name.toLowerCase().trim());
  const [pokemonRes, speciesRes] = await Promise.all([
    httpGet(`https://pokeapi.co/api/v2/pokemon/${key}`),
    httpGet(`https://pokeapi.co/api/v2/pokemon-species/${key}`).catch(() => null),
  ]);
  if (pokemonRes.status !== 200) throw new Error(`PokeAPI HTTP ${pokemonRes.status}`);
  const pokemon = JSON.parse(pokemonRes.data);

  // Extract species names (Chinese / Japanese)
  let nameCN = "", nameJA = "", nameEN = "", flavorText = "", genus = "";
  if (speciesRes && speciesRes.status === 200) {
    const species = JSON.parse(speciesRes.data);
    const names: any[] = species.names || [];
    nameCN = names.find((n: any) => n.language?.name === "zh-Hans")?.name
          || names.find((n: any) => n.language?.name === "zh-Hant")?.name || "";
    nameJA = names.find((n: any) => n.language?.name === "ja")?.name
          || names.find((n: any) => n.language?.name === "ja-Hrkt")?.name || "";
    nameEN = names.find((n: any) => n.language?.name === "en")?.name || "";
    const flavors: any[] = species.flavor_text_entries || [];
    const flavorCN = flavors.find((f: any) => f.language?.name === "zh-Hans");
    const flavorEN = flavors.find((f: any) => f.language?.name === "en");
    flavorText = truncate((flavorCN || flavorEN)?.flavor_text?.replace(/\n|\f/g, " ") || "", 200);
    const genera: any[] = species.genera || [];
    genus = genera.find((g: any) => g.language?.name === "zh-Hans")?.genus
         || genera.find((g: any) => g.language?.name === "en")?.genus || "";
  }

  const types = pokemon.types?.map((t: any) => t.type?.name).filter(Boolean) || [];
  const abilities = pokemon.abilities?.slice(0, 4).map((a: any) => ({
    name: a.ability?.name,
    hidden: a.is_hidden || false,
  })) || [];
  const stats: Record<string, number> = {};
  for (const s of pokemon.stats || []) {
    stats[s.stat?.name || "unknown"] = s.base_stat;
  }
  const sprite = pokemon.sprites?.other?.["official-artwork"]?.front_default
              || pokemon.sprites?.front_default || "";

  return {
    id: pokemon.id,
    name: pokemon.name,
    name_cn: nameCN || undefined,
    name_ja: nameJA || undefined,
    name_en: nameEN || undefined,
    genus: genus || undefined,
    types,
    height: `${pokemon.height / 10}m`,
    weight: `${pokemon.weight / 10}kg`,
    base_stats: stats,
    abilities,
    sprite,
    flavor_text: flavorText || undefined,
  };
}

/* ================================================================== */
/*  2. Enka Network (Genshin Impact)                                   */
/* ================================================================== */

async function fetchGenshinPlayer(uid: string) {
  const res = await httpGet(`https://enka.network/api/uid/${encodeURIComponent(uid)}`);
  if (res.status === 404) throw new Error("UID 不存在或数据不可用");
  if (res.status === 424) throw new Error("游戏维护中，数据暂不可用");
  if (res.status === 429) throw new Error("请求频率过高，请稍后重试");
  if (res.status !== 200) throw new Error(`Enka HTTP ${res.status}`);
  const data = JSON.parse(res.data);
  const info = data.playerInfo || {};

  const player = {
    nickname: info.nickname || "未知",
    level: info.level,
    world_level: info.worldLevel,
    signature: info.signature || "",
    achievements: info.finishAchievementNum,
    abyss: info.towerFloorIndex && info.towerLevelIndex
      ? `${info.towerFloorIndex}-${info.towerLevelIndex}` : undefined,
    theater: info.theaterActIndex && info.theaterModeIndex
      ? `第${info.theaterActIndex}幕-${info.theaterModeIndex}` : undefined,
    profile_picture_id: info.profilePicture?.id,
  };

  // Character showcase
  const showcase = (info.showAvatarInfoList || []).slice(0, 8).map((a: any) => ({
    avatar_id: a.avatarId,
    level: a.level,
    costume_id: a.costumeId || undefined,
  }));

  // Detailed character info (if available)
  const characters = (data.avatarInfoList || []).slice(0, 8).map((c: any) => {
    const props = c.fightPropMap || {};
    return {
      avatar_id: c.avatarId,
      level: c.propMap?.["4001"]?.val ? Number(c.propMap["4001"].val) : undefined,
      constellation: c.talentIdList?.length || 0,
      skill_levels: c.skillLevelMap || undefined,
      hp: Math.round(props[2000] || 0),
      atk: Math.round(props[2001] || 0),
      def: Math.round(props[2002] || 0),
      crit_rate: props[20] ? `${(props[20] * 100).toFixed(1)}%` : undefined,
      crit_dmg: props[22] ? `${(props[22] * 100).toFixed(1)}%` : undefined,
      energy_recharge: props[23] ? `${(props[23] * 100).toFixed(1)}%` : undefined,
      weapon: c.equipList?.find((e: any) => e.flat?.itemType === "ITEM_WEAPON")?.flat ? {
        name: c.equipList.find((e: any) => e.flat?.itemType === "ITEM_WEAPON").flat.nameTextMapHash,
        level: c.equipList.find((e: any) => e.flat?.itemType === "ITEM_WEAPON").weapon?.level,
        refinement: c.equipList.find((e: any) => e.flat?.itemType === "ITEM_WEAPON").weapon?.affixMap
          ? Object.values(c.equipList.find((e: any) => e.flat?.itemType === "ITEM_WEAPON").weapon.affixMap)[0] as number + 1
          : undefined,
      } : undefined,
    };
  });

  return {
    uid,
    player,
    showcase: showcase.length ? showcase : undefined,
    characters: characters.length ? characters : undefined,
    ttl: data.ttl,
  };
}

/* ================================================================== */
/*  3. SWAPI (Star Wars)                                               */
/* ================================================================== */

const SWAPI_RESOURCES = ["people", "planets", "starships", "films", "species", "vehicles"];

async function searchStarWars(resource: string, query: string) {
  const res = await httpGet(`https://swapi.dev/api/${encodeURIComponent(resource)}/?search=${encodeURIComponent(query)}`);
  if (res.status !== 200) throw new Error(`SWAPI HTTP ${res.status}`);
  const data = JSON.parse(res.data);
  const results = (data.results || []).slice(0, 5);

  return results.map((item: any) => {
    switch (resource) {
      case "people":
        return {
          name: item.name,
          birth_year: item.birth_year,
          gender: item.gender,
          height: item.height ? `${item.height}cm` : undefined,
          mass: item.mass ? `${item.mass}kg` : undefined,
          hair_color: item.hair_color,
          eye_color: item.eye_color,
          homeworld: item.homeworld,
          films_count: item.films?.length || 0,
        };
      case "planets":
        return {
          name: item.name,
          climate: item.climate,
          terrain: item.terrain,
          population: item.population,
          diameter: item.diameter ? `${item.diameter}km` : undefined,
          gravity: item.gravity,
          orbital_period: item.orbital_period,
          residents_count: item.residents?.length || 0,
        };
      case "starships":
        return {
          name: item.name,
          model: item.model,
          manufacturer: item.manufacturer,
          starship_class: item.starship_class,
          cost: item.cost_in_credits,
          length: item.length ? `${item.length}m` : undefined,
          crew: item.crew,
          passengers: item.passengers,
          hyperdrive_rating: item.hyperdrive_rating,
        };
      case "films":
        return {
          title: item.title,
          episode_id: item.episode_id,
          director: item.director,
          producer: item.producer,
          release_date: item.release_date,
          opening_crawl: truncate(item.opening_crawl?.replace(/\r?\n/g, " ") || "", 200),
        };
      case "species":
        return {
          name: item.name,
          classification: item.classification,
          designation: item.designation,
          average_height: item.average_height,
          average_lifespan: item.average_lifespan,
          language: item.language,
        };
      case "vehicles":
        return {
          name: item.name,
          model: item.model,
          manufacturer: item.manufacturer,
          vehicle_class: item.vehicle_class,
          cost: item.cost_in_credits,
          length: item.length ? `${item.length}m` : undefined,
          crew: item.crew,
          passengers: item.passengers,
        };
      default:
        return item;
    }
  });
}

/* ================================================================== */
/*  4. D&D 5e API                                                      */
/* ================================================================== */

const DND_CATEGORIES = ["monsters", "spells", "classes", "equipment", "races", "features", "traits", "conditions", "magic-items", "weapons", "armor"];

async function dndLookup(category: string, index: string) {
  const res = await httpGet(`https://www.dnd5eapi.co/api/2014/${encodeURIComponent(category)}/${encodeURIComponent(index.toLowerCase().replace(/\s+/g, "-"))}`);
  if (res.status === 404) throw new Error(`未找到 ${category}/${index}`);
  if (res.status !== 200) throw new Error(`D&D 5e API HTTP ${res.status}`);
  const data = JSON.parse(res.data);

  // Format based on category
  switch (category) {
    case "monsters": return {
      name: data.name,
      size: data.size,
      type: data.type,
      alignment: data.alignment,
      armor_class: Array.isArray(data.armor_class) ? data.armor_class.map((a: any) => a.value ?? a).join(", ") : data.armor_class,
      hit_points: data.hit_points,
      hit_dice: data.hit_dice,
      speed: data.speed,
      stats: { str: data.strength, dex: data.dexterity, con: data.constitution, int: data.intelligence, wis: data.wisdom, cha: data.charisma },
      challenge_rating: data.challenge_rating,
      xp: data.xp,
      special_abilities: (data.special_abilities || []).slice(0, 5).map((a: any) => ({
        name: a.name, desc: truncate(a.desc, 150),
      })),
      actions: (data.actions || []).slice(0, 5).map((a: any) => ({
        name: a.name, desc: truncate(a.desc, 150),
      })),
      image: data.image ? `https://www.dnd5eapi.co${data.image}` : undefined,
    };
    case "spells": return {
      name: data.name,
      level: data.level,
      school: data.school?.name,
      casting_time: data.casting_time,
      range: data.range,
      duration: data.duration,
      components: data.components,
      material: data.material ? truncate(data.material, 150) : undefined,
      concentration: data.concentration,
      ritual: data.ritual,
      desc: truncate((data.desc || []).join(" "), 400),
      higher_level: truncate((data.higher_level || []).join(" "), 200) || undefined,
      classes: data.classes?.map((c: any) => c.name) || [],
    };
    case "classes": return {
      name: data.name,
      hit_die: data.hit_die,
      proficiencies: (data.proficiencies || []).slice(0, 10).map((p: any) => p.name),
      saving_throws: data.saving_throws?.map((s: any) => s.name) || [],
      starting_equipment: (data.starting_equipment || []).slice(0, 8).map((e: any) => ({
        name: e.equipment?.name, quantity: e.quantity,
      })),
      spellcasting: data.spellcasting ? { level: data.spellcasting.level, ability: data.spellcasting.spellcasting_ability?.name } : undefined,
    };
    case "equipment":
    case "magic-items":
    case "weapons":
    case "armor": return {
      name: data.name,
      category: data.equipment_category?.name,
      cost: data.cost ? `${data.cost.quantity} ${data.cost.unit}` : undefined,
      weight: data.weight ? `${data.weight} lb` : undefined,
      desc: truncate((data.desc || []).join(" "), 400) || undefined,
      damage: data.damage ? { dice: data.damage.damage_dice, type: data.damage.damage_type?.name } : undefined,
      armor_class: data.armor_class ? { base: data.armor_class.base, dex_bonus: data.armor_class.dex_bonus } : undefined,
      properties: data.properties?.map((p: any) => p.name) || undefined,
      rarity: data.rarity?.name || undefined,
    };
    default: {
      // Generic: return key fields
      const result: Record<string, any> = { name: data.name || data.index };
      if (data.desc) result.desc = truncate(Array.isArray(data.desc) ? data.desc.join(" ") : data.desc, 400);
      if (data.type) result.type = data.type;
      if (data.level) result.level = data.level;
      return result;
    }
  }
}

async function dndSearch(category: string, query: string) {
  const res = await httpGet(`https://www.dnd5eapi.co/api/2014/${encodeURIComponent(category)}?name=${encodeURIComponent(query)}`);
  if (res.status !== 200) throw new Error(`D&D 5e API HTTP ${res.status}`);
  const data = JSON.parse(res.data);
  return (data.results || []).slice(0, 10).map((r: any) => ({
    index: r.index,
    name: r.name,
    url: r.url,
  }));
}

/* ================================================================== */
/*  Plugin definition                                                   */
/* ================================================================== */

const plugin = {
  id: "acg-db",
  name: "ACG Database",
  description: "PokeAPI + Enka (Genshin) + SWAPI (Star Wars) + D&D 5e",

  register(api: OpenClawPluginApi) {

    /* ---- pokemon_lookup ---- */
    api.registerTool({
      name: "pokemon_lookup",
      label: "宝可梦查询",
      description: `通过 PokeAPI 查询宝可梦信息。支持英文名或图鉴编号。
返回属性、种族值、特性、身高体重、立绘、中日文名称。

使用场景：
- "皮卡丘的种族值是多少"
- "查一下 charizard 的属性"
- "25号宝可梦是什么"`,
      parameters: Type.Object({
        name: Type.String({ description: "宝可梦名称（英文，如 pikachu）或图鉴编号（如 25）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const name = String(params.name || "").trim();
        if (!name) return { error: "请提供宝可梦名称或编号" };
        try {
          return await fetchPokemon(name);
        } catch (err) {
          return { error: `宝可梦查询失败: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    /* ---- genshin_player ---- */
    api.registerTool({
      name: "genshin_player",
      label: "原神玩家查询",
      description: `通过 Enka Network 查询原神玩家信息（UID）。
返回昵称、等级、世界等级、签名、深渊进度、角色展柜（含属性面板）。

使用场景：
- "查一下原神UID 800001234 的信息"
- "看看这个UID的角色面板"

注意：玩家需在游戏内展示角色详情，否则只能看到基本信息。`,
      parameters: Type.Object({
        uid: Type.String({ description: "原神UID（9位数字，如 800001234）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const uid = String(params.uid || "").trim();
        if (!uid || !/^\d{9,10}$/.test(uid)) return { error: "请提供有效的原神UID（9-10位数字）" };
        try {
          return await fetchGenshinPlayer(uid);
        } catch (err) {
          return { error: `原神查询失败: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    /* ---- starwars_search ---- */
    api.registerTool({
      name: "starwars_search",
      label: "星球大战查询",
      description: `通过 SWAPI 搜索星球大战数据库。
支持搜索人物(people)、星球(planets)、星舰(starships)、电影(films)、物种(species)、载具(vehicles)。

使用场景：
- "搜索星球大战里的 Luke"
- "星球大战里有哪些星舰"
- "查一下 Tatooine 星球"`,
      parameters: Type.Object({
        resource: Type.String({ description: `搜索类别: ${SWAPI_RESOURCES.join(", ")}` }),
        query: Type.String({ description: "搜索关键词（英文）" }),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const resource = String(params.resource || "").trim().toLowerCase();
        const query = String(params.query || "").trim();
        if (!resource || !SWAPI_RESOURCES.includes(resource)) {
          return { error: `无效的搜索类别。可选: ${SWAPI_RESOURCES.join(", ")}` };
        }
        if (!query) return { error: "请提供搜索关键词" };
        try {
          const results = await searchStarWars(resource, query);
          if (!results.length) return { message: `未找到与"${query}"匹配的 ${resource}` };
          return { resource, query, count: results.length, results };
        } catch (err) {
          return { error: `星球大战查询失败: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    /* ---- dnd_lookup ---- */
    api.registerTool({
      name: "dnd_lookup",
      label: "D&D 5e查询",
      description: `查询龙与地下城(D&D) 5e 数据库。
支持查询怪物(monsters)、法术(spells)、职业(classes)、装备(equipment)、种族(races)等。
可以通过索引直接查询，或通过名称搜索。

使用场景：
- "D&D里巨龙的属性是什么" → category=monsters, query=dragon
- "查一下火球术" → category=spells, index=fireball
- "搜索所有包含 sword 的装备" → category=equipment, query=sword

支持的类别: ${DND_CATEGORIES.join(", ")}`,
      parameters: Type.Object({
        category: Type.String({ description: `数据类别: ${DND_CATEGORIES.join(", ")}` }),
        index: Type.Optional(Type.String({ description: "条目索引（英文，用连字符分隔，如 adult-red-dragon, fireball）。直接查询时使用。" })),
        query: Type.Optional(Type.String({ description: "搜索关键词（英文）。模糊搜索时使用。" })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const category = String(params.category || "").trim().toLowerCase();
        const index = params.index ? String(params.index).trim() : "";
        const query = params.query ? String(params.query).trim() : "";

        if (!category || !DND_CATEGORIES.includes(category)) {
          return { error: `无效的类别。可选: ${DND_CATEGORIES.join(", ")}` };
        }
        if (!index && !query) return { error: "请提供 index（直接查询）或 query（搜索）" };

        try {
          if (index) {
            const result = await dndLookup(category, index);
            return { category, index, ...result };
          }
          // Search mode
          const results = await dndSearch(category, query);
          if (!results.length) return { message: `未找到与"${query}"匹配的 ${category}` };
          return {
            category,
            query,
            count: results.length,
            results,
            hint: "使用 index 参数可查看详细信息（如 index=\"adult-red-dragon\"）。",
          };
        } catch (err) {
          return { error: `D&D 5e 查询失败: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    console.log("[acg-db] Registered pokemon_lookup + genshin_player + starwars_search + dnd_lookup tools");
  },
};

export default plugin;
