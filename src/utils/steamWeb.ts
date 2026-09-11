/**
 * Steam Web Intelligence Utility
 *
 * Provides player profile resolution, library analysis, duel comparison,
 * backlog telemetry, co-op game matching, and Discord embed builders.
 * Uses native Node.js fetch with defensive AbortController timeouts.
 */

import type {
  SteamOwnedGame,
  SteamPlayerSummary,
  SteamPlayerBans,
  SteamTopGamesResult,
  SteamDetailedLibrary,
  SteamCompleteProfile,
  SteamWishlistResult,
  SteamAppPriceInfo,
  CommonGame,
  LibraryComparisonResult,
  AchievementResult,
  TopAchievements,
  LibraryCompareResult,
  MatchedGame,
  MatchLibraryResult,
  FindMatchingGamesResult,
  BacklogTelemetry,
  BacklogMsrpResult,
  BacklogTelemetryResult,
  EmbedPayload,
  DiscordEmbed,
} from '../types/index.js';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';
const API_BASE = 'https://api.steampowered.com';
const DEFAULT_TIMEOUT_MS = 2800;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Executes an HTTP fetch with an enforced timeout via AbortController.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        ...((options.headers as Record<string, string>) ?? {}),
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
function getPersonaStateText(state: number): string {
  switch (state) {
    case 0: return 'Offline';
    case 1: return 'Online';
    case 2: return 'Busy';
    case 3: return 'Away';
    case 4: return 'Snooze';
    case 5: return 'Looking to Trade';
    case 6: return 'Looking to Play';
    default: return 'Offline';
  }
}

// ---------------------------------------------------------------------------
// Steam ID Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a raw target string (SteamID64, profile URL, or custom vanity URL) into a 64-bit SteamID.
 */
