/**
 * IsThereAnyDeal (ITAD) & CheapShark Market Intelligence Utility
 *
 * Provides multi-store price comparisons, historical low detection,
 * autocomplete search, and market overview deals (free games, free weekends, steep discounts).
 * Supported stores: Steam, Epic Games Store, Nuuvem, GOG.
 */

import type { StoreDeal, GameDealInfo, AutocompleteChoice } from '../types/index.js';

const ITAD_API_KEY = process.env.ITAD_API_KEY;
const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

// Strictly authorized storefronts: Steam, Epic Games Store, Nuuvem, GOG
const ALLOWED_STORES: Record<string, string> = {
  steam: 'Steam',
  'epic games store': 'Epic Games Store',
  'epic games': 'Epic Games Store',
  epic: 'Epic Games Store',
  nuuvem: 'Nuuvem',
  gog: 'GOG',
};

const NON_GAME_PATTERNS: RegExp[] = [
  /\bsoundtrack\b/i,
  /\bost\b/i,
  /\bartbook\b/i,
  /\bartworks?\b/i,
  /\bseason pass\b/i,
  /\bexpansion pass\b/i,
  /\bsong pack\b/i,
  /\bdemo version\b/i,
  /\bdemo\b/i,
  /\bdlc\b/i,
  /\bpack\b/i,
  /\bguide\b/i,
  /\bupgrade\b/i,
  /\bcourse\b/i,
  /\btraining\b/i,
  /\bcertification\b/i,
  /\bsuite\b/i,
  /\bthemes?\b/i,
  /\badd-?ons?\b/i,
  /\bplugins?\b/i,
  /\bplaytest\b/i,
];

export function resolveStoreName(rawStore: unknown): string | null {
  if (!rawStore) return null;
  const key = String(rawStore).toLowerCase().trim();
  if (key === '1' || key.includes('steam')) return 'Steam';
  if (key === '25' || key.includes('epic')) return 'Epic Games Store';
  if (key === '35' || key.includes('nuuvem')) return 'Nuuvem';
  if (key === '7' || key.includes('gog')) return 'GOG';
  return null; // Ignore any store outside our 4 approved storefronts
}

export function isCuratedGame(
  title: string,
  storeName: string,
  imageUrl: string | null,
  includeThirdParty: boolean = false,
): boolean {
  if (!title || !imageUrl) return false;

  for (const pattern of NON_GAME_PATTERNS) {
    if (pattern.test(title)) {
      return false;
    }
  }

  const normalizedStore = (storeName || '').toLowerCase();
  const isPrimary = normalizedStore.includes('steam') || normalizedStore.includes('epic');
  const isAuthorizedThirdParty = normalizedStore.includes('gog') || normalizedStore.includes('nuuvem');

  if (!includeThirdParty && !isPrimary) {
    return false;
  }

  if (includeThirdParty && !isPrimary && !isAuthorizedThirdParty) {
    return false;
  }

  return true;
}

/**
 * Formats a deal expiration timestamp into a dynamic Discord timestamp tag or friendly fallback.
 */
export function formatExpiryAvailability(expiry: string | number | Date | null | undefined): string {
  if (!expiry) {
    return '└─ Availability: Limited-time promotion (Claim as soon as possible)';
  }
  try {
    let date: Date;
    if (typeof expiry === 'number') {
      date = expiry < 10000000000 ? new Date(expiry * 1000) : new Date(expiry);
    } else {
      date = new Date(expiry);
    }
    const time = date.getTime();
    if (isNaN(time)) {
      return '└─ Availability: Limited-time promotion (Claim as soon as possible)';
    }
    const unixEpoch = Math.floor(time / 1000);
    return `└─ Availability: Until <t:${unixEpoch}:F> (<t:${unixEpoch}:R>)`;
  } catch {
    return '└─ Availability: Limited-time promotion (Claim as soon as possible)';
  }
}

/**
 * Formats price comparison into structured dual diff blocks with equal visual hierarchy.
 */
