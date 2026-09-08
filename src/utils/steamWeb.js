const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';
const API_BASE = 'https://api.steampowered.com';
const DEFAULT_TIMEOUT_MS = 2800;

/**
 * Executes an HTTP fetch with an enforced timeout via AbortController.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Maps Steam persona state integer to human-readable string.
 */
function getPersonaStateText(state) {
  switch (state) {
    case 0:
      return 'Offline';
    case 1:
      return 'Online';
    case 2:
      return 'Busy';
    case 3:
      return 'Away';
    case 4:
      return 'Snooze';
    case 5:
      return 'Looking to Trade';
    case 6:
      return 'Looking to Play';
    default:
      return 'Offline';
  }
}

/**
 * Resolves a raw target string (SteamID64, profile URL, or custom vanity URL) into a 64-bit SteamID.
 */
export async function resolveSteamId(rawTarget, apiKey) {
  if (!rawTarget || typeof rawTarget !== 'string') {
    return null;
  }

  const trimmed = rawTarget.trim();

  // Case 1: Pure 17-digit numeric SteamID64
  if (/^\d{17}$/.test(trimmed)) {
    return trimmed;
  }

  // Case 2: Full profile URL with SteamID64 (e.g. steamcommunity.com/profiles/76561197960287930)
  const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profileMatch) {
    return profileMatch[1];
  }

  // Case 3: Custom vanity URL (e.g. steamcommunity.com/id/gabelogannewell or just gabelogannewell)
  let vanityName = trimmed;
  const vanityUrlMatch = trimmed.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (vanityUrlMatch) {
    vanityName = vanityUrlMatch[1];
  } else {
    // Strip trailing slashes or URL query artifacts if user pasted loose text
    vanityName = vanityName.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split('/')[0];
  }

  if (!vanityName || !apiKey) {
    return null;
  }

  try {
    const endpoint = `${API_BASE}/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(vanityName)}`;
    const res = await fetchWithTimeout(endpoint);

    if (!res.ok) {
      console.warn(`Steam ResolveVanityURL returned status ${res.status} for vanity '${vanityName}'`);
      return null;
    }

    const data = await res.json();
    if (data?.response?.success === 1 && data?.response?.steamid) {
      return data.response.steamid;
    }

    return null;
  } catch (err) {
    console.error(`Error resolving Steam vanity URL '${vanityName}':`, err.message || err);
    return null;
  }
}

/**
 * Fetches player summary (Persona name, online status, avatar, creation date) from Steam.
 */
export async function getPlayerSummary(steamId64, apiKey) {
  if (!steamId64 || !apiKey) {
    return null;
  }

  try {
    const endpoint = `${API_BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId64}`;
    const res = await fetchWithTimeout(endpoint);

    if (!res.ok) {
      console.warn(`Steam GetPlayerSummaries returned status ${res.status} for ID ${steamId64}`);
      return null;
    }

    const data = await res.json();
    const player = data?.response?.players?.[0];

    if (!player) {
      return null;
    }

    return {
      steamId: player.steamid,
      personaName: player.personaname || 'Unknown Player',
      profileUrl: player.profileurl || `https://steamcommunity.com/profiles/${player.steamid}`,
      avatarUrl: player.avatarfull || player.avatarmedium || player.avatar || null,
      visibilityState: player.communityvisibilitystate || 1,
      isPrivate: player.communityvisibilitystate !== 3,
      personaState: player.personastate ?? 0,
      personaStateLabel: getPersonaStateText(player.personastate),
      currentlyPlaying: player.gameextrainfo || null,
      currentlyPlayingId: player.gameid || null,
      timeCreated: player.timecreated ? new Date(player.timecreated * 1000).toISOString().split('T')[0] : null,
      countryCode: player.loccountrycode || null,
      realName: player.realname || null,
    };
  } catch (err) {
    console.error(`Error fetching player summary for SteamID ${steamId64}:`, err.message || err);
    return null;
  }
}

/**
 * Fetches VAC and Community ban records for a player.
 */
export async function getPlayerBans(steamId64, apiKey) {
  if (!steamId64 || !apiKey) {
    return null;
  }

  try {
    const endpoint = `${API_BASE}/ISteamUser/GetPlayerBans/v1/?key=${apiKey}&steamids=${steamId64}`;
    const res = await fetchWithTimeout(endpoint);

    if (!res.ok) {
      console.warn(`Steam GetPlayerBans returned status ${res.status} for ID ${steamId64}`);
      return null;
    }

    const data = await res.json();
    const banRecord = data?.players?.[0];

    if (!banRecord) {
      return null;
    }

    return {
      communityBanned: Boolean(banRecord.CommunityBanned),
      vacBanned: Boolean(banRecord.VACBanned),
      vacBansCount: Number(banRecord.NumberOfVACBans || 0),
      gameBansCount: Number(banRecord.NumberOfGameBans || 0),
      daysSinceLastBan: Number(banRecord.DaysSinceLastBan || 0),
      economyBan: banRecord.EconomyBan || 'none',
    };
  } catch (err) {
    console.error(`Error fetching player bans for SteamID ${steamId64}:`, err.message || err);
    return null;
  }
}

/**
 * Fetches player owned games library and computes playtime metrics.
 */
export async function getPlayerOwnedGames(steamId64, apiKey) {
  if (!steamId64 || !apiKey) {
    return null;
  }

  try {
    const endpoint = `${API_BASE}/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId64}&include_appinfo=true&include_played_free_games=true`;
    const res = await fetchWithTimeout(endpoint);

    if (!res.ok) {
      console.warn(`Steam GetOwnedGames returned status ${res.status} for ID ${steamId64}`);
      return null;
    }

    const data = await res.json();
    const games = data?.response?.games;

    if (!games || !Array.isArray(games)) {
      return {
        isPrivate: true,
        gameCount: data?.response?.game_count || 0,
        totalPlaytimeHours: '0.0',
        topGames: [],
      };
    }

    const totalMinutes = games.reduce((acc, game) => acc + (game.playtime_forever || 0), 0);
    const totalHours = (totalMinutes / 60).toFixed(1);

    const sortedGames = [...games]
      .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
      .slice(0, 5)
      .map((game) => ({
        appId: game.appid,
        name: game.name || `App #${game.appid}`,
        playtimeHours: ((game.playtime_forever || 0) / 60).toFixed(1),
        playtimeMinutes: game.playtime_forever || 0,
      }));

    return {
      isPrivate: false,
      gameCount: data?.response?.game_count ?? games.length,
      totalPlaytimeHours: totalHours,
      topGames: sortedGames,
    };
  } catch (err) {
    console.error(`Error fetching owned games for SteamID ${steamId64}:`, err.message || err);
    return null;
  }
}

