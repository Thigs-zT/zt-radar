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
 * Sanitizes a game title for secondary ITAD lookup by stripping trademark symbols
 * and edition suffixes (e.g. — Remastered, Complete Edition, GOTY, Enhanced Edition, ™, ®).
 */
export function sanitizeTitleForItadLookup(rawTitle: string): string {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/[™®©]/g, '')
    .replace(/\s*:\s*/g, ': ')
    .replace(
      /\s*([—–\-:]\s*)?(?:(?:the\s+)?telltale\s+)?(game of the year(\s+edition)?|goty(\s+edition)?|complete edition|enhanced edition|remastered|definitive (?:edition|series)|anniversary edition|director's cut|collector's edition|deluxe(\s+edition)?|standard edition|premium edition)\b.*$/i,
      '',
    )
    .replace(
      /\s*\(\s*(game of the year(\s+edition)?|goty(\s+edition)?|complete edition|enhanced edition|remastered|definitive (?:edition|series)|deluxe(\s+edition)?)\s*\)/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strictly verifies whether a candidate title from ITAD search is either an exact match
 * to baseTitle or starts with baseTitle followed strictly by an authorized edition suffix.
 * Prevents sequel cross-contamination (e.g. "Hades II" when searching "Hades") and unrelated games.
 */
export function isStrictEditionMatch(baseTitle: string, candidateTitle: string): boolean {
  if (!baseTitle || !candidateTitle) return false;

  const normalize = (str: string): string =>
    str
      .replace(/[™®©]/g, '')
      .replace(/\s*([:\-–—])\s*/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const baseNorm = normalize(baseTitle);
  const candNorm = normalize(candidateTitle);

  // a) Identical match
  if (candNorm === baseNorm) {
    return true;
  }

  // b) Starts with baseTitle.toLowerCase()
  if (!candNorm.startsWith(baseNorm)) {
    return false;
  }

  const remainder = candNorm.slice(baseNorm.length);

  // Must have a whitespace, punctuation, or parenthesis delimiter separating baseTitle from the suffix
  if (!/^[\s\-–—:(]/.test(remainder)) {
    return false;
  }

  // Strip leading and trailing delimiter characters, parentheses, and whitespace
  const cleanSuffix = remainder
    .replace(/^[\s\-–—:(]+/, '')
    .replace(/[\s)]+$/, '')
    .trim();

  // Valid edition suffixes: complete, goty, deluxe, ultimate, definitive (edition/series), enhanced, anniversary, etc.
  const VALID_EDITION_PATTERN =
    /^(?:complete(?:\s+edition)?|game\s+of\s+the\s+year(?:\s+edition)?|goty(?:\s+edition)?|deluxe(?:\s+edition)?|ultimate(?:\s+edition)?|definitive(?:\s+(?:edition|series))?|(?:the\s+)?(?:telltale\s+)?definitive\s+(?:edition|series)|enhanced(?:\s+edition)?|anniversary(?:\s+edition)?|special\s+edition|gold\s+edition|director'?s\s+cut)$/i;

  return VALID_EDITION_PATTERN.test(cleanSuffix);
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

export interface RawSteamAppDetails {
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
  found?: boolean;
  game?: {
    id?: string;
    title?: string;
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

const ITAD_TIMEOUT_MS = 1800;
const STEAM_DETAILS_TIMEOUT_MS = 1500;
const ITAD_MAX_ATTEMPTS = 2;
const ITAD_RETRY_BASE_DELAY_MS = 200;

/**
 * Resolves after `ms` milliseconds, or immediately if `signal` aborts.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Performs an ITAD HTTP request with bounded retries for transient failures
 * (network errors, HTTP 429 and HTTP 5xx). All attempts share the caller's AbortSignal,
 * so the overall deadline remains bounded by ITAD_TIMEOUT_MS (1800ms) in getGameDealInfo.
 * Returns the last response received, or throws the last network error.
 */
async function fetchItadWithRetry(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= ITAD_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) break;
    try {
      const res = await fetch(url, { ...init, signal });
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === ITAD_MAX_ATTEMPTS) {
        return res;
      }
      const retryAfterSec = Number(res.headers?.get?.('retry-after'));
      const delayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 400)
          : ITAD_RETRY_BASE_DELAY_MS * attempt;
      await abortableDelay(delayMs, signal);
    } catch (err: unknown) {
      lastError = err;
      if (signal.aborted || attempt === ITAD_MAX_ATTEMPTS) break;
      await abortableDelay(ITAD_RETRY_BASE_DELAY_MS * attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ITAD request failed or was aborted');
}

/**
 * Fetches official Steam Store details for an AppID bounded by a strict timeout (default: 1500ms).
 * If Valve's endpoint hangs or is rate-limited, returns null so caller can proceed with fallback data.
 */
export async function fetchSteamStoreAppDetails(
  appId: string,
  country: string = 'us',
  signal?: AbortSignal,
  timeoutMs: number = STEAM_DETAILS_TIMEOUT_MS,
): Promise<RawSteamAppDetails | null> {
  if (!appId) return null;
  const timeoutCtrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const signals: AbortSignal[] = [timeoutCtrl.signal];
  if (signal) signals.push(signal);
  const combinedSignal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : timeoutCtrl.signal;

  let loggedTimeout = false;
  const logSteamTimeout = () => {
    if (loggedTimeout) return;
    loggedTimeout = true;
    console.warn(`[SteamStore] Valve appdetails exceeded ${timeoutMs}ms timeout for app ${appId}; proceeding with ITAD fallback.`);
  };

  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timeoutCtrl.abort();
      logSteamTimeout();
      resolve(null);
    }, timeoutMs);
  });

  const fetchPromise = (async (): Promise<RawSteamAppDetails | null> => {
    try {
      const steamUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${country}&l=english`;
      const steamRes = await fetch(steamUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: combinedSignal,
      });

      if (steamRes.ok) {
        const steamData = (await steamRes.json()) as RawSteamAppDetailsMap;
        return steamData?.[appId]?.data || null;
      }
    } catch (steamErr: unknown) {
      if (timeoutCtrl.signal.aborted) {
        logSteamTimeout();
      } else {
        const msg = steamErr instanceof Error ? steamErr.message : String(steamErr);
        console.error('Steam appdetails error:', msg);
      }
    }
    return null;
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves an ITAD UUID directly by Steam AppID using /games/lookup/v1?appid=... first,
 * falling back to direct Steam shop ID (shop: 61) mapping via /lookup/id/shop/61/v1.
 */
async function resolveItadIdBySteamAppId(
  steamAppId: string,
  itadKey: string,
  signal: AbortSignal,
): Promise<{ id: string | null; title: string | null; transientError: boolean }> {
  let transientError = false;

  try {
    const lookupUrl = `${ITAD_BASE_URL}/games/lookup/v1?key=${itadKey}&appid=${encodeURIComponent(steamAppId)}`;
    const lookupRes = await fetchItadWithRetry(
      lookupUrl,
      { headers: { 'User-Agent': USER_AGENT } },
      signal,
    );

    if (lookupRes.ok) {
      const lookupData = (await lookupRes.json()) as RawItadLookupResponse;
      if (lookupData?.game?.id) {
        return {
          id: lookupData.game.id,
          title: lookupData.game.title || null,
          transientError: false,
        };
      }
    } else if (lookupRes.status === 429 || lookupRes.status >= 500) {
      transientError = true;
    }
  } catch (lookupErr: unknown) {
    transientError = true;
    const msg = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
    console.warn('ITAD initial Steam AppID lookup error:', msg);
  }

  if (transientError || signal.aborted) {
    return { id: null, title: null, transientError };
  }

  // Secondary direct Steam shop ID (61) mapping before any fuzzy title search
  try {
    const shopKey = `app/${steamAppId}`;
    const shopLookupUrl = `${ITAD_BASE_URL}/lookup/id/shop/61/v1?key=${itadKey}`;
    const shopRes = await fetchItadWithRetry(
      shopLookupUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify([shopKey]),
      },
      signal,
    );

    if (shopRes.ok) {
      const shopMap = (await shopRes.json()) as Record<string, string | null>;
      const mappedUuid = shopMap?.[shopKey];
      if (typeof mappedUuid === 'string' && mappedUuid.trim().length > 0) {
        return { id: mappedUuid.trim(), title: null, transientError: false };
      }
    } else if (shopRes.status === 429 || shopRes.status >= 500) {
      transientError = true;
    }
  } catch (shopErr: unknown) {
    transientError = true;
    const msg = shopErr instanceof Error ? shopErr.message : String(shopErr);
    console.warn('ITAD shop 61 Steam AppID lookup error:', msg);
  }

  return { id: null, title: null, transientError };
}

/**
 * Retrieves comprehensive price, store comparison, and historical low data.
 * Enforces a strict 1800ms bounding timeout on upstream ITAD resolution so slow or throttled
 * ITAD responses fail fast and allow graceful Steam-only fallback without stalling Lambdas.
 */
export async function getGameDealInfo(
  rawGameIdentifier: string,
  preferredCurrencyOrTitle: string = 'USD',
  titleFallbackOrCurrency: string | null = null,
  externalSignal?: AbortSignal,
): Promise<GameDealInfo | null> {
  let preferredCurrency = 'USD';
  let titleFallback: string | null = null;

  const normalizedSecond = (preferredCurrencyOrTitle || '').trim();
  const normalizedThird = (titleFallbackOrCurrency || '').trim();

  if (normalizedSecond.toUpperCase() === 'BRL' || normalizedSecond.toUpperCase() === 'USD') {
    preferredCurrency = normalizedSecond.toUpperCase();
    titleFallback = titleFallbackOrCurrency;
  } else {
    // Second argument is title fallback (e.g. getGameDealInfo('1091500', 'Cyberpunk 2077', 'USD'))
    titleFallback = preferredCurrencyOrTitle;
    if (normalizedThird.toUpperCase() === 'BRL' || normalizedThird.toUpperCase() === 'USD') {
      preferredCurrency = normalizedThird.toUpperCase();
    }
  }

  const itadController = new AbortController();
  let itadTimedOut = false;
  let itadTimer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => itadController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      itadController.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const itadTimeoutSignal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ITAD_TIMEOUT_MS) : null;
  const activeItadSignal =
    itadTimeoutSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([itadController.signal, itadTimeoutSignal])
      : itadController.signal;

  const isBrl = preferredCurrency === 'BRL';
  const country = isBrl ? 'br' : 'us';
  const itadCountry = isBrl ? 'BR' : 'US';
  const currencySymbol = isBrl ? 'R$' : '$';
  const currency = isBrl ? 'BRL' : 'USD';

  let steamAppId: string | null = null;
  let itadGameId: string | null = null;
  let title = titleFallback || '';

  if (typeof rawGameIdentifier === 'string') {
    const trimmedId = rawGameIdentifier.trim();
    const steamPrefixMatch = trimmedId.match(/^steam[:_](\d+)$/i);
    if (steamPrefixMatch) {
      steamAppId = steamPrefixMatch[1];
    } else if (trimmedId.startsWith('itad:')) {
      itadGameId = trimmedId.replace('itad:', '').trim();
    } else if (/^\d+$/.test(trimmedId)) {
      steamAppId = trimmedId;
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(trimmedId)) {
      itadGameId = trimmedId;
    } else {
      title = trimmedId;
    }
  }

  try {
    let bannerImage: string | null = null;
    let reviewScore: number | null = null;
    let officialSteamTitle: string | null = null;
    const itadKey = process.env.ITAD_API_KEY || ITAD_API_KEY;

    // 1. Concurrently kick off bounded Steam Store details (1500ms) and ITAD resolution (1800ms)
    const steamPromise = steamAppId
      ? fetchSteamStoreAppDetails(steamAppId, country, externalSignal, STEAM_DETAILS_TIMEOUT_MS)
      : Promise.resolve(null);

    let historyLow: number | null = null;
    const storeBreakdown: Record<string, StoreDeal> = {};
    let resolvedLookupTitle: string | null = null;
    let alternativeCheckStatus: 'confirmed' | 'degraded' | 'skipped' = itadKey ? 'confirmed' : 'skipped';
    let alternativeCheckDegraded = false;
    let secondarySearchExecuted = false;
    let primaryPricesSucceeded = false;
    let lookupTransientError = false;

    const ingestDeals = (items: RawItadPriceOverviewItem[], isSecondary: boolean) => {
      for (const item of items || []) {
        for (const d of item.deals || []) {
          const shopName = resolveStoreName(d.shop?.name);
          if (!shopName) continue; // STRICTLY IGNORE outside our 4 approved stores

          if (isSecondary) {
            // Secondary edition UUIDs: ONLY merge non-Steam storefronts (GOG, Epic Games Store, Nuuvem)
            // that are not already present from the primary itadLookup UUID.
            if (shopName === 'Steam' || storeBreakdown[shopName]) {
              continue;
            }
          }

          const dealSale = Number(d.price?.amount ?? 0);
          const dealRegular = Number(d.regular?.amount ?? dealSale);
          const dealCut = Number(d.cut ?? 0);
          const dealUrl =
            shopName === 'Steam' && steamAppId
              ? `https://store.steampowered.com/app/${steamAppId}/`
              : d.url || '';

          if (!storeBreakdown[shopName] || dealSale < storeBreakdown[shopName].salePrice) {
            storeBreakdown[shopName] = {
              shopName,
              salePrice: dealSale,
              regularPrice: dealRegular,
              cutPercent: dealCut,
              url: dealUrl,
              expiry: d.expiry || null,
              currency,
              currencySymbol,
            };
          }
        }
      }
    };

    const runItadPipeline = async (): Promise<'ITAD_DONE'> => {
      if (!itadKey) {
        return 'ITAD_DONE';
      }

      // Step 1: Direct Steam AppID mapping first (or title lookup when no Steam AppID)
      if (!itadGameId) {
        if (steamAppId) {
          const direct = await resolveItadIdBySteamAppId(steamAppId, itadKey, activeItadSignal);
          if (direct.id) itadGameId = direct.id;
          if (direct.title) resolvedLookupTitle = direct.title;
          if (direct.transientError) lookupTransientError = true;
        } else if (title && title !== 'Monitored Title') {
          try {
            const lookupUrl = `${ITAD_BASE_URL}/games/lookup/v1?key=${itadKey}&title=${encodeURIComponent(title)}`;
            const lookupRes = await fetchItadWithRetry(
              lookupUrl,
              { headers: { 'User-Agent': USER_AGENT } },
              activeItadSignal,
            );
            if (lookupRes.ok) {
              const lookupData = (await lookupRes.json()) as RawItadLookupResponse;
              if (lookupData?.game?.id) {
                itadGameId = lookupData.game.id;
                resolvedLookupTitle = lookupData.game.title || null;
              }
            } else if (lookupRes.status === 429 || lookupRes.status >= 500) {
              lookupTransientError = true;
            }
          } catch (lookupErr: unknown) {
            lookupTransientError = true;
            const msg = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
            console.warn('ITAD initial lookup error:', msg);
          }
        }
      }

      if (!title && resolvedLookupTitle) {
        title = resolvedLookupTitle;
      }
      if (!title && titleFallback) {
        title = titleFallback;
      }

      if (activeItadSignal.aborted) {
        alternativeCheckDegraded = true;
        alternativeCheckStatus = 'degraded';
        return 'ITAD_DONE';
      }

      let primaryItadId = itadGameId || null;

      // Step 2: Immediate query for primary ITAD ID
      if (primaryItadId) {
        try {
          const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${itadCountry}`;
          const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${itadKey}&country=${itadCountry}`;

          const [priceRes, historyRes] = await Promise.all([
            fetchItadWithRetry(
              priceUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                body: JSON.stringify([primaryItadId]),
              },
              activeItadSignal,
            ),
            fetchItadWithRetry(
              historyUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                body: JSON.stringify([primaryItadId]),
              },
              activeItadSignal,
            ),
          ]);

          if (priceRes.ok) {
            primaryPricesSucceeded = true;
            const priceData = (await priceRes.json()) as RawItadPriceOverviewItem[];
            ingestDeals(priceData, false);
          } else {
            alternativeCheckDegraded = true;
            alternativeCheckStatus = 'degraded';
          }

          if (historyRes.ok) {
            const historyData = (await historyRes.json()) as RawItadHistoryLowItem[];
            historyLow = historyData?.[0]?.low?.price?.amount ?? null;
          }
        } catch (primaryErr: unknown) {
          alternativeCheckDegraded = true;
          alternativeCheckStatus = 'degraded';
          const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
          console.error('ITAD primary prices/history query error:', msg);
        }
      }

      // Step 3 (Conditional Secondary Edition Search):
      // Runs ONLY if Step 2 did not already degrade and returned 0 non-Steam partner deals.
      const hasPartnerStore = Object.keys(storeBreakdown).some((k) => k !== 'Steam');
      if (!hasPartnerStore && !lookupTransientError && !alternativeCheckDegraded && !activeItadSignal.aborted) {
        const appDetailsForTitle = await steamPromise;
        if (appDetailsForTitle?.name) {
          officialSteamTitle = appDetailsForTitle.name;
          title = appDetailsForTitle.name;
        }

        const rawSearchTitle = officialSteamTitle || resolvedLookupTitle || titleFallback || title;
        const baseTitle = sanitizeTitleForItadLookup(rawSearchTitle);

        if (baseTitle && baseTitle !== 'Monitored Title' && baseTitle.length > 1 && !activeItadSignal.aborted) {
          try {
            const secSearchUrl = `${ITAD_BASE_URL}/games/search/v1?key=${itadKey}&title=${encodeURIComponent(baseTitle)}&results=5`;
            const secSearchRes = await fetchItadWithRetry(
              secSearchUrl,
              { headers: { 'User-Agent': USER_AGENT } },
              activeItadSignal,
            );

            if (secSearchRes.ok) {
              const searchItems = (await secSearchRes.json()) as RawItadSearchItem[];
              const exactIds: string[] = [];
              const editionIds: string[] = [];

              if (Array.isArray(searchItems)) {
                const baseLower = baseTitle.toLowerCase().trim();
                for (const sItem of searchItems) {
                  if (!sItem.id || !sItem.title) continue;
                  if (sItem.type === 'dlc') continue;
                  if (sItem.id === primaryItadId) continue;

                  let isNonGame = false;
                  for (const pattern of NON_GAME_PATTERNS) {
                    if (pattern.test(sItem.title)) {
                      isNonGame = true;
                      break;
                    }
                  }
                  if (isNonGame) continue;

                  if (isStrictEditionMatch(baseTitle, sItem.title)) {
                    if (sItem.title.toLowerCase().trim() === baseLower) {
                      exactIds.push(sItem.id);
                    } else {
                      editionIds.push(sItem.id);
                    }
                  }
                }
              }

              const secondaryEditionIds = [...exactIds, ...editionIds].slice(0, 3);
              let secondaryCompletedCleanly = true;

              // If direct AppID lookup didn't find an ID, promote the best title match as primary
              if (!primaryItadId && secondaryEditionIds.length > 0) {
                primaryItadId = secondaryEditionIds.shift()!;
                itadGameId = primaryItadId;

                try {
                  const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${itadCountry}`;
                  const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${itadKey}&country=${itadCountry}`;
                  const [pRes, hRes] = await Promise.all([
                    fetchItadWithRetry(
                      priceUrl,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                        body: JSON.stringify([primaryItadId]),
                      },
                      activeItadSignal,
                    ),
                    fetchItadWithRetry(
                      historyUrl,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                        body: JSON.stringify([primaryItadId]),
                      },
                      activeItadSignal,
                    ),
                  ]);

                  if (pRes.ok) {
                    primaryPricesSucceeded = true;
                    const pData = (await pRes.json()) as RawItadPriceOverviewItem[];
                    ingestDeals(pData, false);
                  } else {
                    secondaryCompletedCleanly = false;
                    alternativeCheckDegraded = true;
                    alternativeCheckStatus = 'degraded';
                  }
                  if (hRes.ok) {
                    const hData = (await hRes.json()) as RawItadHistoryLowItem[];
                    historyLow = hData?.[0]?.low?.price?.amount ?? null;
                  }
                } catch {
                  secondaryCompletedCleanly = false;
                  alternativeCheckDegraded = true;
                  alternativeCheckStatus = 'degraded';
                }
              }

              // Fetch secondary edition prices and merge non-Steam stores
              if (secondaryEditionIds.length > 0 && !activeItadSignal.aborted) {
                try {
                  const secPriceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${itadCountry}`;
                  const secPriceRes = await fetchItadWithRetry(
                    secPriceUrl,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                      body: JSON.stringify(secondaryEditionIds),
                    },
                    activeItadSignal,
                  );

                  if (secPriceRes.ok) {
                    const secPriceData = (await secPriceRes.json()) as RawItadPriceOverviewItem[];
                    ingestDeals(secPriceData, true);
                  } else {
                    secondaryCompletedCleanly = false;
                    alternativeCheckDegraded = true;
                    alternativeCheckStatus = 'degraded';
                  }
                } catch (secPriceErr: unknown) {
                  secondaryCompletedCleanly = false;
                  alternativeCheckDegraded = true;
                  alternativeCheckStatus = 'degraded';
                  console.warn(
                    'ITAD secondary prices query error:',
                    secPriceErr instanceof Error ? secPriceErr.message : String(secPriceErr),
                  );
                }
              }

              if (secondaryCompletedCleanly) {
                secondarySearchExecuted = true;
              }
            } else {
              alternativeCheckDegraded = true;
              alternativeCheckStatus = 'degraded';
            }
          } catch (secSearchErr: unknown) {
            alternativeCheckDegraded = true;
            alternativeCheckStatus = 'degraded';
            console.warn(
              'ITAD secondary search error:',
              secSearchErr instanceof Error ? secSearchErr.message : String(secSearchErr),
            );
          }
        }
      }

      if (primaryPricesSucceeded && !alternativeCheckDegraded) {
        alternativeCheckDegraded = false;
        alternativeCheckStatus = 'confirmed';
      } else if (!primaryItadId || lookupTransientError) {
        alternativeCheckDegraded = true;
        alternativeCheckStatus = 'degraded';
      }

      return 'ITAD_DONE';
    };

    const itadDeadlinePromise = new Promise<'ITAD_TIMEOUT'>((resolve) => {
      itadTimer = setTimeout(() => {
        itadTimedOut = true;
        itadController.abort(new DOMException(`ITAD lookup exceeded ${ITAD_TIMEOUT_MS}ms timeout`, 'TimeoutError'));
        resolve('ITAD_TIMEOUT');
      }, ITAD_TIMEOUT_MS);
    });

    const itadRaceResult = itadKey
      ? await Promise.race([runItadPipeline(), itadDeadlinePromise])
      : 'ITAD_DONE';

    if (itadTimer) clearTimeout(itadTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

    if (itadRaceResult === 'ITAD_TIMEOUT' || itadTimedOut || activeItadSignal.aborted) {
      alternativeCheckDegraded = true;
      alternativeCheckStatus = 'degraded';
      secondarySearchExecuted = false;
      console.warn(`[ITAD] Lookup exceeded ${ITAD_TIMEOUT_MS}ms timeout for ${rawGameIdentifier}; returning fast fallback.`);
    }

    // Apply authoritative Valve Steam Store details overlay (already awaited or finishes within 1500ms)
    const appDetails = await steamPromise;
    if (appDetails) {
      if (appDetails.name) {
        officialSteamTitle = appDetails.name;
        title = appDetails.name;
      }
      bannerImage = appDetails.header_image || null;
      reviewScore = appDetails.metacritic?.score ?? null;

      if (appDetails.is_free) {
        const steamDeal: StoreDeal = {
          shopName: 'Steam',
          salePrice: 0,
          regularPrice: 0,
          cutPercent: 100,
          url: `https://store.steampowered.com/app/${steamAppId}/`,
          expiry: null,
          currency,
          currencySymbol,
        };
        storeBreakdown['Steam'] = steamDeal;
      } else if (appDetails.price_overview) {
        const steamDeal: StoreDeal = {
          shopName: 'Steam',
          salePrice: appDetails.price_overview.final / 100,
          regularPrice: appDetails.price_overview.initial / 100,
          cutPercent: appDetails.price_overview.discount_percent,
          url: `https://store.steampowered.com/app/${steamAppId}/`,
          expiry: null,
          currency,
          currencySymbol,
        };
        storeBreakdown['Steam'] = steamDeal;
      } else {
        // Officially unreleased or not purchasable on Steam
        delete storeBreakdown['Steam'];
      }
    } else {
      if (!title && resolvedLookupTitle) {
        title = resolvedLookupTitle;
      } else if (!title && titleFallback) {
        title = titleFallback;
      }
      if (steamAppId && !bannerImage) {
        bannerImage = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`;
      }
    }

    const availableDeals = Object.values(storeBreakdown);

    if (availableDeals.length === 0) {
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

    const storeCount = Object.keys(storeBreakdown).length;
    const partnerCount = Object.keys(storeBreakdown).filter((k) => k !== 'Steam').length;
    const isPlatformExclusive =
      storeCount === 1 && partnerCount === 0 && secondarySearchExecuted && !alternativeCheckDegraded;

    return {
      gameId: steamAppId ? `steam_${steamAppId}` : (itadGameId || rawGameIdentifier),
      title: officialSteamTitle || title || 'Monitored Title',
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
      alternativeCheckStatus,
      alternativeCheckDegraded,
      isPlatformExclusive,
    };
  } catch (error: unknown) {
    if (itadTimer) clearTimeout(itadTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
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
 * Fetches regional BRL pricing directly from Steam Store API for a given AppID.
 * Returns null if the title is delisted, invalid, or lacks BRL pricing.
 */
export async function fetchSteamRegionalBrlPrice(appId: number | string): Promise<{
  salePrice: number;
  regularPrice: number;
  cutPercent: number;
  currency: string;
  currencySymbol: string;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=br&filters=price_overview`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { success?: boolean; data?: { is_free?: boolean; price_overview?: { initial?: number; final?: number; discount_percent?: number; currency?: string } } }>;
    const appData = data[String(appId)];
    if (!appData?.success) return null;
    const overview = appData.data?.price_overview;
    if (!overview || overview.currency !== 'BRL') return null;
    const regularPrice = (overview.initial ?? overview.final ?? 0) / 100;
    const salePrice = (overview.final ?? 0) / 100;
    const cutPercent = overview.discount_percent ?? 0;
    return {
      salePrice,
      regularPrice,
      cutPercent,
      currency: 'BRL',
      currencySymbol: 'R$',
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Probes Steam Store categories for active Free Weekend / Play For Free promotions.
 */
async function fetchSteamFreeWeekends(preferredCurrency: string = 'USD'): Promise<GameDealInfo[]> {
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
          currency: preferredCurrency === 'BRL' ? 'BRL' : 'USD',
          currencySymbol: preferredCurrency === 'BRL' ? 'R$' : '$',
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
  const timeoutId = setTimeout(() => controller.abort(), 1900);

  const freeDeals: GameDealInfo[] = [];
  const freeWeekendDeals: GameDealInfo[] = [];
  const discountedDeals: GameDealInfo[] = [];
  const seenTitles = new Set<string>();

  try {

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

async function batchFetchSteamBrlOverview(appIds: string[]): Promise<Map<string, {
  salePrice: number;
  regularPrice: number;
  cutPercent: number;
}>> {
  const resultMap = new Map<string, { salePrice: number; regularPrice: number; cutPercent: number }>();
  if (!Array.isArray(appIds) || appIds.length === 0) return resultMap;

  const uniqueIds = Array.from(new Set(appIds)).slice(0, 50);
  const CHUNK_SIZE = 25;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2200);

  try {
    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
      const url = `https://store.steampowered.com/api/appdetails?appids=${chunk.join(',')}&cc=br&filters=price_overview`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, { success?: boolean; data?: { is_free?: boolean; price_overview?: { initial?: number; final?: number; discount_percent?: number; currency?: string } } }>;
      if (!data || typeof data !== 'object') continue;

      for (const [idStr, appData] of Object.entries(data)) {
        if (!appData?.success) continue;
        const overview = appData.data?.price_overview;
        if (!overview || overview.currency !== 'BRL') continue;
        const regularPrice = (overview.initial ?? overview.final ?? 0) / 100;
        const salePrice = (overview.final ?? 0) / 100;
        const cutPercent = overview.discount_percent ?? 0;
        resultMap.set(idStr, { salePrice, regularPrice, cutPercent });
      }
    }
  } catch {
    // Graceful fallback
  } finally {
    clearTimeout(timer);
  }

  return resultMap;
}

    // 2. Fetch Active Steam Free Weekend / Play For Free Events
    try {
      const activeFreeWeekends = await fetchSteamFreeWeekends(preferredCurrency);
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

        let brlPricesMap = new Map<string, { salePrice: number; regularPrice: number; cutPercent: number }>();
        if (preferredCurrency === 'BRL') {
          const candidateAppIds: string[] = [];
          for (const d of csDeals) {
            if (d.steamAppID && /^\d+$/.test(d.steamAppID)) {
              candidateAppIds.push(d.steamAppID);
            }
          }
          brlPricesMap = await batchFetchSteamBrlOverview(candidateAppIds);
        }

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

          let salePrice = parseFloat(d.salePrice || '0');
          let regularPrice = normalPrice;
          let cutPercent = savings;
          let currency = 'USD';
          let currencySymbol = '$';

          if (preferredCurrency === 'BRL') {
            const brl = d.steamAppID ? brlPricesMap.get(d.steamAppID) : null;
            if (!brl) {
              // Discard USD deal when BRL pricing is strictly required but unavailable
              continue;
            }
            salePrice = brl.salePrice;
            regularPrice = brl.regularPrice;
            cutPercent = brl.cutPercent;
            currency = 'BRL';
            currencySymbol = 'R$';
          }

          const normalizedTitle = d.title.toLowerCase().trim();
          if (seenTitles.has(normalizedTitle)) continue;
          seenTitles.add(normalizedTitle);

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
    console.error('Fatal error or timeout in market overview deals lookup:', msg);
    return [...freeDeals, ...freeWeekendDeals, ...discountedDeals];
  }
}
