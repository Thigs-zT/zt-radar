const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

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
};

/**
 * Probes connectivity across Steam, Epic Games, PSN, and Xbox.
 */
export async function checkPlatformStatuses() {
  const results = {
    steam: { name: 'Steam Network & Store', status: 'UNKNOWN', latencyMs: 0 },
    epic: { name: 'Epic Games Store', status: 'UNKNOWN', latencyMs: 0 },
    psn: { name: 'PlayStation Network', status: 'UNKNOWN', latencyMs: 0 },
    xbox: { name: 'Xbox Network (Live)', status: 'UNKNOWN', latencyMs: 0 },
  };

  const probe = async (key, url, evalFn, method = 'GET') => {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      clearTimeout(timeoutId);
      results[key].latencyMs = latencyMs;
      results[key].status = await evalFn(res);
    } catch {
      clearTimeout(timeoutId);
      results[key].latencyMs = Date.now() - start;
      results[key].status = 'OFFLINE';
    }
  };

  await Promise.allSettled([
    probe('steam', 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/', async (res) => {
      return res.ok ? 'ONLINE' : 'DEGRADED';
    }),

    probe('epic', 'https://status.epicgames.com/api/v2/status.json', async (res) => {
      if (!res.ok) return 'DEGRADED';
      const data = await res.json();
      const ind = data?.status?.indicator;
      if (ind === 'none') return 'ONLINE';
      if (ind === 'minor') return 'DEGRADED';
      return 'OUTAGE';
    }),

    probe('psn', 'https://status.playstation.com/', async (res) => {
      return res.status < 400 ? 'ONLINE' : 'DEGRADED';
    }, 'HEAD'),

    probe('xbox', 'https://support.xbox.com/', async (res) => {
      return res.status < 400 ? 'ONLINE' : 'DEGRADED';
    }, 'HEAD'),
  ]);

  return results;
}

/**
 * Resolves a game title from Steam Web API or internal fallback dictionary.
 */
async function resolveGameTitle(appId, signal) {
  if (APP_DIRECTORY[appId]) return APP_DIRECTORY[appId];

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      const title = data?.[appId]?.data?.name;
      if (title) return title;
    }
  } catch {
    // Return formatted fallback
  }

  return `App #${appId}`;
}

/**
 * Fetches Top 10 Most Played Games on Steam ranked by live concurrent players (Official Valve API).
 */
export async function getSteamMostPlayedGames() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const url = 'https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/';
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timeoutId);
      return [];
    }

    const data = await res.json();
    const rawRanks = data?.response?.ranks || [];
    const topTen = rawRanks.slice(0, 10);

    const results = await Promise.all(
      topTen.map(async (item, idx) => {
        const title = await resolveGameTitle(item.appid, controller.signal);
        return {
          rank: idx + 1,
          appId: item.appid,
          name: title,
          currentPlayers: item.concurrent_in_game || 0,
          peakToday: item.peak_in_game || null,
        };
      })
    );

    clearTimeout(timeoutId);
    return results;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error fetching Steam Most Played charts:', err.message || err);
    return [];
  }
}

/**
 * Fetches Top 10 Trending titles on Steam (Top sellers surging in activity).
 */
export async function getSteamTrendingGames() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const featuredUrl = 'https://store.steampowered.com/api/featuredcategories/';
    const res = await fetch(featuredUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timeoutId);
      return [];
    }

    const data = await res.json();
    const topSellers = data?.top_sellers?.items || [];
    const validItems = topSellers.filter((i) => i.id && i.name).slice(0, 10);

    const enriched = await Promise.all(
      validItems.map(async (item, idx) => {
        let players = null;
        try {
          const playersUrl = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${item.id}`;
          const playersRes = await fetch(playersUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
          });
          if (playersRes.ok) {
            const pData = await playersRes.json();
            players = pData?.response?.player_count ?? null;
          }
        } catch {
          // Ignored if single query fails
        }

        const priceStr =
          item.final_price === 0 || !item.final_price
            ? 'Free to Play'
            : `$ ${(item.final_price / 100).toFixed(2)}${item.discounted ? ` (-${item.discount_percent}%)` : ''}`;

        return {
          rank: idx + 1,
          appId: item.id,
          name: item.name,
          currentPlayers: players,
          priceText: priceStr,
          headerImage: item.header_image || null,
        };
      })
    );

    clearTimeout(timeoutId);
    return enriched;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error fetching Steam trending games:', err.message || err);
    return [];
  }
}