/**
 * Coordinates end-to-end resolution and fetches summary, bans, and game library statistics.
 */
export async function getCompletePlayerProfile(rawTarget, apiKey) {
  const steamId = await resolveSteamId(rawTarget, apiKey);
  if (!steamId) {
    return {
      success: false,
      error: 'RESOLVE_FAILED',
    };
  }

  const [summaryResult, bansResult, gamesResult] = await Promise.allSettled([
    getPlayerSummary(steamId, apiKey),
    getPlayerBans(steamId, apiKey),
    getPlayerOwnedGames(steamId, apiKey),
  ]);

  const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;

  if (!summary) {
    return {
      success: false,
      error: 'PROFILE_NOT_FOUND',
      steamId,
    };
  }

  const bans = bansResult.status === 'fulfilled' ? bansResult.value : null;
  const games = gamesResult.status === 'fulfilled' ? gamesResult.value : null;

  return {
    success: true,
    steamId,
    summary,
    bans,
    games,
  };
}

/**
 * Fetches the public Steam wishlist for a given SteamID64 using the official
 * Valve Steam Web API (IWishlistService/GetWishlist/v1).
 *
 * @param {string} steamId64 - 17-digit numeric SteamID
 * @param {string} [apiKey] - Valve Steam Web API Key
 * @returns {Promise<{ success: boolean, error?: string, items?: Array }>}
 */
export async function fetchSteamWishlist(steamId64, apiKey = process.env.STEAM_API_KEY) {
  if (!steamId64) {
    return { success: false, error: 'INVALID_ID' };
  }

  if (!apiKey) {
    return { success: false, error: 'CONFIG_REQUIRED' };
  }

  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId64}`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          'x-webapi-key': apiKey,
        },
      },
      2500
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { success: false, error: 'CONFIG_REQUIRED' };
      }
      return { success: false, error: 'FETCH_ERROR' };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { success: false, error: 'FETCH_ERROR' };
    }

    const rawItems = data?.response?.items;

    if (!rawItems || rawItems.length === 0) {
      // Verify if the profile itself is private or friends-only
      try {
        const summary = await getPlayerSummary(steamId64, apiKey);
        if (summary && summary.communityVisibilityState !== 3) {
          return { success: false, error: 'PRIVATE_OR_NOT_FOUND' };
        }
      } catch {
        // Fallback to error check
      }

      // Valve returns { response: {} } (undefined items) when wishlist privacy is private
      if (!rawItems) {
        return { success: false, error: 'PRIVATE_OR_NOT_FOUND' };
      }

      return { success: true, items: [] };
    }

    // Sort wishlist items by date_added descending (most recently added games first)
    const sortedItems = rawItems
      .map((item) => ({
        appId: String(item.appid ?? item.appId),
        priority: Number(item.priority || 0),
        dateAdded: Number(item.date_added || 0),
      }))
      .sort((a, b) => b.dateAdded - a.dateAdded);

    return { success: true, items: sortedItems };
  } catch (err) {
    console.error(`Error fetching Steam wishlist for SteamID ${steamId64}:`, err.message || err);
    return { success: false, error: 'FETCH_ERROR' };
  }
}

// Verified Steam AppID to Name registry for top institutional titles
const APP_DIRECTORY = {
  730: 'Counter-Strike 2',
  570: 'Dota 2',
  578080: 'PUBG: BATTLEGROUNDS',
  252490: 'Rust',
  1172470: 'Apex Legends',
  271590: 'Grand Theft Auto V',
  1086940: "Baldur's Gate 3",
  1245620: 'ELDEN RING',
  230410: 'Warframe',
  440: 'Team Fortress 2',
  346110: 'ARK: Survival Evolved',
  289070: "Sid Meier's Civilization VI",
  105600: 'Terraria',
  413150: 'Stardew Valley',
  1145360: 'Hades',
  1091500: 'Cyberpunk 2077',
  1623730: 'Palworld',
  2183900: 'Warhammer 40,000: Space Marine 2',
  550: 'Left 4 Dead 2',
  620: 'Portal 2',
  292030: 'The Witcher 3: Wild Hunt',
  1174180: 'Red Dead Redemption 2',
  892970: 'Valheim',
  218620: 'PAYDAY 2',
  4000: "Garry's Mod",
  227300: 'Euro Truck Simulator 2',
  275850: "No Man's Sky",
  431960: 'Wallpaper Engine',
  242760: 'The Forest',
  394360: 'Hearts of Iron IV',
  322330: "Don't Starve Together",
  281990: 'Stellaris',
  41700: 'S.T.A.L.K.E.R.: Call of Pripyat',
  221100: 'DayZ',
  294100: 'RimWorld',
  255710: 'Cities: Skylines',
  306130: 'The Elder Scrolls Online',
  203770: 'Crusader Kings II',
  219740: "Don't Starve",
  2050650: 'Resident Evil 4',
  1817070: "Marvel's Spider-Man Remastered",
  1817190: "Marvel's Spider-Man: Miles Morales",
  236850: 'Europa Universalis IV',
  374320: 'DARK SOULS™ III',
  582010: 'MONSTER HUNTER: WORLD',
  252950: 'Rocket League',
  381210: 'Dead by Daylight',
  1203220: 'NARAKA: BLADEPOINT',
  1938090: 'Call of Duty®',
  2358720: 'Black Myth: Wukong',
  1840080: 'HELLDIVERS™ 2',
  1172620: 'Sea of Thieves',
  945360: 'Among Us',
  1794680: 'Vampire Survivors',
  646570: 'Slay the Spire',
  883710: 'Resident Evil 2',
  1151640: 'Horizon Zero Dawn™',
  1593500: 'God of War',
  1888930: 'Armored Core VI Fires of Rubicon',
  2246340: 'Monster Hunter Wilds',
  1222670: 'The Sims™ 4',
  489830: 'The Elder Scrolls V: Skyrim Special Edition',
  359550: 'Tom Clancy\'s Rainbow Six® Siege',
  108600: 'Project Zomboid',
  1675200: 'Tiny Glade',
  264710: 'Subnautica',
  2399830: 'ARK: Survival Ascended',
  2073850: 'THE FINALS',
  2195250: 'EA SPORTS FC™ 24',
  2669320: 'EA SPORTS FC™ 25',
  1568590: 'Manor Lords',
  2379780: 'Balatro',
  2420110: 'Horizon Forbidden West™ Complete Edition',
  960090: 'Bloons TD 6',
  1446780: 'MONSTER HUNTER RISE',
  1238810: 'Battlefield™ 2042',
  1238840: 'Battlefield™ V',
  1238860: 'Battlefield™ 1',
  1235140: 'Yakuza: Like a Dragon',
  1364780: 'Street Fighter™ 6',
  1774580: 'STAR WARS Jedi: Survivor™',
  1151340: 'Fallout 76',
  377160: 'Fallout 4',
  22320: 'Fallout 3',
  22380: 'Fallout: New Vegas',
  1449850: 'Yu-Gi-Oh! Master Duel',
  990080: 'Hogwarts Legacy',
  1282100: 'Remnant II',
  1426210: 'It Takes Two',
  1326470: 'Sons Of The Forest',
  2124440: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
  1966720: 'Lethal Company',
  2215430: 'Ghost of Tsushima DIRECTOR\'S CUT',
  1240440: 'Halo Infinite',
  976730: 'Halo: The Master Chief Collection',
  526870: 'Satisfactory',
  427520: 'Factorio',
  1158310: 'Crusader Kings III',
  367520: 'Hollow Knight',
  1030300: 'Hollow Knight: Silksong',
  24780: 'SimCity 4 Deluxe',
  200510: 'XCOM: Enemy Unknown',
  268500: 'XCOM 2',
  1063730: 'New World',
};

/**
 * Resolves Steam AppIDs to game titles via memory directory and bounded Steam appdetails API.
 * Uses bounded concurrency and defensive timeouts to comply with Discord limits.
 *
 * @param {string[]} appIds - Array of numeric Steam AppIDs
 * @param {number} [timeoutMs=1200] - Total timeout budget for resolution (capped at 1200ms)
 * @returns {Promise<Map<string, string>>} Map of appId -> game title
 */
export async function resolveSteamAppTitles(appIds, timeoutMs = 1200) {
  const titleMap = new Map();
  if (!appIds || appIds.length === 0) {
    return titleMap;
  }

  // 1. Resolve known titles instantly from memory (0ms)
  const unmapped = [];
  for (const appId of appIds) {
    const stringId = String(appId);
    if (APP_DIRECTORY[stringId]) {
      const name = APP_DIRECTORY[stringId];
      titleMap.set(stringId, name);
      titleMap.set(Number(stringId), name);
    } else {
      unmapped.push(stringId);
    }
  }

  if (unmapped.length === 0) {
    return titleMap;
  }

  // 2. Fetch up to 20 unmapped titles concurrently with strict timeout (<= 1200ms)
  const toFetch = unmapped.slice(0, 20);
  const controller = new AbortController();
  const effectiveTimeout = Math.min(timeoutMs, 1200);
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    await Promise.all(
      toFetch.map(async (appId) => {
        try {
          const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`;
          const res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
          });
          if (res.ok) {
            const data = await res.json();
            const name = data?.[appId]?.data?.name;
            if (name) {
              titleMap.set(appId, name);
              titleMap.set(Number(appId), name);
            }
          }
        } catch {
          // Individual fetch failed or timed out; fallback will be used
        }
      })
    );
  } catch {
    // Timeout or abort
  } finally {
    clearTimeout(timer);
  }

  // 3. Immediately fall back to 'Steam App #${appId}' for all remaining unmapped titles without blocking
  for (const appId of appIds) {
    const stringId = String(appId);
    if (!titleMap.has(stringId)) {
      const fallbackTitle = `Steam App #${stringId}`;
      titleMap.set(stringId, fallbackTitle);
      titleMap.set(Number(stringId), fallbackTitle);
    }
  }

  return titleMap;
}