export function formatPriceComparisonDiff(
  primaryDeal: Partial<StoreDeal> | null | undefined,
  cheaperAlternative: Partial<StoreDeal> | null | undefined,
  fallbackSym: string = '$',
): string {
  const primarySym = primaryDeal?.currencySymbol || fallbackSym;
  const primaryCut = (primaryDeal?.cutPercent ?? 0) > 0 ? ` (-${primaryDeal?.cutPercent}%)` : '';

  if (!cheaperAlternative) {
    return [
      '```diff',
      `[ Monitored Storefront ❖ ${primaryDeal?.shopName || 'Store'} ]`,
      `- Regular: ${primarySym} ${Number(primaryDeal?.regularPrice || 0).toFixed(2)}`,
      `+ Current: ${primarySym} ${Number(primaryDeal?.salePrice || 0).toFixed(2)}${primaryCut}`,
      '```',
    ].join('\n');
  }

  const altSym = cheaperAlternative.currencySymbol || primarySym;
  const altCut = (cheaperAlternative.cutPercent ?? 0) > 0 ? ` (-${cheaperAlternative.cutPercent}%)` : '';

  return [
    '```diff',
    `[ Monitored Storefront ❖ ${primaryDeal?.shopName || 'Store'} ]`,
    `- Regular: ${primarySym} ${Number(primaryDeal?.regularPrice || 0).toFixed(2)}`,
    `+ Current: ${primarySym} ${Number(primaryDeal?.salePrice || 0).toFixed(2)}${primaryCut}`,
    '',
    `[ Best Offer Detected ❖ ${cheaperAlternative.shopName || 'Store'} ]`,
    `- Regular: ${altSym} ${Number(cheaperAlternative.regularPrice || 0).toFixed(2)}`,
    `+ Deal:    ${altSym} ${Number(cheaperAlternative.salePrice || 0).toFixed(2)}${altCut} ★ Best Value`,
    '```',
  ].join('\n');
}

interface RawSteamStoreSearchItem {
  id?: number | string;
  name?: string;
  type?: string;
}

interface RawSteamStoreSearchResponse {
  items?: RawSteamStoreSearchItem[];
}

interface RawItadSearchItem {
  id?: string;
  title?: string;
  type?: string;
}

/**
 * Autocomplete searching Steam Store official catalog (canonical) + Epic Games Store exclusives.
 * Returns empty array when query is empty, only showing results when the user starts typing.
 */