export async function resolveSteamId(rawTarget: string, apiKey: string): Promise<string | null> {
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

    const data = await res.json() as { response?: { success?: number; steamid?: string } };
    if (data?.response?.success === 1 && data?.response?.steamid) {
      return data.response.steamid;
    }

    return null;
  } catch (err) {
    console.error(`Error resolving Steam vanity URL '${vanityName}':`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Player Summary & Bans
// ---------------------------------------------------------------------------

type RawSteamPlayer = {
  steamid: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  avatarmedium?: string;
  avatar?: string;
  communityvisibilitystate?: number;
  personastate?: number;
  gameextrainfo?: string;
  gameid?: string;
  timecreated?: number;
  loccountrycode?: string;
  realname?: string;
};

/**
 * Fetches player summary (Persona name, online status, avatar, creation date) from Steam.
 */
export async function getPlayerSummary(steamId64: string, apiKey: string): Promise<SteamPlayerSummary | null> {
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

    const data = await res.json() as { response?: { players?: RawSteamPlayer[] } };
    const player = data?.response?.players?.[0];

    if (!player) {
      return null;
    }

    return {
      steamId: player.steamid,
      personaName: player.personaname ?? 'Unknown Player',
      profileUrl: player.profileurl ?? `https://steamcommunity.com/profiles/${player.steamid}`,
      avatarUrl: player.avatarfull ?? player.avatarmedium ?? player.avatar ?? null,
      visibilityState: player.communityvisibilitystate ?? 1,
      isPrivate: player.communityvisibilitystate !== 3,
      personaState: player.personastate ?? 0,
      personaStateLabel: getPersonaStateText(player.personastate ?? 0),
      currentlyPlaying: player.gameextrainfo ?? null,
      currentlyPlayingId: player.gameid ?? null,
      timeCreated: player.timecreated ? new Date(player.timecreated * 1000).toISOString().split('T')[0] : null,
      countryCode: player.loccountrycode ?? null,
      realName: player.realname ?? null,
    };
  } catch (err) {
    console.error(`Error fetching player summary for SteamID ${steamId64}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

type RawBanRecord = {
  CommunityBanned?: boolean;
  VACBanned?: boolean;
  NumberOfVACBans?: number;
  NumberOfGameBans?: number;
  DaysSinceLastBan?: number;
  EconomyBan?: string;
};

/**
 * Fetches VAC and Community ban records for a player.
 */
export async function getPlayerBans(steamId64: string, apiKey: string): Promise<SteamPlayerBans | null> {
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

    const data = await res.json() as { players?: RawBanRecord[] };
    const banRecord = data?.players?.[0];

    if (!banRecord) {
      return null;
    }

    return {
      communityBanned: Boolean(banRecord.CommunityBanned),
      vacBanned: Boolean(banRecord.VACBanned),
      vacBansCount: Number(banRecord.NumberOfVACBans ?? 0),
      gameBansCount: Number(banRecord.NumberOfGameBans ?? 0),
      daysSinceLastBan: Number(banRecord.DaysSinceLastBan ?? 0),
      economyBan: banRecord.EconomyBan ?? 'none',
    };
  } catch (err) {
    console.error(`Error fetching player bans for SteamID ${steamId64}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

type RawOwnedGame = {
  appid: number;
  name?: string;
  playtime_forever?: number;
};

/**
 * Fetches player owned games library and computes playtime metrics.
 */
export async function getPlayerOwnedGames(steamId64: string, apiKey: string): Promise<SteamTopGamesResult | null> {
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

    const data = await res.json() as { response?: { games?: RawOwnedGame[]; game_count?: number } };
    const games = data?.response?.games;

    if (!games || !Array.isArray(games)) {
      return {
        isPrivate: true,
        gameCount: data?.response?.game_count ?? 0,
        totalPlaytimeHours: '0.0',
        topGames: [],
      };
    }

    const totalMinutes = games.reduce((acc, game) => acc + (game.playtime_forever ?? 0), 0);
    const totalHours = (totalMinutes / 60).toFixed(1);

    const sortedGames = [...games]
      .sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0))
      .slice(0, 5)
      .map((game) => ({
        appId: game.appid,
        name: game.name ?? `App #${game.appid}`,
        playtimeHours: ((game.playtime_forever ?? 0) / 60).toFixed(1),
        playtimeMinutes: game.playtime_forever ?? 0,
      }));

    return {
      isPrivate: false,
      gameCount: data?.response?.game_count ?? games.length,
      totalPlaytimeHours: totalHours,
      topGames: sortedGames,
    };
  } catch (err) {
    console.error(`Error fetching owned games for SteamID ${steamId64}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Coordinates end-to-end resolution and fetches summary, bans, and game library statistics.
 */
export async function getCompletePlayerProfile(rawTarget: string, apiKey: string): Promise<SteamCompleteProfile> {
  const steamId = await resolveSteamId(rawTarget, apiKey);
  if (!steamId) {
    return { success: false, error: 'RESOLVE_FAILED' };
  }

  const [summaryResult, bansResult, gamesResult] = await Promise.allSettled([
    getPlayerSummary(steamId, apiKey),
    getPlayerBans(steamId, apiKey),
    getPlayerOwnedGames(steamId, apiKey),
  ]);

  const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;

  if (!summary) {
    return { success: false, error: 'PROFILE_NOT_FOUND', steamId };
  }

  const bans = bansResult.status === 'fulfilled' ? bansResult.value : null;
  const games = gamesResult.status === 'fulfilled' ? gamesResult.value : null;

  return { success: true, steamId, summary, bans, games };
}

// ---------------------------------------------------------------------------
// Wishlist
// ---------------------------------------------------------------------------

type RawWishlistItem = {
  appid?: number | string;
  appId?: number | string;
  priority?: number;
  date_added?: number;
};

/**
 * Fetches the public Steam wishlist for a given SteamID64 using the official
 * Valve Steam Web API (IWishlistService/GetWishlist/v1).
 */
export async function fetchSteamWishlist(
  steamId64: string,
  apiKey: string = process.env['STEAM_API_KEY'] ?? '',
): Promise<SteamWishlistResult> {
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
      { headers: { 'x-webapi-key': apiKey } },
      2500
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { success: false, error: 'CONFIG_REQUIRED' };
      }
      return { success: false, error: 'FETCH_ERROR' };
    }

    let data: { response?: { items?: RawWishlistItem[] } };
    try {
      data = await res.json() as { response?: { items?: RawWishlistItem[] } };
    } catch {
      return { success: false, error: 'FETCH_ERROR' };
    }

    const rawItems = data?.response?.items;

    if (!rawItems || rawItems.length === 0) {
      // Verify if the profile itself is private or friends-only
      try {
        const summary = await getPlayerSummary(steamId64, apiKey);
        if (summary && !summary.isPrivate) {
          // Profile is public but wishlist may be empty
        }
      } catch {
        // Fallback to error check
      }

      if (!rawItems) {
        return { success: false, error: 'PRIVATE_OR_NOT_FOUND' };
      }

      return { success: true, items: [] };
    }

    // Sort wishlist items by date_added descending (most recently added games first)
    const sortedItems = rawItems
      .map((item) => ({
        appId: String(item.appid ?? item.appId),
        priority: Number(item.priority ?? 0),
        dateAdded: Number(item.date_added ?? 0),
      }))
      .sort((a, b) => b.dateAdded - a.dateAdded);

    return { success: true, items: sortedItems };
  } catch (err) {
    console.error(`Error fetching Steam wishlist for SteamID ${steamId64}:`, err instanceof Error ? err.message : err);
    return { success: false, error: 'FETCH_ERROR' };
  }
}

// ---------------------------------------------------------------------------
// App Title Resolution
// ---------------------------------------------------------------------------

// Verified Steam AppID to Name registry for top institutional titles
const APP_DIRECTORY: Record<string, string> = {
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
  374320: 'DARK SOULS\u2122 III',
  582010: 'MONSTER HUNTER: WORLD',
  252950: 'Rocket League',
  381210: 'Dead by Daylight',
  1203220: 'NARAKA: BLADEPOINT',
  1938090: 'Call of Duty\u00ae',
  2358720: 'Black Myth: Wukong',
  1840080: 'HELLDIVERS\u2122 2',
  1172620: 'Sea of Thieves',
  945360: 'Among Us',
  1794680: 'Vampire Survivors',
  646570: 'Slay the Spire',
  883710: 'Resident Evil 2',
  1151640: 'Horizon Zero Dawn\u2122',
  1593500: 'God of War',
  1888930: 'Armored Core VI Fires of Rubicon',
  2246340: 'Monster Hunter Wilds',
  1222670: 'The Sims\u2122 4',
  489830: 'The Elder Scrolls V: Skyrim Special Edition',
  359550: "Tom Clancy's Rainbow Six\u00ae Siege",
  108600: 'Project Zomboid',
  1675200: 'Tiny Glade',
  264710: 'Subnautica',
  2399830: 'ARK: Survival Ascended',
  2073850: 'THE FINALS',
  2195250: 'EA SPORTS FC\u2122 24',
  2669320: 'EA SPORTS FC\u2122 25',
  1568590: 'Manor Lords',
  2379780: 'Balatro',
  2420110: 'Horizon Forbidden West\u2122 Complete Edition',
  960090: 'Bloons TD 6',
  1446780: 'MONSTER HUNTER RISE',
  1238810: 'Battlefield\u2122 2042',
  1238840: 'Battlefield\u2122 V',
  1238860: 'Battlefield\u2122 1',
  1235140: 'Yakuza: Like a Dragon',
  1364780: 'Street Fighter\u2122 6',
  1774580: 'STAR WARS Jedi: Survivor\u2122',
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
  2215430: "Ghost of Tsushima DIRECTOR'S CUT",
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
 */
export async function resolveSteamAppTitles(
  appIds: Array<string | number>,
  timeoutMs: number = 1200,
): Promise<Map<string | number, string>> {
  const titleMap = new Map<string | number, string>();
  if (!appIds || appIds.length === 0) {
    return titleMap;
  }

  // 1. Resolve known titles instantly from memory (0ms)
  const unmapped: string[] = [];
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
            const data = await res.json() as Record<string, { data?: { name?: string } }>;
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

  // 3. Immediately fall back to 'Steam App #${appId}' for all remaining unmapped titles
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

// ---------------------------------------------------------------------------
// F2P Registry & Detailed Library
// ---------------------------------------------------------------------------

// Registry of known Free-to-Play institutional Steam AppIDs
export const KNOWN_F2P_APP_IDS = new Set<number>([
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
 */
export async function getPlayerLibraryDetailed(steamId64: string, apiKey: string): Promise<SteamDetailedLibrary | null> {
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

    const data = await res.json() as {
      response?: {
        games?: Array<{ appid: number; name?: string; playtime_forever?: number; img_icon_url?: string }>;
        game_count?: number;
      };
    };
    const games = data?.response?.games;

    if (!games || !Array.isArray(games)) {
      return {
        isPrivate: true,
        gameCount: data?.response?.game_count ?? 0,
        games: [],
      };
    }

    const detailedGames: SteamOwnedGame[] = games.map((g) => ({
      appid: g.appid,
      name: g.name ?? `App #${g.appid}`,
      playtime_forever: g.playtime_forever ?? 0,
      img_icon_url: g.img_icon_url ?? null,
    }));

    return {
      isPrivate: false,
      gameCount: data?.response?.game_count ?? detailedGames.length,
      games: detailedGames,
    };
  } catch (err) {
    console.error(`Error fetching detailed library for SteamID ${steamId64}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Library Comparison
// ---------------------------------------------------------------------------

/**
 * Computes the intersection of two player libraries, calculates dominance per title,
 * overall win tally, and sorts common titles by total combined playtime descending.
 * Pure function with zero external side effects.
 */
export function compareLibraryData(
  gamesA: SteamOwnedGame[],
  gamesB: SteamOwnedGame[],
): LibraryComparisonResult {
  if (!Array.isArray(gamesA) || !Array.isArray(gamesB)) {
    return {
      commonCount: 0,
      totalCommon: 0,
      winsA: 0,
      winsB: 0,
      ties: 0,
      overallWinner: 'TIE',
      totalHoursA: '0.0',
      totalHoursB: '0.0',
      commonGames: [],
    };
  }

  const mapA = new Map<number, SteamOwnedGame>();
  for (const g of gamesA) {
    if (g?.appid) {
      mapA.set(Number(g.appid), g);
    }
  }

  const commonGames: CommonGame[] = [];
  let totalMinsA = 0;
  let totalMinsB = 0;

  for (const gB of gamesB) {
    if (!gB?.appid) continue;
    const appId = Number(gB.appid);
    if (mapA.has(appId)) {
      const gA = mapA.get(appId)!;
      const playtimeA = Number(gA.playtime_forever ?? 0);
      const playtimeB = Number(gB.playtime_forever ?? 0);
      const totalPlaytime = playtimeA + playtimeB;
      const winner: 'A' | 'B' | 'TIE' = playtimeA > playtimeB ? 'A' : playtimeB > playtimeA ? 'B' : 'TIE';
      const diffMinutes = Math.abs(playtimeA - playtimeB);

      totalMinsA += playtimeA;
      totalMinsB += playtimeB;

      commonGames.push({
        appid: appId,
        name: gA.name ?? gB.name ?? `App #${appId}`,
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
  const overallWinner: 'A' | 'B' | 'TIE' = winsA > winsB ? 'A' : winsB > winsA ? 'B' : 'TIE';

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
export async function getPlayerAchievementsSafe(
  steamId64: string,
  appId: number,
  apiKey: string,
): Promise<AchievementResult | null> {
  if (!steamId64 || !appId || !apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);

  type RawAchievement = { achieved: number };
  type AchievementsResponse = { playerstats?: { achievements?: RawAchievement[]; gameName?: string } };

  try {
    const url = `${API_BASE}/ISteamUserStats/GetPlayerAchievements/v1/?key=${apiKey}&steamid=${steamId64}&appid=${appId}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) return null;

    const data = await res.json() as AchievementsResponse;
    const achievements = data?.playerstats?.achievements;
    if (!Array.isArray(achievements) || achievements.length === 0) return null;

    const unlocked = achievements.filter((a) => a.achieved === 1).length;
    const total = achievements.length;
    const percent = total > 0 ? Math.round((unlocked / total) * 100) : 0;

    return { total, unlocked, percent, gameName: data?.playerstats?.gameName ?? null };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * End-to-end library comparison between two Steam IDs.
 */
export async function compareLibraries(
  steamIdA: string,
  steamIdB: string,
  apiKey: string,
): Promise<LibraryCompareResult> {
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

  let topAchievements: TopAchievements | null = null;
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

// ---------------------------------------------------------------------------
// Backlog Analysis
// ---------------------------------------------------------------------------

/**
 * Analyzes paid backlog games: filters out games >= 60 mins and all free-to-play games.
 * Pure function with zero external network side-effects.
 */
export function filterBacklogData(
  games: SteamOwnedGame[],
  preferredCurrency: string = 'USD',
): BacklogTelemetry {
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
    const appId = Number(g.appid ?? 0);
    if (KNOWN_F2P_APP_IDS.has(appId)) return false;
    if (g.is_free || g.is_free_to_play) return false;
    return true;
  });

  const playedGames: SteamOwnedGame[] = [];
  const backlogGames: SteamOwnedGame[] = [];
  let neverPlayedCount = 0;
  let startedCount = 0;

  for (const game of paidGames) {
    const mins = Number(game.playtime_forever ?? 0);
    const appId = Number(game.appid ?? 0);
    const name = game.name ?? `App #${appId}`;

    const gameRecord: SteamOwnedGame = {
      appid: appId,
      name,
      playtime_forever: mins,
      img_icon_url: game.img_icon_url ?? null,
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
 * Pure function: Computes total base MSRP for unplayed backlog games from a price map.
 * Sums regular base retail prices (ignoring temporary discount cuts), skips free titles,
 * and tracks the count of successfully priced titles.
 */
export function calculateBacklogMsrp(
  backlogGames: SteamOwnedGame[],
  priceMap: Map<number, SteamAppPriceInfo> | Record<number, SteamAppPriceInfo>,
  preferredCurrency: string = 'USD',
): BacklogMsrpResult {
  const sym = preferredCurrency === 'BRL' ? 'R$' : '$';
  const totalUnplayed = Array.isArray(backlogGames) ? backlogGames.length : 0;
  let totalMsrp = 0;
  let pricedCount = 0;

  if (Array.isArray(backlogGames) && priceMap) {
    for (const g of backlogGames) {
      const appId = Number(g.appid ?? 0);
      const priceInfo = priceMap instanceof Map ? priceMap.get(appId) : (priceMap as Record<number, SteamAppPriceInfo>)[appId];
      if (!priceInfo) continue;
      if (priceInfo.isFree || priceInfo.isDelisted) continue;

      const basePrice = Number(priceInfo.initial || priceInfo.final || priceInfo.price || 0);
      if (basePrice > 0) {
        totalMsrp += basePrice;
        pricedCount += 1;
      }
    }
  }

  const formattedVal = totalMsrp.toFixed(2);
  const msrpFormatted = `${sym} ${formattedVal}`;
  const msrpSummary = `${msrpFormatted} (${pricedCount}/${totalUnplayed} priced)`;

  return {
    totalMsrp: Number(formattedVal),
    pricedCount,
    totalUnplayed,
    totalBacklog: totalUnplayed,
    currencySymbol: sym,
    msrpFormatted,
    formattedTotalMsrp: msrpFormatted,
    msrpSummary,
  };
}

/**
 * Batch fetches Steam Storefront price overview for multiple application IDs.
 * Divides IDs into chunks of 25 to respect URL and API limitations.
 */
export async function batchFetchSteamAppPrices(
  appIds: Array<number | string>,
  countryCode: string = 'us',
  maxBatch: number = 100,
): Promise<Map<number, SteamAppPriceInfo>> {
  const priceMap = new Map<number, SteamAppPriceInfo>();
  if (!Array.isArray(appIds) || appIds.length === 0) return priceMap;

  const targetIds = appIds.slice(0, maxBatch).map(Number).filter(Boolean);
  if (targetIds.length === 0) return priceMap;

  const CHUNK_SIZE = 25;
  const chunks: number[][] = [];
  for (let i = 0; i < targetIds.length; i += CHUNK_SIZE) {
    chunks.push(targetIds.slice(i, i + CHUNK_SIZE));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);

  type AppDetailsResponse = Record<string, {
    success: boolean;
    data?: {
      is_free?: boolean;
      price_overview?: {
        initial?: number;
        final?: number;
        initial_formatted?: string;
        final_formatted?: string;
      };
    };
  }>;

  try {
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const url = `https://store.steampowered.com/api/appdetails?appids=${chunk.join(',')}&cc=${countryCode}&filters=price_overview`;
          const res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
          });
          if (!res.ok) return;
          const data = await res.json() as AppDetailsResponse;
          if (!data || typeof data !== 'object') return;

          for (const [idStr, appObj] of Object.entries(data)) {
            const appId = Number(idStr);
            if (!appObj?.success) {
              priceMap.set(appId, { isDelisted: true });
              continue;
            }
            if (appObj.data?.is_free) {
              priceMap.set(appId, { isFree: true });
              continue;
            }
            const overview = appObj.data?.price_overview;
            if (overview) {
              const initialCents = Number(overview.initial ?? overview.final ?? 0);
              const finalCents = Number(overview.final ?? 0);
              priceMap.set(appId, {
                initial: initialCents / 100,
                final: finalCents / 100,
                initialFormatted: overview.initial_formatted ?? '',
                finalFormatted: overview.final_formatted ?? '',
                isFree: false,
              });
            }
          }
        } catch {
          // Gracefully continue on chunk failure
        }
      })
    );
  } finally {
    clearTimeout(timer);
  }

  return priceMap;
}