// Registry of known Free-to-Play institutional Steam AppIDs
export const KNOWN_F2P_APP_IDS = new Set([
  730,     // Counter-Strike 2
  570,     // Dota 2
  440,     // Team Fortress 2
  1172470, // Apex Legends
  230410,  // Warframe
  578080,  // PUBG: BATTLEGROUNDS
  2073850, // THE FINALS
  1203220, // NARAKA: BLADEPOINT
  1222670, // The Sims 4
  1240440, // Halo Infinite
  1449850, // Yu-Gi-Oh! Master Duel
  238960,  // Path of Exile
  1938090, // Call of Duty: Warzone
  252950,  // Rocket League
  304930,  // Unturned
  236390,  // War Thunder
  218230,  // PlanetSide 2
  1962660, // Marvel Snap
  107410,  // Arma 2: Free
  227930,  // RaceRoom Racing Experience
  209870,  // Blacklight: Retribution
  438100,  // VRChat
  386360,  // SMITE
  1049590, // Eternal Return
  212500,  // The Lord of the Rings Online
  39210,   // FINAL FANTASY XIV Online (Free trial)
  1281930, // tCell
]);

/**
 * Fetches detailed game library including AppID, name, playtime, and icon URL.
 * Excludes played free games at the Steam API level.
 *
 * @param {string} steamId64 - 17-digit SteamID
 * @param {string} apiKey - Steam Web API Key
 * @returns {Promise<{ isPrivate: boolean, gameCount: number, games: Array }|null>}
 */
export async function getPlayerLibraryDetailed(steamId64, apiKey) {
  if (!steamId64 || !apiKey) {
    return null;
  }

  try {
    const endpoint = `${API_BASE}/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId64}&include_appinfo=1&include_played_free_games=0&format=json`;
    const res = await fetchWithTimeout(endpoint, {}, 2500);

    if (!res.ok) {
      console.warn(`Steam GetOwnedGames returned status ${res.status} for ID ${steamId64}`);
      return null;
    }

    const data = await res.json();
    const games = data?.response?.games;

    if (!games || !Array.isArray(games)) {
      return {
        isPrivate: true,
        gameCount: data?.response?.game_count || 0,
        games: [],
      };
    }

    const detailedGames = games.map((g) => ({
      appid: g.appid,
      name: g.name || `App #${g.appid}`,
      playtime_forever: g.playtime_forever || 0,
      img_icon_url: g.img_icon_url || null,
    }));

    return {
      isPrivate: false,
      gameCount: data?.response?.game_count ?? detailedGames.length,
      games: detailedGames,
    };
  } catch (err) {
    console.error(`Error fetching detailed library for SteamID ${steamId64}:`, err.message || err);
    return null;
  }
}

