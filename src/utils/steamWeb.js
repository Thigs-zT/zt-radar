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
      4000
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

/**
 * Resolves Steam AppIDs to game titles via the Steam Store appdetails API.
 * Uses bounded concurrency and defensive timeouts to comply with Discord limits.
 *
 * @param {string[]} appIds - Array of numeric Steam AppIDs
 * @param {number} [timeoutMs=2000] - Total timeout budget for resolution
 * @returns {Promise<Map<string, string>>} Map of appId -> game title
 */
export async function resolveSteamAppTitles(appIds, timeoutMs = 2000) {
  const titleMap = new Map();
  if (!appIds || appIds.length === 0) {
    return titleMap;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const BATCH_SIZE = 15;
  try {
    for (let i = 0; i < appIds.length; i += BATCH_SIZE) {
      if (controller.signal.aborted) break;

      const chunk = appIds.slice(i, i + BATCH_SIZE);
      await Promise.all(
        chunk.map(async (appId) => {
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
                titleMap.set(String(appId), name);
              }
            }
          } catch {
            // Individual fetch failed or timed out; fallback will be used
          }
        })
      );
    }
  } catch {
    // Timeout or abort
  } finally {
    clearTimeout(timer);
  }

  return titleMap;
}
