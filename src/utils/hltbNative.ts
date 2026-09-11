/**
 * HowLongToBeat Native Integration Utility
 *
 * Implements native Node.js 22 fetch interactions with HowLongToBeat's public search API.
 * Uses zero external npm dependencies, desktop browser headers, and defensive timeouts.
 */

import type { HltbStatsResult } from '../types/index.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface HltbAuthTokens {
  token: string;
  hpKey: string;
  hpVal: string;
  timestamp: number;
}

let authCache: HltbAuthTokens | null = null;

/**
 * Retrieves or refreshes security tokens required for HowLongToBeat search.
 * Cached in-memory for up to 10 minutes.
 */
async function getAuthTokens(signal: AbortSignal): Promise<HltbAuthTokens | null> {
  if (authCache && Date.now() - authCache.timestamp < 10 * 60 * 1000) {
    return authCache;
  }

  try {
    const initRes = await fetch(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://howlongtobeat.com/',
        Origin: 'https://howlongtobeat.com',
        Accept: '*/*',
      },
      signal,
    });

    if (!initRes.ok) {
      return null;
    }

    const json = (await initRes.json()) as { token?: string; hpKey?: string; hpVal?: string };
    if (!json.token) return null;

    authCache = {
      token: json.token,
      hpKey: json.hpKey || '',
      hpVal: json.hpVal || '',
      timestamp: Date.now(),
    };
    return authCache;
  } catch {
    return null;
  }
}

interface RawHltbGameItem {
  game_id?: number;
  game_name?: string;
  game_image?: string;
  comp_main?: number;
  comp_plus?: number;
  comp_100?: number;
  comp_all?: number;
}

interface RawHltbSearchResponse {
  data?: RawHltbGameItem[];
}

/**
 * Queries HowLongToBeat for average completion times of a video game title.
 */
export async function getHowLongToBeatStats(
  gameName: string,
  timeoutMs: number = 2500,
): Promise<HltbStatsResult> {
  if (!gameName || typeof gameName !== 'string' || gameName.trim().length === 0) {
    return { success: false, error: 'DATA_UNAVAILABLE' };
  }

  const cleanedQuery = gameName
    .replace(/[™®©]/g, '')
    .trim();

  const controller = new AbortController();
  const effectiveTimeout = Math.min(timeoutMs, 2500);
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    let auth = await getAuthTokens(controller.signal);
    if (!auth) {
      return { success: false, error: 'DATA_UNAVAILABLE' };
    }

    const buildPayload = (tokens: HltbAuthTokens): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        searchType: 'games',
        searchTerms: cleanedQuery.split(/\s+/).filter(Boolean),
        searchPage: 1,
        size: 20,
        searchOptions: {
          games: {
            userId: 0,
            platform: '',
            sortCategory: 'popular',
            rangeCategory: 'main',
            rangeTime: { min: null, max: null },
            gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
            year: '',
            modifier: '',
          },
          users: { sortCategory: 'postcount' },
          lists: { sortCategory: 'follows' },
          filter: '',
          sort: 0,
          randomizer: 0,
        },
        useCache: true,
      };

      if (tokens.hpKey) {
        payload[tokens.hpKey] = tokens.hpVal;
      }

      return payload;
    };

    let res = await fetch('https://howlongtobeat.com/api/search/site', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://howlongtobeat.com/',
        Origin: 'https://howlongtobeat.com',
        'x-auth-token': auth.token,
        'x-hp-key': auth.hpKey || '',
        'x-hp-val': auth.hpVal || '',
      },
      body: JSON.stringify(buildPayload(auth)),
      signal: controller.signal,
    });

    // Refresh security tokens and retry once if session expired (HTTP 403)
    if (res.status === 403) {
      authCache = null;
      auth = await getAuthTokens(controller.signal);
      if (!auth) {
        return { success: false, error: 'DATA_UNAVAILABLE' };
      }

      res = await fetch('https://howlongtobeat.com/api/search/site', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Referer: 'https://howlongtobeat.com/',
          Origin: 'https://howlongtobeat.com',
          'x-auth-token': auth.token,
          'x-hp-key': auth.hpKey || '',
          'x-hp-val': auth.hpVal || '',
        },
        body: JSON.stringify(buildPayload(auth)),
        signal: controller.signal,
      });
    }

    if (!res.ok) {
      return { success: false, error: 'DATA_UNAVAILABLE' };
    }

    const data = (await res.json()) as RawHltbSearchResponse;
    const games = data?.data;

    if (!games || !Array.isArray(games) || games.length === 0) {
      return { success: false, error: 'DATA_UNAVAILABLE' };
    }

    // Match priority: Exact alphanumeric title match > First relevance match
    const normalizedQuery = cleanedQuery.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exactMatch = games.find(
      (g) => g.game_name?.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedQuery
    );

    const match = exactMatch || games[0];

    const toHours = (seconds?: number): number => {
      if (!seconds || seconds <= 0) return 0;
      return Math.round((seconds / 3600) * 10) / 10;
    };

    const mainStoryHours = toHours(match.comp_main);
    const mainExtraHours = toHours(match.comp_plus);
    const completionistHours = toHours(match.comp_100);
    const allPlayStylesHours = toHours(match.comp_all);

    const imageUrl = match.game_image
      ? `https://howlongtobeat.com/games/${match.game_image}`
      : null;

    return {
      success: true,
      gameId: match.game_id,
      gameTitle: match.game_name,
      mainStoryHours,
      mainExtraHours,
      completionistHours,
      allPlayStylesHours,
      imageUrl,
    };
  } catch {
    return { success: false, error: 'DATA_UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}