/**
 * Computes the intersection of two player libraries, calculates dominance per title,
 * overall win tally, and sorts common titles by total combined playtime descending.
 * Pure function with zero external side effects.
 *
 * @param {Array} gamesA - Games list for Player A
 * @param {Array} gamesB - Games list for Player B
 * @returns {object} Comparison analytics
 */
export function compareLibraryData(gamesA, gamesB) {
  if (!Array.isArray(gamesA) || !Array.isArray(gamesB)) {
    return {
      commonCount: 0,
      winsA: 0,
      winsB: 0,
      ties: 0,
      overallWinner: 'TIE',
      totalHoursA: '0.0',
      totalHoursB: '0.0',
      commonGames: [],
    };
  }

  const mapA = new Map();
  for (const g of gamesA) {
    if (g?.appid) {
      mapA.set(Number(g.appid), g);
    }
  }

  const commonGames = [];
  let totalMinsA = 0;
  let totalMinsB = 0;

  for (const gB of gamesB) {
    if (!gB?.appid) continue;
    const appId = Number(gB.appid);
    if (mapA.has(appId)) {
      const gA = mapA.get(appId);
      const playtimeA = Number(gA.playtime_forever || 0);
      const playtimeB = Number(gB.playtime_forever || 0);
      const totalPlaytime = playtimeA + playtimeB;
      const winner = playtimeA > playtimeB ? 'A' : playtimeB > playtimeA ? 'B' : 'TIE';
      const diffMinutes = Math.abs(playtimeA - playtimeB);

      totalMinsA += playtimeA;
      totalMinsB += playtimeB;

      commonGames.push({
        appid: appId,
        name: gA.name || gB.name || `App #${appId}`,
        playtimeA,
        playtimeB,
        totalPlaytime,
        winner,
        diffMinutes,
        hoursA: (playtimeA / 60).toFixed(1),
        hoursB: (playtimeB / 60).toFixed(1),
        diffHours: (diffMinutes / 60).toFixed(1),
      });
    }
  }

  // Sort descending by total combined playtime
  commonGames.sort((a, b) => b.totalPlaytime - a.totalPlaytime);

  const winsA = commonGames.filter((g) => g.winner === 'A').length;
  const winsB = commonGames.filter((g) => g.winner === 'B').length;
  const ties = commonGames.filter((g) => g.winner === 'TIE').length;
  const overallWinner = winsA > winsB ? 'A' : winsB > winsA ? 'B' : 'TIE';

  return {
    commonCount: commonGames.length,
    totalCommon: commonGames.length,
    winsA,
    winsB,
    ties,
    overallWinner,
    totalHoursA: (totalMinsA / 60).toFixed(1),
    totalHoursB: (totalMinsB / 60).toFixed(1),
    commonGames,
  };
}

/**
 * Safely fetches player achievement count and unlocked count for a specific title.
 * Returns null if achievements are private, unsupported, or error occurs.
 */
export async function getPlayerAchievementsSafe(steamId64, appId, apiKey) {
  if (!steamId64 || !appId || !apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);

  try {
    const url = `${API_BASE}/ISteamUserStats/GetPlayerAchievements/v1/?key=${apiKey}&steamid=${steamId64}&appid=${appId}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) return null;

    const data = await res.json();
    const achievements = data?.playerstats?.achievements;
    if (!Array.isArray(achievements) || achievements.length === 0) return null;

    const unlocked = achievements.filter((a) => a.achieved === 1).length;
    const total = achievements.length;
    const percent = total > 0 ? Math.round((unlocked / total) * 100) : 0;

    return { total, unlocked, percent, gameName: data?.playerstats?.gameName || null };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * End-to-end library comparison between two Steam IDs.
 */
export async function compareLibraries(steamIdA, steamIdB, apiKey) {
  if (!steamIdA || !steamIdB || !apiKey) {
    return { success: false, error: 'INVALID_PARAMS' };
  }

  const [libA, libB] = await Promise.all([
    getPlayerLibraryDetailed(steamIdA, apiKey),
    getPlayerLibraryDetailed(steamIdB, apiKey),
  ]);

  if (!libA || !libB) {
    return { success: false, error: 'FETCH_ERROR' };
  }

  if (libA.isPrivate || libB.isPrivate) {
    return {
      success: false,
      error: 'PRIVATE_LIBRARY',
      privatePlayer: libA.isPrivate && libB.isPrivate ? 'BOTH' : libA.isPrivate ? 'A' : 'B',
      countA: libA.gameCount,
      countB: libB.gameCount,
    };
  }

  const comparison = compareLibraryData(libA.games, libB.games);

  let topAchievements = null;
  if (comparison.commonGames.length > 0) {
    const topAppId = comparison.commonGames[0].appid;
    try {
      const [achA, achB] = await Promise.all([
        getPlayerAchievementsSafe(steamIdA, topAppId, apiKey),
        getPlayerAchievementsSafe(steamIdB, topAppId, apiKey),
      ]);
      if (achA && achB) {
        topAchievements = {
          appId: topAppId,
          gameName: comparison.commonGames[0].name,
          achA,
          achB,
        };
      }
    } catch {
      // Graceful fallback
    }
  }

  return {
    success: true,
    countA: libA.gameCount,
    countB: libB.gameCount,
    ...comparison,
    topAchievements,
  };
}

/**
 * Analyzes paid backlog games: filters out games >= 60 mins and all free-to-play games.
 * Pure function with zero external network side-effects.
 *
 * @param {Array} games - Owned games list
 * @param {string} preferredCurrency - 'USD' or 'BRL'
 * @returns {object} Backlog telemetry metrics
 */
export function filterBacklogData(games, preferredCurrency = 'USD') {
  if (!Array.isArray(games)) {
    return {
      totalPaidCount: 0,
      totalPaidGames: 0,
      unplayedCount: 0,
      unplayedPaidCount: 0,
      playedCount: 0,
      neverPlayedCount: 0,
      neverOpenedCount: 0,
      startedCount: 0,
      abandonedCount: 0,
      backlogRatio: 0,
      backlogRatioPercent: 0,
      currencySymbol: preferredCurrency === 'BRL' ? 'R$' : '$',
      preferredCurrency,
      backlogGames: [],
    };
  }

  // Filter out free-to-play games using known registry and metadata
  const paidGames = games.filter((g) => {
    if (!g) return false;
    const appId = Number(g.appid || g.appId || 0);
    if (KNOWN_F2P_APP_IDS.has(appId)) return false;
    if (g.is_free || g.is_free_to_play) return false;
    return true;
  });

  const playedGames = [];
  const backlogGames = [];
  let neverPlayedCount = 0;
  let startedCount = 0;

  for (const game of paidGames) {
    const mins = Number(game.playtime_forever || game.playtimeMinutes || 0);
    const appId = Number(game.appid || game.appId || 0);
    const name = game.name || `App #${appId}`;

    const gameRecord = {
      appid: appId,
      name,
      playtime_forever: mins,
      img_icon_url: game.img_icon_url || null,
    };

    if (mins < 60) {
      backlogGames.push(gameRecord);
      if (mins === 0) {
        neverPlayedCount += 1;
      } else {
        startedCount += 1;
      }
    } else {
      playedGames.push(gameRecord);
    }
  }

  // Sort backlog games by playtime ascending (0 mins first, then least played)
  backlogGames.sort((a, b) => a.playtime_forever - b.playtime_forever);

  const totalPaidCount = paidGames.length;
  const unplayedCount = backlogGames.length;
  const playedCount = playedGames.length;
  const backlogRatio = totalPaidCount > 0 ? Number(((unplayedCount / totalPaidCount) * 100).toFixed(1)) : 0;
  const currencySymbol = preferredCurrency === 'BRL' ? 'R$' : '$';

  return {
    totalPaidCount,
    totalPaidGames: totalPaidCount,
    unplayedCount,
    unplayedPaidCount: unplayedCount,
    playedCount,
    neverPlayedCount,
    neverOpenedCount: neverPlayedCount,
    startedCount,
    abandonedCount: startedCount,
    backlogRatio,
    backlogRatioPercent: backlogRatio,
    currencySymbol,
    preferredCurrency,
    backlogGames,
  };
}