export async function searchGamesForAutocomplete(query: string): Promise<AutocompleteChoice[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const trimmedQuery = query.trim();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  const choices: AutocompleteChoice[] = [];
  const seenTitles = new Set<string>();
  const seenAppIds = new Set<number | string>();

  try {
    // 1. Search Steam Store Official Search (Canonical real games)
    const steamSearchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(trimmedQuery)}&l=english&cc=US`;
    const steamRes = await fetch(steamSearchUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (steamRes.ok) {
      const steamData = (await steamRes.json()) as RawSteamStoreSearchResponse;
      const items = steamData?.items || [];

      for (const item of items) {
        if (!item.id || !item.name) continue;
        if (item.type && item.type !== 'app') continue;

        let isFiltered = false;
        for (const pattern of NON_GAME_PATTERNS) {
          if (pattern.test(item.name)) {
            isFiltered = true;
            break;
          }
        }
        if (isFiltered) continue;

        const normTitle = item.name.toLowerCase().trim();
        if (seenTitles.has(normTitle) || seenAppIds.has(item.id)) continue;
        seenTitles.add(normTitle);
        seenAppIds.add(item.id);

        choices.push({
          name: item.name.length > 100 ? item.name.substring(0, 97) + '...' : item.name,
          value: `steam:${item.id}|${item.name}`.substring(0, 100),
        });

        if (choices.length >= 20) break;
      }
    }

    // 2. Query ITAD for Epic Games Store exclusives or games not present on Steam
    const itadKey = process.env.ITAD_API_KEY || ITAD_API_KEY;
    if (itadKey && choices.length < 25) {
      try {
        const itadUrl = `${ITAD_BASE_URL}/games/search/v1?key=${itadKey}&title=${encodeURIComponent(trimmedQuery)}&results=15`;
        const itadRes = await fetch(itadUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (itadRes.ok) {
          const itadData = (await itadRes.json()) as RawItadSearchItem[];
          if (Array.isArray(itadData)) {
            for (const g of itadData) {
              if (!g.id || !g.title) continue;
              if (g.type && g.type !== 'game') continue;

              const normTitle = g.title.toLowerCase().trim();
              if (seenTitles.has(normTitle)) continue;

              let isFiltered = false;
              for (const pattern of NON_GAME_PATTERNS) {
                if (pattern.test(g.title)) {
                  isFiltered = true;
                  break;
                }
              }
              if (isFiltered) continue;

              seenTitles.add(normTitle);
              choices.push({
                name: `${g.title} (Epic / PC)`.substring(0, 100),
                value: `itad:${g.id}|${g.title}`.substring(0, 100),
              });

              if (choices.length >= 25) break;
            }
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    clearTimeout(timeoutId);
    return choices.slice(0, 25);
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Autocomplete search error:', msg);
    return [];
  }
}

interface RawSteamAppDetailsPriceOverview {
  final: number;
  initial: number;
  discount_percent: number;
}

interface RawSteamAppDetails {
  name?: string;
  header_image?: string;
  is_free?: boolean;
  metacritic?: { score?: number };
  price_overview?: RawSteamAppDetailsPriceOverview;
}

interface RawSteamAppDetailsMap {
  [appId: string]: {
    success?: boolean;
    data?: RawSteamAppDetails;
  };
}

interface RawItadLookupResponse {
  game?: {
    id?: string;
  };
}

interface RawItadDeal {
  shop?: { name?: string };
  price: { amount: number };
  regular: { amount: number };
  cut: number;
  url: string;
  expiry?: string | number | null;
}

interface RawItadPriceOverviewItem {
  id?: string;
  deals?: RawItadDeal[];
}

interface RawItadHistoryLowItem {
  id?: string;
  low?: {
    price?: { amount?: number };
  };
}

/**
 * Retrieves comprehensive price, store comparison, and historical low data.
 */
export async function getGameDealInfo(
  rawGameIdentifier: string,
  preferredCurrency: string = 'USD',
  titleFallback: string | null = null,
): Promise<GameDealInfo | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  const country = preferredCurrency === 'BRL' ? 'br' : 'us';
  const currencySymbol = preferredCurrency === 'BRL' ? 'R$' : '$';
  const currency = preferredCurrency === 'BRL' ? 'BRL' : 'USD';

  let steamAppId: string | null = null;
  let itadGameId: string | null = null;
  let title = titleFallback || '';

  if (typeof rawGameIdentifier === 'string') {
    if (rawGameIdentifier.startsWith('steam:')) {
      steamAppId = rawGameIdentifier.replace('steam:', '').trim();
    } else if (rawGameIdentifier.startsWith('itad:')) {
      itadGameId = rawGameIdentifier.replace('itad:', '').trim();
    } else if (/^\d+$/.test(rawGameIdentifier)) {
      steamAppId = rawGameIdentifier;
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(rawGameIdentifier)) {
      itadGameId = rawGameIdentifier;
    } else {
      title = rawGameIdentifier;
    }
  }

  try {
    let steamDeal: StoreDeal | null = null;
    let bannerImage: string | null = null;
    let reviewScore: number | null = null;

    // 1. Fetch Official Steam Store details if steamAppId is known
    if (steamAppId) {
      try {
        const steamUrl = `https://store.steampowered.com/api/appdetails?appids=${steamAppId}&cc=${country}&l=english`;
        const steamRes = await fetch(steamUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (steamRes.ok) {
          const steamData = (await steamRes.json()) as RawSteamAppDetailsMap;
          const appDetails = steamData?.[steamAppId]?.data;

          if (appDetails) {
            title = appDetails.name || title;
            bannerImage = appDetails.header_image || null;
            reviewScore = appDetails.metacritic?.score ?? null;

            if (appDetails.is_free) {
              steamDeal = {
                shopName: 'Steam',
                salePrice: 0,
                regularPrice: 0,
                cutPercent: 100,
                url: `https://store.steampowered.com/app/${steamAppId}/`,
                expiry: null,
                currency,
                currencySymbol,
              };
            } else if (appDetails.price_overview) {
              steamDeal = {
                shopName: 'Steam',
                salePrice: appDetails.price_overview.final / 100,
                regularPrice: appDetails.price_overview.initial / 100,
                cutPercent: appDetails.price_overview.discount_percent,
                url: `https://store.steampowered.com/app/${steamAppId}/`,
                expiry: null,
                currency,
                currencySymbol,
              };
            }
          }
        }
      } catch (steamErr: unknown) {
        const msg = steamErr instanceof Error ? steamErr.message : String(steamErr);
        console.error('Steam appdetails error:', msg);
      }
    }

    // 2. Query ITAD for multi-store comparison (Nuuvem, GOG, Epic) and Historical Low
    let historyLow: number | null = null;
    const storeBreakdown: Record<string, StoreDeal> = {};

    if (steamDeal) {
      storeBreakdown['Steam'] = steamDeal;
    }

    const itadKey = process.env.ITAD_API_KEY || ITAD_API_KEY;
    if (itadKey) {
      try {
        // Resolve ITAD UUID if missing
        if (!itadGameId) {
          const lookupParam = steamAppId ? `appid=${steamAppId}` : `title=${encodeURIComponent(title)}`;
          const lookupUrl = `${ITAD_BASE_URL}/games/lookup/v1?key=${itadKey}&${lookupParam}`;
          const lookupRes = await fetch(lookupUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
          });

          if (lookupRes.ok) {
            const lookupData = (await lookupRes.json()) as RawItadLookupResponse;
            itadGameId = lookupData?.game?.id || null;
          }
        }

        if (itadGameId) {
          const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${country.toUpperCase()}`;
          const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${itadKey}&country=${country.toUpperCase()}`;

          const [priceRes, historyRes] = await Promise.all([
            fetch(priceUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: JSON.stringify([itadGameId]),
              signal: controller.signal,
            }),
            fetch(historyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: JSON.stringify([itadGameId]),
              signal: controller.signal,
            }),
          ]);

          if (priceRes.ok) {
            const priceData = (await priceRes.json()) as RawItadPriceOverviewItem[];
            const itadDeals = priceData?.[0]?.deals || [];

            for (const d of itadDeals) {
              const shopName = resolveStoreName(d.shop?.name);
              if (!shopName) continue; // STRICTLY IGNORE any store outside our 4 approved stores!

              if (!storeBreakdown[shopName] || d.price.amount < storeBreakdown[shopName].salePrice) {
                storeBreakdown[shopName] = {
                  shopName,
                  salePrice: d.price.amount,
                  regularPrice: d.regular.amount,
                  cutPercent: d.cut,
                  url: d.url,
                  expiry: d.expiry || null,
                  currency,
                  currencySymbol,
                };
              }
            }
          }

          if (historyRes.ok) {
            const historyData = (await historyRes.json()) as RawItadHistoryLowItem[];
            historyLow = historyData?.[0]?.low?.price?.amount ?? null;
          }
        }
      } catch (itadErr: unknown) {
        const msg = itadErr instanceof Error ? itadErr.message : String(itadErr);
        console.error('ITAD comparison query error:', msg);
      }
    }

    const availableDeals = Object.values(storeBreakdown);

    if (availableDeals.length === 0) {
      clearTimeout(timeoutId);
      return null;
    }

    // Determine primary offer (Steam by default, or the cheapest deal)
    const sortedByPrice = [...availableDeals].sort((a, b) => a.salePrice - b.salePrice);
    const absoluteCheapest = sortedByPrice[0];
    const defaultSteam = storeBreakdown['Steam'] || absoluteCheapest;

    const primaryRaw = defaultSteam;
    let secondaryRaw: StoreDeal | null = null;

    if (absoluteCheapest.salePrice < primaryRaw.salePrice) {
      secondaryRaw = absoluteCheapest;
    }

    const primaryDeal: StoreDeal = {
      shopName: primaryRaw.shopName,
      salePrice: primaryRaw.salePrice,
      regularPrice: primaryRaw.regularPrice,
      cutPercent: primaryRaw.cutPercent,
      url: primaryRaw.url,
      expiry: primaryRaw.expiry || null,
      currency,
      currencySymbol,
    };

    const cheaperAlternative: StoreDeal | null = secondaryRaw
      ? {
          shopName: secondaryRaw.shopName,
          salePrice: secondaryRaw.salePrice,
          regularPrice: secondaryRaw.regularPrice,
          cutPercent: secondaryRaw.cutPercent,
          url: secondaryRaw.url,
          expiry: secondaryRaw.expiry || null,
          currency,
          currencySymbol,
        }
      : null;

    const primaryIsAtl =
      primaryDeal.cutPercent > 0 &&
      primaryDeal.salePrice < primaryDeal.regularPrice &&
      historyLow !== null &&
      primaryDeal.salePrice <= historyLow;

    const cheaperIsAtl =
      Boolean(cheaperAlternative) &&
      (cheaperAlternative?.cutPercent ?? 0) > 0 &&
      (cheaperAlternative?.salePrice ?? 0) < (cheaperAlternative?.regularPrice ?? 0) &&
      historyLow !== null &&
      (cheaperAlternative?.salePrice ?? 0) <= historyLow;

    const isAllTimeLow = historyLow !== null && (primaryIsAtl || cheaperIsAtl);

    const isFree = primaryDeal.salePrice === 0 || (cheaperAlternative && cheaperAlternative.salePrice === 0);

    clearTimeout(timeoutId);
    return {
      gameId: steamAppId ? `steam_${steamAppId}` : (itadGameId || rawGameIdentifier),
      title: title || 'Monitored Title',
      imageUrl: bannerImage,
      reviewScore,
      steamAppId,
      dealType: isFree ? 'FREE_TO_KEEP' : 'CURATED_DEAL',
      isAllTimeLow,
      allTimeLowPrice: historyLow,
      expiry: primaryDeal.expiry || cheaperAlternative?.expiry || null,
      primaryDeal,
      cheaperAlternative,
      storeBreakdown,
    };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error resolving deal info for ${rawGameIdentifier}:`, msg);
    return null;
  }
}

interface RawSteamCategoryItem {
  id?: number | string;
  name?: string;
  headline?: string;
  body?: string;
  header_image?: string;
  large_capsule_image?: string;
  original_price?: number;
}

interface RawSteamFeaturedCategories {
  specials?: { items?: RawSteamCategoryItem[] };
  top_sellers?: { items?: RawSteamCategoryItem[] };
}

/**
 * Probes Steam Store categories for active Free Weekend / Play For Free promotions.
 */
async function fetchSteamFreeWeekends(): Promise<GameDealInfo[]> {
  try {
    const url = 'https://store.steampowered.com/api/featuredcategories/';
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];

    const data = (await res.json()) as RawSteamFeaturedCategories;
    const candidates: RawSteamCategoryItem[] = [
      ...(data?.specials?.items || []),
      ...(data?.top_sellers?.items || []),
    ];

    const freeWeekends: GameDealInfo[] = [];
    const seen = new Set<string | number>();

    for (const item of candidates) {
      if (!item.id || seen.has(item.id)) continue;
      const isFreeWeekend =
        item.headline?.toLowerCase().includes('free weekend') ||
        item.body?.toLowerCase().includes('play for free') ||
        item.name?.toLowerCase().includes('free weekend');

      if (isFreeWeekend) {
        seen.add(item.id);
        const appIdStr = String(item.id);
        const freeWeekendDeal: StoreDeal = {
          shopName: 'Steam',
          salePrice: 0,
          regularPrice: item.original_price ? item.original_price / 100 : 0,
          cutPercent: 100,
          url: `https://store.steampowered.com/app/${appIdStr}/`,
          currency: 'USD',
          currencySymbol: '$',
          expiry: null,
        };

        freeWeekends.push({
          gameId: `steam_${appIdStr}`,
          title: item.name || `Steam App #${appIdStr}`,
          imageUrl: item.header_image || item.large_capsule_image || null,
          reviewScore: null,
          steamAppId: appIdStr,
          dealType: 'FREE_PLAY_DAYS',
          isAllTimeLow: false,
          allTimeLowPrice: null,
          expiry: null,
          primaryDeal: freeWeekendDeal,
          cheaperAlternative: null,
          storeBreakdown: { Steam: freeWeekendDeal },
        });
      }
    }

    return freeWeekends;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Error querying Steam free weekends:', msg);
    return [];
  }
}