/**
 * End-to-end backlog telemetry retrieval and analysis for a Steam ID.
 */
export async function calculateBacklogTelemetry(
  steamId64: string,
  apiKey: string,
  preferredCurrency: string = 'USD',
): Promise<BacklogTelemetryResult> {
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
  const countryCode = preferredCurrency === 'BRL' ? 'br' : 'us';

  const backlogAppIds = telemetry.backlogGames.map((g) => g.appid);
  let priceMap = new Map<number, SteamAppPriceInfo>();
  try {
    priceMap = await batchFetchSteamAppPrices(backlogAppIds, countryCode, 100);
  } catch {
    // Non-blocking fallback
  }

  const msrpData = calculateBacklogMsrp(telemetry.backlogGames, priceMap, preferredCurrency);

  const storePricesMap: Record<number, string> = {};
  for (const [appId, p] of priceMap.entries()) {
    if (p.isFree) {
      storePricesMap[appId] = 'Free / Included';
    } else if (p.isDelisted) {
      storePricesMap[appId] = 'Delisted / Legacy';
    } else if (p.finalFormatted) {
      storePricesMap[appId] = p.finalFormatted;
    }
  }

  return {
    success: true,
    ...telemetry,
    ...msrpData,
    storePricesMap,
  };
}

/**
 * Executes a lightweight lookup to the Steam Storefront API to retrieve real-time pricing.
 * Employs a defensive 1200ms timeout using AbortController.
 */