/**
 * End-to-end backlog telemetry retrieval and analysis for a Steam ID.
 */
export async function calculateBacklogTelemetry(steamId64, apiKey, preferredCurrency = 'USD') {
  if (!steamId64 || !apiKey) {
    return { success: false, error: 'INVALID_PARAMS' };
  }

  const library = await getPlayerLibraryDetailed(steamId64, apiKey);
  if (!library) {
    return { success: false, error: 'FETCH_ERROR' };
  }

  if (library.isPrivate) {
    return { success: false, error: 'PRIVATE_LIBRARY', gameCount: library.gameCount };
  }

  const telemetry = filterBacklogData(library.games, preferredCurrency);
  return {
    success: true,
    ...telemetry,
  };
}

/**
 * Executes a lightweight lookup to the Steam Storefront API to retrieve real-time pricing.
 * Employs a defensive 1200ms timeout using AbortController.
 *
 * @param {number|string} appId - Steam Application ID
 * @param {string} countryCode - 'us' or 'br'
 * @returns {Promise<string>} Formatted store price, 'Free / Included', or 'Delisted / Legacy'
 */
export async function fetchSteamAppStorePrice(appId, countryCode = 'us') {
  if (!appId) return 'Delisted / Legacy';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200);

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${countryCode}&filters=price_overview`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return 'Delisted / Legacy';
    }

    const data = await res.json();
    const appData = data?.[appId];

    if (!appData?.success || !appData?.data) {
      return 'Delisted / Legacy';
    }

    if (appData.data.is_free) {
      return 'Free / Included';
    }

    const priceOverview = appData.data.price_overview;
    if (priceOverview?.final_formatted) {
      return priceOverview.final_formatted;
    }

    return 'Delisted / Legacy';
  } catch {
    clearTimeout(timeoutId);
    return 'Delisted / Legacy';
  }
}

/**
 * Generates Discord interaction embed and pagination components for Steam Library Duel.
 */
export function buildDuelEmbedPayload(comparison, summaryA, summaryB, page = 1) {
  const PAGE_SIZE = 4;
  const totalGames = comparison?.commonGames?.length || 0;
  const totalPages = Math.max(1, Math.ceil(totalGames / PAGE_SIZE));
  const requestedPage = typeof page === 'number' && page >= 1 ? page : 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  const personaA = summaryA?.personaName || summaryA?.personaname || 'Player A';
  const personaB = summaryB?.personaName || summaryB?.personaname || 'Player B';
  const steamIdA = summaryA?.steamId || summaryA?.steamid || '';
  const steamIdB = summaryB?.steamId || summaryB?.steamid || '';
  const avatarA = summaryA?.avatarUrl || summaryA?.avatarfull || null;
  const avatarB = summaryB?.avatarUrl || summaryB?.avatarfull || null;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageGames = (comparison?.commonGames || []).slice(startIdx, startIdx + PAGE_SIZE);

  const diffBlocks = pageGames.map((g) => {
    if (g.winner === 'A') {
      return [
        '```diff',
        `[ ${g.name} ]`,
        `- ${personaB}: ${g.hoursB} hrs`,
        `+ ${personaA}: ${g.hoursA} hrs ★ Dominant (+${g.diffHours} hrs)`,
        '```',
      ].join('\n');
    } else if (g.winner === 'B') {
      return [
        '```diff',
        `[ ${g.name} ]`,
        `- ${personaA}: ${g.hoursA} hrs`,
        `+ ${personaB}: ${g.hoursB} hrs ★ Dominant (+${g.diffHours} hrs)`,
        '```',
      ].join('\n');
    } else {
      return [
        '```diff',
        `[ ${g.name} ]`,
        `! ${personaA}: ${g.hoursA} hrs`,
        `! ${personaB}: ${g.hoursB} hrs (Tied Playtime)`,
        '```',
      ].join('\n');
    }
  }).join('\n');

  const commonCount = comparison.commonCount ?? comparison.totalCommon ?? 0;
  const scoreboardDescription = [
    `Dominance Score: **${comparison.winsA}** (${personaA}) vs **${comparison.winsB}** (${personaB})`,
    `Total Time Invested: **${comparison.totalHoursA}h** vs **${comparison.totalHoursB}h** • **${commonCount}** Shared Titles`,
  ].join('\n');

  const fields = [
    {
      name: `Shared Titles Playtime Comparison [Page ${currentPage}/${totalPages}]`,
      value: diffBlocks || '*No shared titles on this page.*',
      inline: false,
    },
  ];

  const embed = {
    title: 'Steam Library Duel',
    author: {
      name: `${personaA} vs ${personaB} • Steam Duel`,
      icon_url: avatarA || undefined,
    },
    description: scoreboardDescription,
    color: 0x5865f2,
    fields,
    thumbnail: avatarB ? { url: avatarB } : undefined,
    footer: {
      text: `Page ${currentPage} of ${totalPages} • zT Radar • Steam Duel`,
    },
    timestamp: new Date().toISOString(),
  };

  const components = totalPages > 1 ? [
    {
      type: 1, // Action Row
      components: [
        {
          type: 2, // Button
          style: 2, // Secondary
          label: '◀ Prev',
          custom_id: `duel_p:${currentPage - 1}:${steamIdA}:${steamIdB}`,
          disabled: currentPage <= 1,
        },
        {
          type: 2, // Button
          style: 1, // Primary
          label: 'Next ▶',
          custom_id: `duel_p:${currentPage + 1}:${steamIdA}:${steamIdB}`,
          disabled: currentPage >= totalPages,
        },
      ],
    },
  ] : [];

  return { embed, embeds: [embed], components };
}

