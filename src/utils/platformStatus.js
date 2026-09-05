const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

/**
 * Checks connectivity and operational status across major PC and console gaming networks.
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
    // Steam Web API Health Probe
    probe('steam', 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/', async (res) => {
      return res.ok ? 'ONLINE' : 'DEGRADED';
    }),

    // Epic Games Official Statuspage API
    probe('epic', 'https://status.epicgames.com/api/v2/status.json', async (res) => {
      if (!res.ok) return 'DEGRADED';
      const data = await res.json();
      const ind = data?.status?.indicator;
      if (ind === 'none') return 'ONLINE';
      if (ind === 'minor') return 'DEGRADED';
      return 'OUTAGE';
    }),

    // PlayStation Network Service Probe
    probe('psn', 'https://status.playstation.com/', async (res) => {
      return res.status < 400 ? 'ONLINE' : 'DEGRADED';
    }, 'HEAD'),

    // Xbox Live Service Probe
    probe('xbox', 'https://support.xbox.com/', async (res) => {
      return res.status < 400 ? 'ONLINE' : 'DEGRADED';
    }, 'HEAD'),
  ]);

  return results;
}

/**
 * Fetches the current top 5 trending games on Steam and enriches with live concurrent players.
 */
export async function getSteamTrendingGames() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

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
    const topFive = topSellers.slice(0, 5);

    const enriched = await Promise.all(
      topFive.map(async (item) => {
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
          // Keep null if player count lookup times out
        }

        return {
          id: item.id,
          name: item.name,
          discounted: item.discounted,
          discountPercent: item.discount_percent,
          finalPrice: item.final_price ? (item.final_price / 100).toFixed(2) : null,
          currency: item.currency || 'USD',
          headerImage: item.header_image || null,
          currentPlayers: players,
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