export async function fetchSteamAppStorePrice(
  appId: number | string,
  countryCode: string = 'us',
): Promise<string> {
  if (!appId) return 'Delisted / Legacy';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200);

  type AppDetailsSingle = Record<string | number, {
    success?: boolean;
    data?: {
      is_free?: boolean;
      price_overview?: { final_formatted?: string };
    };
  }>;

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

    const data = await res.json() as AppDetailsSingle;
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

// ---------------------------------------------------------------------------
// Embed Builders — Duel
// ---------------------------------------------------------------------------

type PlayerSummaryLike = {
  personaName?: string;
  personaname?: string;
  steamId?: string;
  steamid?: string;
  avatarUrl?: string | null;
  avatarfull?: string | null;
};

/**
 * Generates Discord interaction embed and pagination components for Steam Library Duel.
 */
export function buildDuelEmbedPayload(
  comparison: LibraryComparisonResult,
  summaryA: PlayerSummaryLike,
  summaryB: PlayerSummaryLike,
  page: number = 1,
): EmbedPayload {
  const PAGE_SIZE = 4;
  const totalGames = comparison?.commonGames?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalGames / PAGE_SIZE));
  const requestedPage = typeof page === 'number' && page >= 1 ? page : 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  const personaA = summaryA?.personaName ?? summaryA?.personaname ?? 'Player A';
  const personaB = summaryB?.personaName ?? summaryB?.personaname ?? 'Player B';
  const steamIdA = summaryA?.steamId ?? summaryA?.steamid ?? '';
  const steamIdB = summaryB?.steamId ?? summaryB?.steamid ?? '';
  const avatarA = summaryA?.avatarUrl ?? summaryA?.avatarfull ?? null;
  const avatarB = summaryB?.avatarUrl ?? summaryB?.avatarfull ?? null;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageGames = (comparison?.commonGames ?? []).slice(startIdx, startIdx + PAGE_SIZE);

  const diffBlocks = pageGames.map((g) => {
    if (g.winner === 'A') {
      return [
        '```diff',
        `[ ${g.name} ]`,
        `- ${personaB}: ${g.hoursB} hrs`,
        `+ ${personaA}: ${g.hoursA} hrs \u2605 Dominant (+${g.diffHours} hrs)`,
        '```',
      ].join('\n');
    } else if (g.winner === 'B') {
      return [
        '```diff',
        `[ ${g.name} ]`,
        `- ${personaA}: ${g.hoursA} hrs`,
        `+ ${personaB}: ${g.hoursB} hrs \u2605 Dominant (+${g.diffHours} hrs)`,
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
    `Total Time Invested: **${comparison.totalHoursA}h** vs **${comparison.totalHoursB}h** \u2022 **${commonCount}** Shared Titles`,
  ].join('\n');

  const embed1: DiscordEmbed = {
    author: {
      name: `${personaA} vs ${personaB} \u2022 Steam Duel`,
      icon_url: avatarA ?? undefined,
    },
    title: 'Steam Library Duel Overview',
    description: scoreboardDescription,
    color: 0x5865f2,
    thumbnail: avatarA ? { url: avatarA } : undefined,
  };

  const embed2: DiscordEmbed = {
    title: `Shared Titles Playtime Comparison [Page ${currentPage}/${totalPages}]`,
    description: diffBlocks || '*No shared titles on this page.*',
    color: 0x5865f2,
    thumbnail: avatarB ? { url: avatarB } : undefined,
    footer: {
      text: `Page ${currentPage} of ${totalPages} \u2022 zT Radar \u2022 Steam Duel`,
    },
    timestamp: new Date().toISOString(),
  };

  const components = totalPages > 1 ? [
    {
      type: 1 as const,
      components: [
        {
          type: 2 as const,
          style: 2,
          label: '\u25c4 Prev',
          custom_id: `duel_p:${currentPage - 1}:${steamIdA}:${steamIdB}`,
          disabled: currentPage <= 1,
        },
        {
          type: 2 as const,
          style: 1,
          label: 'Next \u25ba',
          custom_id: `duel_p:${currentPage + 1}:${steamIdA}:${steamIdB}`,
          disabled: currentPage >= totalPages,
        },
      ],
    },
  ] : [];

  return { embed: embed1, embeds: [embed1, embed2], components };
}

// ---------------------------------------------------------------------------
// Embed Builders — Backlog
// ---------------------------------------------------------------------------

/**
 * Generates Discord interaction embed and pagination components for Steam Library Backlog.
 */
export async function buildBacklogEmbedPayload(
  telemetry: BacklogTelemetry & Partial<BacklogMsrpResult> & { storePricesMap?: Record<number, string> },
  summary: PlayerSummaryLike,
  page: number = 1,
  storePricesMap: Record<number, string> | null = null,
): Promise<EmbedPayload> {
  const PAGE_SIZE = 5;
  const totalUnplayed = telemetry.backlogGames.length;
  const totalPages = Math.max(1, Math.ceil(totalUnplayed / PAGE_SIZE));
  const requestedPage = typeof page === 'number' && page >= 1 ? page : 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  const personaName = summary?.personaName ?? summary?.personaname ?? 'Player';
  const steamId = summary?.steamId ?? summary?.steamid ?? '';
  const avatarUrl = summary?.avatarUrl ?? summary?.avatarfull ?? null;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageGames = telemetry.backlogGames.slice(startIdx, startIdx + PAGE_SIZE);

  const countryCode = telemetry.preferredCurrency === 'BRL' ? 'br' : 'us';

  const unplayedList = await Promise.all(
    pageGames.map(async (g) => {
      const timeLabel = g.playtime_forever === 0 ? 'Never Opened (0m)' : `${g.playtime_forever}m played`;
      let priceLabel: string | undefined =
        (storePricesMap ?? {})[g.appid] ?? (telemetry.storePricesMap ?? {})[g.appid];
      if (!priceLabel) {
        priceLabel = await fetchSteamAppStorePrice(g.appid, countryCode);
      }
      return [
        `\u2756 **${g.name}**`,
        `  \u2514\u2500 Playtime: \`${timeLabel}\` \u2022 Current Store: **${priceLabel}**`,
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

  const msrpText = telemetry.msrpSummary
    ? (telemetry.msrpSummary.startsWith('Total Inactive MSRP:')
      ? telemetry.msrpSummary.replace(/^Total Inactive MSRP:\s*/, '')
      : telemetry.msrpSummary)
    : `${telemetry.currencySymbol ?? '$'} ${Number(telemetry.totalMsrp ?? 0).toFixed(2)} (${telemetry.pricedCount ?? 0}/${totalUnplayed} priced)`;

  const descriptionLines = [
    `Paid library telemetry analysis detecting unplayed games, backlog percentage, and live store valuation.`,
    `\u25b8 **Total Inactive MSRP:** ${msrpText}`,
  ];

  const embed: DiscordEmbed = {
    title: `Steam Library Backlog Intelligence \u2756 ${personaName}`,
    description: descriptionLines.join('\n'),
    color: 0x5865f2,
    fields,
    thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
    footer: {
      text: `Page ${currentPage} of ${totalPages} \u2022 Currency: ${telemetry.preferredCurrency} \u2022 zT Radar Backlog Intelligence`,
    },
    timestamp: new Date().toISOString(),
  };

  const components = totalPages > 1 ? [
    {
      type: 1 as const,
      components: [
        {
          type: 2 as const,
          style: 2,
          label: '\u25c4 Prev',
          custom_id: `backlog_p:${currentPage - 1}:${steamId}`,
          disabled: currentPage <= 1,
        },
        {
          type: 2 as const,
          style: 1,
          label: 'Next \u25ba',
          custom_id: `backlog_p:${currentPage + 1}:${steamId}`,
          disabled: currentPage >= totalPages,
        },
      ],
    },
  ] : [];

  return { embed, embeds: [embed], components };
}

// ---------------------------------------------------------------------------
// Multiplayer Badge Resolution & Game Match
// ---------------------------------------------------------------------------

/** Institutional registry of top Steam titles known to support multiplayer/co-op. */
export const KNOWN_MULTIPLAYER_APP_IDS = new Map<number, string[]>([
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

type CategoryLike = { id: number } | number;

/**
 * Resolves multiplayer badges for an AppID by combining institutional registry,
 * category IDs, and title keyword heuristics.
 */
export function resolveMultiplayerBadges(
  appId: number | string,
  name: string = '',
  categories: CategoryLike[] = [],
): string[] {
  const numericId = Number(appId);
  const badges = new Set<string>();

  if (KNOWN_MULTIPLAYER_APP_IDS.has(numericId)) {
    for (const b of KNOWN_MULTIPLAYER_APP_IDS.get(numericId)!) {
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
 */
export function matchLibraryData(
  gamesA: SteamOwnedGame[],
  gamesB: SteamOwnedGame[],
  filterMode: string = 'coop',
): MatchLibraryResult {
  if (!Array.isArray(gamesA) || !Array.isArray(gamesB)) {
    return {
      totalCommon: 0,
      matchedCount: 0,
      filterMode,
      games: [],
      matchingGames: [],
    };
  }

  const mapA = new Map<number, SteamOwnedGame>();
  for (const g of gamesA) {
    if (g?.appid) {
      mapA.set(Number(g.appid), g);
    }
  }

  const matched: MatchedGame[] = [];
  let totalCommonCount = 0;

  for (const gB of gamesB) {
    if (!gB?.appid) continue;
    const appId = Number(gB.appid);
    if (mapA.has(appId)) {
      totalCommonCount += 1;
      const gA = mapA.get(appId)!;
      const playtimeA = Number(gA.playtime_forever ?? 0);
      const playtimeB = Number(gB.playtime_forever ?? 0);
      const totalPlaytime = playtimeA + playtimeB;
      const name = gA.name ?? gB.name ?? `App #${appId}`;

      const categoriesA = (gA.categories ?? []) as CategoryLike[];
      const categoriesB = (gB.categories ?? []) as CategoryLike[];
      const badges = resolveMultiplayerBadges(appId, name, [...categoriesA, ...categoriesB]);
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
        img_icon_url: gA.img_icon_url ?? gB.img_icon_url ?? null,
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
 */
export async function findMatchingGames(
  steamIdA: string,
  steamIdB: string,
  filterMode: string = 'coop',
  apiKey: string,
): Promise<FindMatchingGamesResult> {
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

  const result: FindMatchingGamesResult = {
    success: true as const,
    steamIdA,
    steamIdB,
    countA: libA.gameCount,
    countB: libB.gameCount,
    totalCommon: matchData.totalCommon,
    matchedCount: matchData.matchedCount,
    filterMode: matchData.filterMode,
    games: matchData.games,
    matchingGames: matchData.matchingGames,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Embed Builders — Game Match
// ---------------------------------------------------------------------------

/**
 * Generates Discord Rich Embed and interactive pagination buttons for /game-match.
 */
export function buildGameMatchEmbedPayload(
  matchResult: FindMatchingGamesResult | MatchLibraryResult,
  summaryA: PlayerSummaryLike,
  summaryB: PlayerSummaryLike,
  page: number = 1,
  filterMode: string = 'coop',
): EmbedPayload {
  const PAGE_SIZE = 5;
  const games = (matchResult as MatchLibraryResult)?.matchingGames ?? (matchResult as MatchLibraryResult)?.games ?? [];
  const totalGames = games.length;
  const totalPages = Math.max(1, Math.ceil(totalGames / PAGE_SIZE));
  const requestedPage = typeof page === 'number' && page >= 1 ? page : 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  const personaA = summaryA?.personaName ?? summaryA?.personaname ?? 'Player A';
  const personaB = summaryB?.personaName ?? summaryB?.personaname ?? 'Player B';
  const steamIdA = (matchResult as { steamIdA?: string })?.steamIdA ?? summaryA?.steamId ?? summaryA?.steamid ?? '';
  const steamIdB = (matchResult as { steamIdB?: string })?.steamIdB ?? summaryB?.steamId ?? summaryB?.steamid ?? '';
  const avatarA = summaryA?.avatarUrl ?? summaryA?.avatarfull ?? null;
  const avatarB = summaryB?.avatarUrl ?? summaryB?.avatarfull ?? null;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageGames = games.slice(startIdx, startIdx + PAGE_SIZE);

  const filterLabel = filterMode === 'all' ? 'All Shared Games' : 'Co-op & Multiplayer Only';

  const descriptionLines = [
    `Shared Titles: **${(matchResult as MatchLibraryResult).totalCommon ?? 0}** Games \u2022 Matched: **${(matchResult as MatchLibraryResult).matchedCount ?? totalGames}** Titles`,
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
          `\u2756 **${g.name}** ${badgeStr}`,
          `  \u2514\u2500 Combined Playtime: \`${g.totalHours} hrs\` (${personaA}: ${g.hoursA}h \u2022 ${personaB}: ${g.hoursB}h) \u2022 [Steam Store](${storeLink})`,
        ].join('\n');
      })
      .join('\n\n');
  }

  const embed1: DiscordEmbed = {
    author: {
      name: `${personaA} \u2716 ${personaB} \u2022 Game Match`,
      icon_url: avatarA ?? undefined,
    },
    title: 'Steam Library Match Overview',
    description: descriptionLines.join('\n'),
    color: 0x5865f2,
    thumbnail: avatarA ? { url: avatarA } : undefined,
  };

  const embed2: DiscordEmbed = {
    title: `Matched Titles [Page ${currentPage}/${totalPages}]`,
    description: gameCardsText,
    color: 0x5865f2,
    thumbnail: avatarB ? { url: avatarB } : undefined,
    footer: {
      text: `Page ${currentPage} of ${totalPages} \u2022 Filter: ${filterMode} \u2022 zT Radar Co-op Discovery`,
    },
    timestamp: new Date().toISOString(),
  };

  const components = totalPages > 1 ? [
    {
      type: 1 as const,
      components: [
        {
          type: 2 as const,
          style: 2,
          label: '\u25c4 Prev',
          custom_id: `match_p:${currentPage - 1}:${filterMode}:${steamIdA}:${steamIdB}`,
          disabled: currentPage <= 1,
        },
        {
          type: 2 as const,
          style: 1,
          label: 'Next \u25ba',
          custom_id: `match_p:${currentPage + 1}:${filterMode}:${steamIdA}:${steamIdB}`,
          disabled: currentPage >= totalPages,
        },
      ],
    },
  ] : [];

  return { embed: embed1, embeds: [embed1, embed2], components };
}