/**
 * Generates Discord interaction embed and pagination components for Steam Library Backlog.
 */
export async function buildBacklogEmbedPayload(telemetry, summary, page = 1, storePricesMap = null) {
  const PAGE_SIZE = 5;
  const totalUnplayed = telemetry.backlogGames.length;
  const totalPages = Math.max(1, Math.ceil(totalUnplayed / PAGE_SIZE));
  const requestedPage = typeof page === 'number' && page >= 1 ? page : 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  const personaName = summary?.personaName || summary?.personaname || 'Player';
  const steamId = summary?.steamId || summary?.steamid || '';
  const avatarUrl = summary?.avatarUrl || summary?.avatarfull || null;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageGames = telemetry.backlogGames.slice(startIdx, startIdx + PAGE_SIZE);

  const countryCode = telemetry.preferredCurrency === 'BRL' ? 'br' : 'us';

  const unplayedList = await Promise.all(
    pageGames.map(async (g) => {
      const timeLabel = g.playtime_forever === 0 ? 'Never Opened (0m)' : `${g.playtime_forever}m played`;
      let priceLabel = storePricesMap?.[g.appid];
      if (!priceLabel) {
        priceLabel = await fetchSteamAppStorePrice(g.appid, countryCode);
      }
      return [
        `❖ **${g.name}**`,
        `  └─ Playtime: \`${timeLabel}\` • Current Store: **${priceLabel}**`,
      ].join('\n');
    })
  );

  const unplayedListText = pageGames.length === 0
    ? '*No unplayed paid titles detected. 100% library completion rate!*'
    : unplayedList.join('\n');

  const fields = [
    {
      name: 'Paid Library',
      value: `**${telemetry.totalPaidCount}** Titles\n(${telemetry.playedCount} active)`,
      inline: true,
    },
    {
      name: 'Backlog Score',
      value: `**${telemetry.backlogRatio}%**\n(${telemetry.unplayedCount} unplayed)`,
      inline: true,
    },
    {
      name: 'Untouched Activity',
      value: `**${telemetry.neverPlayedCount}** Never Opened (0m)\n**${telemetry.startedCount}** Abandoned (<1h)`,
      inline: true,
    },
    {
      name: `Unplayed Paid Titles [Page ${currentPage}/${totalPages}]`,
      value: unplayedListText,
      inline: false,
    },
  ];

  const embed = {
    title: `Steam Library Backlog Intelligence ❖ ${personaName}`,
    description: `Paid library telemetry analysis detecting unplayed games, backlog percentage, and live store valuation.`,
    color: 0x5865f2,
    fields,
    thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
    footer: {
      text: `Page ${currentPage} of ${totalPages} • Currency: ${telemetry.preferredCurrency} • zT Radar Backlog Intelligence`,
    },
    timestamp: new Date().toISOString(),
  };

  const components = totalPages > 1 ? [
    {
      type: 1, // Action Row
      components: [
        {
          type: 2, // Button
          style: 2, // Secondary
          label: '◀ Prev',
          custom_id: `backlog_p:${currentPage - 1}:${steamId}`,
          disabled: currentPage <= 1,
        },
        {
          type: 2, // Button
          style: 1, // Primary
          label: 'Next ▶',
          custom_id: `backlog_p:${currentPage + 1}:${steamId}`,
          disabled: currentPage >= totalPages,
        },
      ],
    },
  ] : [];

  return { embed, embeds: [embed], components };
}

/**
 * Institutional registry of top Steam titles known to support multiplayer/co-op.
 * Maps AppID to specific badge tags.
 */