interface RawItadDealsListItem {
  id?: string;
  title?: string;
  appid?: string;
  steam_appid?: string;
  assets?: {
    banner400?: string;
    banner300?: string;
    boxart?: string;
  };
  reviews?: {
    steam?: { score?: number };
    metacritic?: { score?: number };
  };
  deal?: {
    shop?: { name?: string };
    price?: { amount?: number };
    regular?: { amount?: number };
    cut?: number;
    url?: string;
    expiry?: string | number | null;
  };
}

interface RawItadDealsResponse {
  list?: RawItadDealsListItem[];
}

interface RawCheapSharkDeal {
  dealID?: string;
  gameID?: string;
  title?: string;
  steamAppID?: string;
  thumb?: string;
  salePrice?: string;
  normalPrice?: string;
  savings?: string;
  metacriticScore?: string;
  steamRatingPercent?: string;
  steamRatingCount?: string;
}

export async function getMarketOverviewDeals(
  includeThirdParty: boolean = false,
  preferredCurrency: string = 'USD',
): Promise<GameDealInfo[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5500);

  try {
    const freeDeals: GameDealInfo[] = [];
    const freeWeekendDeals: GameDealInfo[] = [];
    const discountedDeals: GameDealInfo[] = [];
    const seenTitles = new Set<string>();

    // 1. Fetch 100% Free Game Promotions (Keep Forever - Steam & Epic)
    const itadKey = process.env.ITAD_API_KEY || ITAD_API_KEY;
    if (itadKey) {
      try {
        const country = preferredCurrency === 'BRL' ? 'BR' : 'US';
        const storeFilter = includeThirdParty ? '&shops=61,16,35' : '&shops=61,16';
        const itadFreeUrl = `${ITAD_BASE_URL}/deals/v2?key=${itadKey}&country=${country}&limit=30&sort=-cut${storeFilter}`;
        const itadRes = await fetch(itadFreeUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (itadRes.ok) {
          const itadData = (await itadRes.json()) as RawItadDealsResponse;
          const list = itadData?.list || [];

          for (const item of list) {
            if (!item.deal || !item.title) continue;
            const price = item.deal?.price?.amount ?? 1;

            if (price === 0) {
              const shopName = resolveStoreName(item.deal?.shop?.name);
              if (!shopName) continue;

              const imageUrl = item.assets?.banner400 || item.assets?.banner300 || item.assets?.boxart || null;

              if (!isCuratedGame(item.title, shopName, imageUrl, includeThirdParty)) {
                continue;
              }

              const normalizedTitle = item.title.toLowerCase().trim();
              if (seenTitles.has(normalizedTitle)) continue;
              seenTitles.add(normalizedTitle);

              const freePrimaryDeal: StoreDeal = {
                shopName,
                salePrice: 0,
                regularPrice: item.deal?.regular?.amount ?? 0,
                cutPercent: 100,
                url: item.deal?.url || '',
                expiry: item.deal?.expiry || null,
                currency: preferredCurrency === 'BRL' ? 'BRL' : 'USD',
                currencySymbol: preferredCurrency === 'BRL' ? 'R$' : '$',
              };

              freeDeals.push({
                gameId: item.id || `free_${item.title}`,
                title: item.title,
                imageUrl,
                reviewScore: item.reviews?.steam?.score ?? item.reviews?.metacritic?.score ?? null,
                steamAppId: item.appid || item.steam_appid || null,
                dealType: 'FREE_TO_KEEP',
                isAllTimeLow: true,
                allTimeLowPrice: 0,
                expiry: item.deal?.expiry || null,
                primaryDeal: freePrimaryDeal,
                cheaperAlternative: null,
                storeBreakdown: { [shopName]: freePrimaryDeal },
              });
            }
          }
        }
      } catch (itadErr: unknown) {
        console.error('ITAD free deals error:', itadErr);
      }
    }

    // 2. Fetch Active Steam Free Weekend / Play For Free Events
    try {
      const activeFreeWeekends = await fetchSteamFreeWeekends();
      for (const fw of activeFreeWeekends) {
        const norm = fw.title.toLowerCase().trim();
        if (!seenTitles.has(norm)) {
          seenTitles.add(norm);
          freeWeekendDeals.push(fw);
        }
      }
    } catch (fwErr: unknown) {
      console.error('Free weekend probe error:', fwErr);
    }

    // 3. Fetch Acclaimed Games from CheapShark (Steam-only Deals)
    try {
      const csUrl = `${CHEAPSHARK_BASE_URL}/deals?storeID=1&pageSize=50&sortBy=Deal%20Rating&desc=0`;
      const csRes = await fetch(csUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });

      if (csRes.ok) {
        const csDeals = (await csRes.json()) as RawCheapSharkDeal[];
        for (const d of csDeals) {
          if (!d.title) continue;

          const shopName = 'Steam';
          const imageUrl = d.thumb || null;
          const savings = Math.round(parseFloat(d.savings || '0'));
          const rating = d.steamRatingPercent
            ? parseInt(d.steamRatingPercent, 10)
            : d.metacriticScore
            ? parseInt(d.metacriticScore, 10)
            : null;
          const reviewCount = d.steamRatingCount ? parseInt(d.steamRatingCount, 10) : 0;
          const normalPrice = parseFloat(d.normalPrice || '0');
          const hasMetacritic = Boolean(d.metacriticScore && parseInt(d.metacriticScore, 10) >= 75);

          if (normalPrice < 4.99) continue;
          if (rating && rating < 80) continue;
          if (hasMetacritic && reviewCount < 1500) continue;
          if (!hasMetacritic && reviewCount < 4000) continue;
          if (savings < 60) continue;

          if (!isCuratedGame(d.title, shopName, imageUrl, includeThirdParty)) continue;

          const normalizedTitle = d.title.toLowerCase().trim();
          if (seenTitles.has(normalizedTitle)) continue;
          seenTitles.add(normalizedTitle);

          const salePrice = parseFloat(d.salePrice || '0');
          const regularPrice = normalPrice;
          const cutPercent = savings;
          const currency = 'USD';
          const currencySymbol = '$';
          const dealUrl = `https://www.cheapshark.com/redirect?dealID=${d.dealID}`;

          const cheapSharkPrimaryDeal: StoreDeal = {
            shopName: 'Steam',
            salePrice,
            regularPrice,
            cutPercent,
            url: dealUrl,
            expiry: null,
            currency,
            currencySymbol,
          };

          discountedDeals.push({
            gameId: d.gameID || `cs_${d.title}`,
            title: d.title,
            imageUrl,
            reviewScore: rating,
            steamAppId: d.steamAppID || null,
            dealType: 'CURATED_DEAL',
            isAllTimeLow: false,
            allTimeLowPrice: null,
            expiry: null,
            primaryDeal: cheapSharkPrimaryDeal,
            cheaperAlternative: null,
            storeBreakdown: { Steam: cheapSharkPrimaryDeal },
          });
        }
      }
    } catch (csErr: unknown) {
      console.error('CheapShark overview deals error:', csErr);
    }

    clearTimeout(timeoutId);
    return [...freeDeals, ...freeWeekendDeals, ...discountedDeals];
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Fatal error in market overview deals lookup:', msg);
    return [];
  }
}
