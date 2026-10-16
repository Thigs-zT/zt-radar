/**
 * Platform Status Utility
 *
 * Probes connectivity across Steam, Epic Games, PSN, and Xbox.
 * Fetches Top 10 Most Played and Trending game charts from Steam.
 */

import type {
  PlatformStatusValue,
  PlatformStatusResult,
  SteamMostPlayedEntry,
  SteamTrendingEntry,
} from '../types/index.js';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

// Verified Steam AppID to Name registry for top institutional titles
const APP_DIRECTORY: Record<number, string> = {
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
export async function checkPlatformStatuses(): Promise<PlatformStatusResult> {
  const results: PlatformStatusResult = {
    steam: { name: 'Steam Network & Store', status: 'UNKNOWN', latencyMs: 0 },
    epic: { name: 'Epic Games Store', status: 'UNKNOWN', latencyMs: 0 },
    psn: { name: 'PlayStation Network', status: 'UNKNOWN', latencyMs: 0 },
    xbox: { name: 'Xbox Network (Live)', status: 'UNKNOWN', latencyMs: 0 },
  };

  const probe = async (
    key: keyof PlatformStatusResult,
    url: string,
    evalFn: (res: Response) => Promise<PlatformStatusValue>,
    method: string = 'GET',
  ): Promise<void> => {
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
      const data = await res.json() as { status?: { indicator?: string } };
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
async function resolveGameTitle(appId: number, signal: AbortSignal): Promise<string> {
  if (APP_DIRECTORY[appId]) return APP_DIRECTORY[appId];

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    if (res.ok) {
      const data = await res.json() as Record<number, { data?: { name?: string } }>;
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
export async function getSteamMostPlayedGames(): Promise<SteamMostPlayedEntry[]> {
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

    const data = await res.json() as { response?: { ranks?: Array<{ appid: number; concurrent_in_game?: number; peak_in_game?: number }> } };
    const rawRanks = data?.response?.ranks ?? [];
    const topTen = rawRanks.slice(0, 10);

    const results = await Promise.all(
      topTen.map(async (item, idx): Promise<SteamMostPlayedEntry> => {
        const title = await resolveGameTitle(item.appid, controller.signal);
        return {
          rank: idx + 1,
          appId: item.appid,
          name: title,
          currentPlayers: item.concurrent_in_game ?? 0,
          peakToday: item.peak_in_game ?? null,
        };
      })
    );

    clearTimeout(timeoutId);
    return results;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error fetching Steam Most Played charts:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetches trending titles on Steam (aggregating Top Sellers and Specials up to 50 candidates).
 */
export async function getSteamTrendingGames(
  limit: number = 50,
  preferredCurrency: string = 'USD',
): Promise<SteamTrendingEntry[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  type TopSellerItem = {
    id?: number;
    type?: number;
    name?: string;
    final_price?: number;
    discounted?: boolean;
    discount_percent?: number;
    header_image?: string;
  };

  try {
    const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
    const ccParam = isBrl ? 'br' : 'us';
    const langParam = isBrl ? 'portuguese' : 'english';
    const featuredUrl = `https://store.steampowered.com/api/featuredcategories/?cc=${ccParam}&l=${langParam}`;
    const res = await fetch(featuredUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timeoutId);
      return [];
    }

    const data = (await res.json()) as {
      top_sellers?: { items?: TopSellerItem[] };
      specials?: { items?: TopSellerItem[] };
    };

    // Aggregate candidates from top_sellers and specials to ensure sufficient raw depth (40~50 items)
    const rawItems: TopSellerItem[] = [
      ...(data?.top_sellers?.items ?? []),
      ...(data?.specials?.items ?? []),
    ];

    const HARDWARE_NAME_REGEX = /\b(steam deck|steam frame|steam machine|valve index|steam controller|steam link|controller|headset|docking station|base station|vr kit)\b/i;
    const KNOWN_HARDWARE_IDS = new Set<number>([1675200, 2133010, 1059530, 1059550, 1059570, 1059540, 353370, 353380]);

    const seenIds = new Set<number>();
    const uniqueItems: TopSellerItem[] = [];
    for (const item of rawItems) {
      // Discard packages lacking valid standalone appIds
      if (!item.id || typeof item.id !== 'number' || item.id <= 0) {
        continue;
      }
      // Discard non-standalone app packages/bundles if type is present and not 0 (app)
      if (typeof item.type === 'number' && item.type !== 0) {
        continue;
      }
      // Discard known hardware IDs
      if (KNOWN_HARDWARE_IDS.has(item.id)) {
        continue;
      }
      // Discard hardware by name pattern
      if (item.name && HARDWARE_NAME_REGEX.test(item.name)) {
        continue;
      }
      // Discard high-priced hardware bundles (amounts in cents: > $250.00 USD or > R$ 1,200.00 BRL)
      const finalPrice = item.final_price ?? 0;
      if (isBrl ? finalPrice > 120000 : finalPrice > 25000) {
        continue;
      }

      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        uniqueItems.push(item);
      }
    }

    const maxItems = Math.max(10, Math.min(limit, 50));
    const validItems = uniqueItems.filter((i) => i.id && i.name).slice(0, maxItems);

    const enriched = await Promise.all(
      validItems.map(async (item, idx): Promise<SteamTrendingEntry> => {
        let players: number | null = null;
        try {
          const playersUrl = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${item.id}`;
          const playersRes = await fetch(playersUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
          });
          if (playersRes.ok) {
            const pData = (await playersRes.json()) as { response?: { player_count?: number } };
            players = pData?.response?.player_count ?? null;
          }
        } catch {
          // Ignored if single query fails
        }

        // Valve returns amounts in cents (e.g. 5999 = $59.99). Sanitize and format properly.
        const finalPrice = item.final_price ?? 0;
        const currencySym = isBrl ? 'R$' : '$';
        const formattedAmount = (finalPrice / 100).toFixed(2);
        const discountStr = item.discounted && item.discount_percent ? ` (-${item.discount_percent}%)` : '';
        const priceStr =
          finalPrice === 0
            ? 'Free to Play'
            : `${currencySym} ${formattedAmount}${discountStr}`;

        return {
          rank: idx + 1,
          appId: item.id as number,
          name: item.name as string,
          currentPlayers: players,
          priceText: priceStr,
          headerImage: item.header_image ?? null,
        };
      })
    );

    clearTimeout(timeoutId);
    return enriched;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error fetching Steam trending games:', err instanceof Error ? err.message : err);
    return [];
  }
}