export const KNOWN_MULTIPLAYER_APP_IDS = new Map([
  [105600, ['Online Co-op', 'Multiplayer', 'Shared Screen']], // Terraria
  [413150, ['Online Co-op', 'Multiplayer', 'Shared Screen']], // Stardew Valley
  [620, ['Online Co-op', 'Shared Screen']],                   // Portal 2
  [550, ['Online Co-op', 'Multiplayer']],                     // Left 4 Dead 2
  [730, ['Multiplayer', 'Online PvP']],                       // Counter-Strike 2
  [570, ['Multiplayer', 'Online PvP']],                       // Dota 2
  [440, ['Multiplayer', 'Online Co-op']],                     // Team Fortress 2
  [218620, ['Online Co-op', 'Multiplayer']],                  // Payday 2
  [322330, ['Online Co-op', 'Multiplayer']],                  // Don't Starve Together
  [252490, ['Multiplayer', 'Online PvP']],                    // Rust
  [271590, ['Online Co-op', 'Multiplayer']],                  // GTA V
  [1174180, ['Online Co-op', 'Multiplayer']],                 // Red Dead Redemption 2
  [1086940, ['Online Co-op', 'Multiplayer']],                 // Baldur's Gate 3
  [1245620, ['Online Co-op', 'Multiplayer']],                 // ELDEN RING
  [1840080, ['Online Co-op', 'Multiplayer']],                 // HELLDIVERS 2
  [1966720, ['Online Co-op', 'Multiplayer']],                 // Lethal Company
  [1623730, ['Online Co-op', 'Multiplayer']],                 // Palworld
  [2183900, ['Online Co-op', 'Multiplayer']],                 // Warhammer 40k: Space Marine 2
  [892970, ['Online Co-op', 'Multiplayer']],                  // Valheim
  [739630, ['Online Co-op', 'Multiplayer']],                  // Phasmophobia
  [548430, ['Online Co-op', 'Multiplayer']],                  // Deep Rock Galactic
  [1426210, ['Online Co-op', 'Shared Screen']],               // It Takes Two
  [960090, ['Shared Screen', 'Multiplayer']],                 // Bloons TD 6
  [1794680, ['Shared Screen', 'Multiplayer']],                // Vampire Survivors
  [381210, ['Online Co-op', 'Multiplayer']],                  // Dead by Daylight
  [252950, ['Online Co-op', 'Multiplayer']],                  // Rocket League
  [1364780, ['Online Co-op', 'Multiplayer']],                 // Street Fighter 6
  [774171, ['Online Co-op', 'Multiplayer']],                  // Among Us
  [230410, ['Online Co-op', 'Multiplayer']],                  // Warframe
  [236390, ['Multiplayer', 'Online PvP']],                    // War Thunder
  [107410, ['Multiplayer', 'Online Co-op']],                  // Arma 3 / Arma 2
  [386360, ['Online Co-op', 'Multiplayer']],                  // SMITE
  [250900, ['Shared Screen']],                                // The Binding of Isaac: Rebirth
  [588650, ['Shared Screen', 'Multiplayer']],                 // Dead Cells
  [1046930, ['Online Co-op', 'Multiplayer']],                 // Risk of Rain 2
  [281990, ['Multiplayer', 'Online Co-op']],                  // Stellaris
  [289070, ['Multiplayer', 'Online Co-op']],                  // Sid Meier's Civilization VI
  [394360, ['Multiplayer', 'Online Co-op']],                  // Hearts of Iron IV
  [227300, ['Online Co-op', 'Multiplayer']],                  // Euro Truck Simulator 2
  [270880, ['Online Co-op', 'Multiplayer']],                  // American Truck Simulator
  [264710, ['Multiplayer', 'Online PvP']],                    // Subnautica
  [1145350, ['Online Co-op', 'Multiplayer']],                 // Hades II
  [1063730, ['Online Co-op', 'Multiplayer']],                 // New World
]);

/**
 * Resolves multiplayer badges for an AppID by combining institutional registry,
 * category IDs, and title keyword heuristics.
 *
 * @param {number} appId - Steam AppID
 * @param {string} [name=''] - Title name
 * @param {Array<number|object>} [categories=[]] - Category IDs or objects from Steam/ITAD
 * @returns {Array<string>} Array of badges (e.g. ['Online Co-op', 'Multiplayer'])
 */
export function resolveMultiplayerBadges(appId, name = '', categories = []) {
  const numericId = Number(appId);
  const badges = new Set();

  if (KNOWN_MULTIPLAYER_APP_IDS.has(numericId)) {
    for (const b of KNOWN_MULTIPLAYER_APP_IDS.get(numericId)) {
      badges.add(b);
    }
  }

  if (Array.isArray(categories)) {
    for (const cat of categories) {
      const catId = typeof cat === 'object' ? Number(cat.id) : Number(cat);
      if (catId === 38 || catId === 9 || catId === 39) {
        badges.add('Online Co-op');
      }
      if (catId === 1 || catId === 48 || catId === 49) {
        badges.add('Multiplayer');
      }
      if (catId === 24 || catId === 39) {
        badges.add('Shared Screen');
      }
    }
  }

  const titleLower = (name || '').toLowerCase();
  if (/\b(co-op|coop|together|team)\b/i.test(titleLower)) {
    badges.add('Online Co-op');
  }
  if (/\b(multiplayer|online|arena|versus|vs|party|deathmatch|battle|warzone|squad|royale)\b/i.test(titleLower)) {
    badges.add('Multiplayer');
  }

  return Array.from(badges);
}

/**
 * Pure function: Computes library intersection between Player A and Player B,
 * resolves multiplayer tags, filters by mode, and sorts descending by combined playtime.
 *
 * @param {Array} gamesA - Player A owned games
 * @param {Array} gamesB - Player B owned games
 * @param {string} [filterMode='coop'] - 'coop' (Multiplayer/Co-op only) or 'all'
 * @returns {object} Matching telemetry and games list
 */
export function matchLibraryData(gamesA, gamesB, filterMode = 'coop') {
  if (!Array.isArray(gamesA) || !Array.isArray(gamesB)) {
    return {
      totalCommon: 0,
      matchedCount: 0,
      filterMode,
      games: [],
    };
  }

  const mapA = new Map();
  for (const g of gamesA) {
    if (g?.appid) {
      mapA.set(Number(g.appid), g);
    }
  }

  const matched = [];
  let totalCommonCount = 0;

  for (const gB of gamesB) {
    if (!gB?.appid) continue;
    const appId = Number(gB.appid);
    if (mapA.has(appId)) {
      totalCommonCount += 1;
      const gA = mapA.get(appId);
      const playtimeA = Number(gA.playtime_forever || 0);
      const playtimeB = Number(gB.playtime_forever || 0);
      const totalPlaytime = playtimeA + playtimeB;
      const name = gA.name || gB.name || `App #${appId}`;

      const badges = resolveMultiplayerBadges(appId, name, gA.categories || gB.categories);
      const isCoopOrMultiplayer = badges.length > 0;

      if (filterMode === 'coop' && !isCoopOrMultiplayer) {
        continue;
      }

      matched.push({
        appid: appId,
        name,
        playtimeA,
        playtimeB,
        totalPlaytime,
        hoursA: (playtimeA / 60).toFixed(1),
        hoursB: (playtimeB / 60).toFixed(1),
        totalHours: (totalPlaytime / 60).toFixed(1),
        badges: isCoopOrMultiplayer ? badges : ['Single-player'],
        isCoop: isCoopOrMultiplayer,
        isCoopOrMultiplayer,
        img_icon_url: gA.img_icon_url || gB.img_icon_url || null,
      });
    }
  }

  // Sort descending by combined playtime, then alphabetically
  matched.sort((a, b) => {
    if (b.totalPlaytime !== a.totalPlaytime) {
      return b.totalPlaytime - a.totalPlaytime;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    success: true,
    totalCommon: totalCommonCount,
    matchedCount: matched.length,
    filterMode,
    games: matched,
    matchingGames: matched,
  };
}

/**
 * End-to-end multi-library co-op & multiplayer game discovery coordinator.
 *
 * @param {string} steamIdA - Player A SteamID64
 * @param {string} steamIdB - Player B SteamID64
 * @param {string} [filterMode='coop'] - 'coop' or 'all'
 * @param {string} apiKey - Steam Web API Key
 * @returns {Promise<object>} Match results
 */
export async function findMatchingGames(steamIdA, steamIdB, filterMode = 'coop', apiKey) {
  if (!steamIdA || !steamIdB || !apiKey) {
    return { success: false, error: 'INVALID_PARAMS' };
  }

  const [libA, libB] = await Promise.all([
    getPlayerLibraryDetailed(steamIdA, apiKey),
    getPlayerLibraryDetailed(steamIdB, apiKey),
  ]);

  if (!libA || !libB) {
    return { success: false, error: 'FETCH_ERROR' };
  }

  if (libA.isPrivate || libB.isPrivate) {
    return {
      success: false,
      error: 'PRIVATE_LIBRARY',
      privatePlayer: libA.isPrivate && libB.isPrivate ? 'BOTH' : libA.isPrivate ? 'A' : 'B',
      countA: libA.gameCount,
      countB: libB.gameCount,
    };
  }

  const matchData = matchLibraryData(libA.games, libB.games, filterMode);

  return {
    success: true,
    steamIdA,
    steamIdB,
    countA: libA.gameCount,
    countB: libB.gameCount,
    ...matchData,
  };
}

/**
 * Generates Discord Rich Embed and interactive pagination buttons for /game-match.
 *
 * @param {object} matchResult - Result from findMatchingGames or matchLibraryData
 * @param {object} summaryA - Player A summary
 * @param {object} summaryB - Player B summary
 * @param {number} [page=1] - Requested 1-based page index
 * @param {string} [filterMode='coop'] - 'coop' or 'all'
 * @returns {object} { embed, embeds: [embed], components }
 */
export function buildGameMatchEmbedPayload(matchResult, summaryA, summaryB, page = 1, filterMode = 'coop') {
  const PAGE_SIZE = 5;
  const games = matchResult?.matchingGames || matchResult?.games || [];
  const totalGames = games.length;
  const totalPages = Math.max(1, Math.ceil(totalGames / PAGE_SIZE));
  const requestedPage = typeof page === 'number' && page >= 1 ? page : 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  const personaA = summaryA?.personaName || summaryA?.personaname || 'Player A';
  const personaB = summaryB?.personaName || summaryB?.personaname || 'Player B';
  const steamIdA = matchResult?.steamIdA || summaryA?.steamId || summaryA?.steamid || '';
  const steamIdB = matchResult?.steamIdB || summaryB?.steamId || summaryB?.steamid || '';
  const avatarA = summaryA?.avatarUrl || summaryA?.avatarfull || null;
  const avatarB = summaryB?.avatarUrl || summaryB?.avatarfull || null;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageGames = games.slice(startIdx, startIdx + PAGE_SIZE);

  const filterLabel = filterMode === 'all' ? 'All Shared Games' : 'Co-op & Multiplayer Only';

  const descriptionLines = [
    `Shared Titles: **${matchResult.totalCommon ?? 0}** Games • Matched: **${matchResult.matchedCount ?? totalGames}** Titles`,
    `Filter Mode: **${filterLabel}**`,
  ];

  let gameCardsText = '';
  if (pageGames.length === 0) {
    gameCardsText = filterMode === 'coop'
      ? '*No common co-op or multiplayer titles found between these libraries. Try matching with filter: `all`.*'
      : '*No shared games found between these libraries.*';
  } else {
    gameCardsText = pageGames
      .map((g) => {
        const badgeStr = g.badges.map((b) => `\`[${b}]\``).join(' ');
        const storeLink = `https://store.steampowered.com/app/${g.appid}`;
        return [
          `❖ **${g.name}** ${badgeStr}`,
          `  └─ Combined Playtime: \`${g.totalHours} hrs\` (${personaA}: ${g.hoursA}h • ${personaB}: ${g.hoursB}h) • [Steam Store](${storeLink})`,
        ].join('\n');
      })
      .join('\n\n');
  }

  const fields = [
    {
      name: `Matched Titles [Page ${currentPage}/${totalPages}]`,
      value: gameCardsText,
      inline: false,
    },
  ];

  const embed = {
    author: {
      name: `${personaA} ✖ ${personaB} • Game Match`,
      icon_url: avatarA || undefined,
    },
    title: 'Steam Library Match',
    description: descriptionLines.join('\n'),
    color: 0x5865f2,
    fields,
    thumbnail: avatarB ? { url: avatarB } : undefined,
    footer: {
      text: `Page ${currentPage} of ${totalPages} • Filter: ${filterMode} • zT Radar Co-op Discovery`,
    },
    timestamp: new Date().toISOString(),
  };

  const components = totalPages > 1 ? [
    {
      type: 1, // Action Row
      components: [
        {
          type: 2, // Button
          style: 2, // Secondary
          label: '◀ Prev',
          custom_id: `match_p:${currentPage - 1}:${filterMode}:${steamIdA}:${steamIdB}`,
          disabled: currentPage <= 1,
        },
        {
          type: 2, // Button
          style: 1, // Primary
          label: 'Next ▶',
          custom_id: `match_p:${currentPage + 1}:${filterMode}:${steamIdA}:${steamIdB}`,
          disabled: currentPage >= totalPages,
        },
      ],
    },
  ] : [];

  return { embed, embeds: [embed], components };
}
