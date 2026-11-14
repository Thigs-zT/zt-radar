/**
 * IsThereAnyDeal (ITAD) & CheapShark Market Intelligence Utility
 *
 * Provides multi-store price comparisons, historical low detection,
 * autocomplete search, and market overview deals (free games, free weekends, steep discounts).
 * Supported stores: Steam, Epic Games Store, Nuuvem, GOG.
 */

import type { StoreDeal, GameDealInfo, AutocompleteChoice, PricePoint } from '../types/index.js';

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
  if (key === '1' || key === '61' || key.includes('steam')) return 'Steam';
  if (key === '25' || key === '16' || key.includes('epic')) return 'Epic Games Store';
  if (key === '35' || key === '50' || key.includes('nuuvem')) return 'Nuuvem';
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
    .replace(/[™®©℠]/g, '')
    .replace(/\((?:tm|r|c)\)/gi, '')
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
      .replace(/[™®©℠]/g, '')
      .replace(/\((?:tm|r|c)\)/gi, '')
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
  shop?: { id?: number | string; name?: string };
  price: { amount: number };
  regular: { amount: number };
  cut: number;
  url: string;
  expiry?: string | number | null;
  storeLow?: { amount?: number };
}

interface RawItadPriceOverviewItem {
  id?: string;
  historyLow?: {
    all?: { amount?: number };
    y1?: { amount?: number };
    m3?: { amount?: number };
  };
  deals?: RawItadDeal[];
}

interface RawItadHistoryLowItem {
  id?: string;
  low?: {
    shop?: { id?: number | string; name?: string };
    price?: { amount?: number };
    regular?: { amount?: number };
    cut?: number;
    timestamp?: string | number;
  };
}

export interface RawItadHistoryLogEntry {
  timestamp?: string | number;
  date?: string | number;
  shop?: {
    id?: number | string;
    name?: string;
  };
  shopId?: number | string;
  deal?: {
    price?: { amount?: number; currency?: string };
    regular?: { amount?: number; currency?: string };
    cut?: number;
  };
  price?: { amount?: number; currency?: string } | number;
  regular?: { amount?: number; currency?: string } | number;
  cut?: number;
}

/** Verified ITAD v2 shop IDs: 61 (Steam), 16 (Epic Games Store), 35 (GOG), 50 (Nuuvem). */
export const ITAD_VERIFIED_SHOP_IDS = [61, 16, 35, 50] as const;
export const MAX_PRICE_HISTORY_POINTS = 15;
export const ITAD_HISTORY_LOOKBACK_DAYS = 1825;

interface HistoryLowMeta {
  timestamp?: string | number | null;
  shopName?: string | null;
  regularPrice?: number | null;
}

interface CachedItadUuidEntry {
  id: string;
  title: string | null;
}

interface CachedItadBulkPriceEntry {
  items: RawItadPriceOverviewItem[];
  historyLow: number | null;
  historyLowMeta: HistoryLowMeta;
  expiresAt: number;
}

const ITAD_BULK_PRICE_CACHE_TTL_MS = 300_000;
const ITAD_BULK_BATCH_CHUNK_SIZE = 100;
const steamAppIdToItadUuidCache = new Map<string, CachedItadUuidEntry>();
const itadBulkPriceCache = new Map<string, CachedItadBulkPriceEntry>();
let lastTrackedFetch: typeof fetch | null = null;

function syncItadRuntimeCaches(): void {
  if (typeof globalThis.fetch !== 'undefined' && globalThis.fetch !== lastTrackedFetch) {
    steamAppIdToItadUuidCache.clear();
    itadBulkPriceCache.clear();
    lastTrackedFetch = globalThis.fetch;
  }
}

export function clearItadRuntimeCaches(): void {
  steamAppIdToItadUuidCache.clear();
  itadBulkPriceCache.clear();
}

const ITAD_SHOP_ID_TO_STORE: Record<string, { shopId: 'steam' | 'nuuvem' | 'epic' | 'gog'; shopName: string }> = {
  '61': { shopId: 'steam', shopName: 'Steam' },
  '16': { shopId: 'epic', shopName: 'Epic Games Store' },
  '35': { shopId: 'gog', shopName: 'GOG' },
  '50': { shopId: 'nuuvem', shopName: 'Nuuvem' },
};

const STORE_NAME_TO_SHOP_ID: Record<string, 'steam' | 'nuuvem' | 'epic' | 'gog'> = {
  Steam: 'steam',
  'Epic Games Store': 'epic',
  GOG: 'gog',
  Nuuvem: 'nuuvem',
};

function resolveItadHistoryStore(
  rawShop: { id?: number | string; name?: string } | string | number | undefined,
): { shopId: 'steam' | 'nuuvem' | 'epic' | 'gog'; shopName: string } | null {
  if (rawShop === undefined || rawShop === null) return null;

  if (typeof rawShop === 'object') {
    const rawName = typeof rawShop.name === 'string' ? rawShop.name.trim() : '';
    if (rawName) {
      const canonical = resolveStoreName(rawName);
      if (!canonical) return null;
      const shopId = STORE_NAME_TO_SHOP_ID[canonical];
      return shopId ? { shopId, shopName: canonical } : null;
    }
    if (rawShop.id !== undefined && rawShop.id !== null) {
      return ITAD_SHOP_ID_TO_STORE[String(rawShop.id).trim()] || null;
    }
    return null;
  }

  const key = String(rawShop).trim();
  if (!key) return null;
  if (ITAD_SHOP_ID_TO_STORE[key]) {
    return ITAD_SHOP_ID_TO_STORE[key];
  }

  const canonical = resolveStoreName(key);
  if (!canonical) return null;
  const shopId = STORE_NAME_TO_SHOP_ID[canonical];
  return shopId ? { shopId, shopName: canonical } : null;
}

function extractRawHistoryEntries(rawPayload: unknown): RawItadHistoryLogEntry[] {
  if (Array.isArray(rawPayload)) {
    if (
      rawPayload.length > 0 &&
      rawPayload[0] &&
      typeof rawPayload[0] === 'object' &&
      Array.isArray((rawPayload[0] as { history?: unknown }).history)
    ) {
      return rawPayload.flatMap((item) =>
        Array.isArray((item as { history?: RawItadHistoryLogEntry[] }).history)
          ? ((item as { history: RawItadHistoryLogEntry[] }).history)
          : [],
      );
    }
    return rawPayload as RawItadHistoryLogEntry[];
  }

  if (rawPayload && typeof rawPayload === 'object') {
    const obj = rawPayload as { history?: unknown; list?: unknown };
    if (Array.isArray(obj.history)) return obj.history as RawItadHistoryLogEntry[];
    if (Array.isArray(obj.list)) return obj.list as RawItadHistoryLogEntry[];
  }

  return [];
}

/**
 * Transforms raw ITAD /games/history/v2 log entries into sorted, deduplicated,
 * and bounded chronological PricePoint checkpoints restricted to verified storefronts.
 */
export function transformItadPriceHistory(
  rawEntries: unknown,
  currency: string = 'USD',
  allTimeLowPrice: number | null = null,
  maxPoints: number = MAX_PRICE_HISTORY_POINTS,
): PricePoint[] {
  const entries = extractRawHistoryEntries(rawEntries);
  if (entries.length === 0 || maxPoints <= 0) return [];

  const isBrl = currency.toUpperCase().trim() === 'BRL';

  interface ParsedCheckpoint {
    epochMs: number;
    timestamp: string;
    shopId: 'steam' | 'nuuvem' | 'epic' | 'gog';
    shopName: string;
    price: number;
    regularPrice: number;
    cutPercent: number;
  }

  const parsed: ParsedCheckpoint[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const store = resolveItadHistoryStore(entry.shop ?? entry.shopId);
    if (!store) continue;

    const rawTimestamp = entry.timestamp ?? entry.date;
    if (rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === '') continue;
    const dateObj =
      typeof rawTimestamp === 'number'
        ? new Date(rawTimestamp < 10000000000 ? rawTimestamp * 1000 : rawTimestamp)
        : new Date(String(rawTimestamp));
    const epochMs = dateObj.getTime();
    if (Number.isNaN(epochMs)) continue;

    const rawPriceVal =
      entry.deal?.price?.amount ??
      (typeof entry.price === 'object' && entry.price !== null ? entry.price.amount : entry.price);
    const numPrice = Number(rawPriceVal);
    if (!Number.isFinite(numPrice) || numPrice < 0) continue;
    const price = Number(numPrice.toFixed(2));

    const rawRegularVal =
      entry.deal?.regular?.amount ??
      (typeof entry.regular === 'object' && entry.regular !== null ? entry.regular.amount : entry.regular);
    const numRegular = Number(rawRegularVal);
    const regularPrice =
      Number.isFinite(numRegular) && numRegular >= 0 ? Number(numRegular.toFixed(2)) : price;

    const rawCut = entry.deal?.cut ?? entry.cut;
    let cutPercent = 0;
    if (typeof rawCut === 'number' && Number.isFinite(rawCut)) {
      cutPercent = Math.max(0, Math.min(100, Math.round(rawCut)));
    } else if (regularPrice > 0 && price < regularPrice) {
      cutPercent = Math.max(0, Math.min(100, Math.round(((regularPrice - price) / regularPrice) * 100)));
    }

    parsed.push({
      epochMs,
      timestamp: dateObj.toISOString(),
      shopId: store.shopId,
      shopName: store.shopName,
      price,
      regularPrice,
      cutPercent,
    });
  }

  if (parsed.length === 0) return [];

  parsed.sort((a, b) => a.epochMs - b.epochMs);

  // Deduplicate exact consecutive duplicates (same timestamp, shopId, price)
  const deduped: ParsedCheckpoint[] = [];
  for (const item of parsed) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.timestamp === item.timestamp && prev.shopId === item.shopId && prev.price === item.price) {
      continue;
    }
    deduped.push(item);
  }

  let effectiveAtl: number | null =
    typeof allTimeLowPrice === 'number' && Number.isFinite(allTimeLowPrice) && allTimeLowPrice >= 0
      ? Number(allTimeLowPrice.toFixed(2))
      : null;

  const positivePrices = deduped.map((p) => p.price).filter((p) => p > 0);
  if (positivePrices.length > 0) {
    const minPositive = Math.min(...positivePrices);
    if (effectiveAtl === null || minPositive < effectiveAtl) {
      effectiveAtl = minPositive;
    }
  } else if (effectiveAtl === null) {
    effectiveAtl = Math.min(...deduped.map((p) => p.price));
  }

  const isAtlPoint = (pt: ParsedCheckpoint): boolean =>
    effectiveAtl !== null && pt.price <= effectiveAtl + 0.001;

  let compacted = deduped;
  if (compacted.length > maxPoints) {
    // Collapse consecutive redundant checkpoints with identical shopId and price,
    // preserving first, last, and any ATL inflection points.
    const reduced: ParsedCheckpoint[] = [];
    for (let i = 0; i < compacted.length; i++) {
      const curr = compacted[i];
      const prev = reduced[reduced.length - 1];
      const isEdge = i === 0 || i === compacted.length - 1;
      if (!isEdge && !isAtlPoint(curr) && prev && prev.shopId === curr.shopId && prev.price === curr.price) {
        continue;
      }
      reduced.push(curr);
    }
    compacted = reduced;
  }

  let sampled = compacted;
  if (compacted.length > maxPoints) {
    const total = compacted.length;
    const selectedIndices = new Set<number>([0, total - 1]);

    const atlIndices: number[] = [];
    for (let i = 0; i < total; i++) {
      if (isAtlPoint(compacted[i])) {
        atlIndices.push(i);
      }
    }
    if (atlIndices.length > 0) {
      selectedIndices.add(atlIndices[0]);
      selectedIndices.add(atlIndices[atlIndices.length - 1]);
    }

    if (selectedIndices.size < maxPoints && total > 2) {
      const interiorSlots = maxPoints - selectedIndices.size;
      for (let slot = 1; slot <= interiorSlots; slot++) {
        const candidateIdx = Math.round((slot * (total - 1)) / (interiorSlots + 1));
        if (!selectedIndices.has(candidateIdx)) {
          selectedIndices.add(candidateIdx);
        } else {
          // Find nearest unselected interior index if collision occurred
          for (let offset = 1; offset < total; offset++) {
            if (candidateIdx + offset < total - 1 && !selectedIndices.has(candidateIdx + offset)) {
              selectedIndices.add(candidateIdx + offset);
              break;
            }
            if (candidateIdx - offset > 0 && !selectedIndices.has(candidateIdx - offset)) {
              selectedIndices.add(candidateIdx - offset);
              break;
            }
          }
        }
      }
    }

    sampled = Array.from(selectedIndices)
      .sort((a, b) => a - b)
      .slice(0, maxPoints)
      .map((idx) => compacted[idx]);
  }

  return sampled.map((pt) => ({
    timestamp: pt.timestamp,
    shopId: pt.shopId,
    shopName: pt.shopName,
    priceUsd: isBrl ? null : pt.price,
    priceBrl: isBrl ? pt.price : null,
    price: pt.price,
    regularPrice: pt.regularPrice,
    cutPercent: pt.cutPercent,
    isAllTimeLow: isAtlPoint(pt),
  }));
}

/**
 * Synthesizes a truthful, deterministic multi-point chronological anchor timeline
 * when ITAD /games/history/v2 yields fewer than 2 checkpoints, using verified regular,
 * historical low, and current active deal prices.
 */
export function synthesizeAnchorPriceHistory(
  existingHistory: PricePoint[],
  primaryDeal: StoreDeal | null | undefined,
  cheaperAlternative: StoreDeal | null | undefined,
  allTimeLowPrice: number | null | undefined,
  currency: string = 'USD',
  atlMeta?: { timestamp?: string | number | null; shopName?: string | null; regularPrice?: number | null },
): PricePoint[] {
  if (Array.isArray(existingHistory) && existingHistory.length >= 2) {
    return existingHistory;
  }

  if (
    !primaryDeal ||
    typeof primaryDeal.salePrice !== 'number' ||
    !Number.isFinite(primaryDeal.salePrice) ||
    primaryDeal.salePrice <= 0
  ) {
    return Array.isArray(existingHistory) ? existingHistory : [];
  }

  const isBrl = currency.toUpperCase().trim() === 'BRL';
  const activeDeal =
    cheaperAlternative &&
    typeof cheaperAlternative.salePrice === 'number' &&
    Number.isFinite(cheaperAlternative.salePrice) &&
    cheaperAlternative.salePrice > 0 &&
    cheaperAlternative.salePrice < primaryDeal.salePrice
      ? cheaperAlternative
      : primaryDeal;

  const currentPrice = Number(activeDeal.salePrice.toFixed(2));
  const regularBase =
    typeof activeDeal.regularPrice === 'number' && Number.isFinite(activeDeal.regularPrice) && activeDeal.regularPrice > 0
      ? Number(activeDeal.regularPrice.toFixed(2))
      : typeof primaryDeal.regularPrice === 'number' && Number.isFinite(primaryDeal.regularPrice) && primaryDeal.regularPrice > 0
        ? Number(primaryDeal.regularPrice.toFixed(2))
        : currentPrice;
  const regularPrice = Math.max(regularBase, currentPrice);

  const hasValidAtl =
    typeof allTimeLowPrice === 'number' && Number.isFinite(allTimeLowPrice) && allTimeLowPrice > 0;
  const effectiveAtl = hasValidAtl ? Number(allTimeLowPrice.toFixed(2)) : null;

  if (effectiveAtl === null) {
    return [];
  }

  const activeShopCanonical = resolveStoreName(activeDeal.shopName) || 'Steam';
  const activeShopId = STORE_NAME_TO_SHOP_ID[activeShopCanonical] || 'steam';

  const toPoint = (
    epochMs: number,
    shopId: 'steam' | 'nuuvem' | 'epic' | 'gog',
    shopName: string,
    price: number,
    regPrice: number,
    isAtl: boolean,
  ): PricePoint => {
    const roundedPrice = Number(price.toFixed(2));
    const roundedReg = Number(Math.max(regPrice, roundedPrice).toFixed(2));
    const cut =
      roundedReg > 0 && roundedPrice < roundedReg
        ? Math.max(0, Math.min(100, Math.round(((roundedReg - roundedPrice) / roundedReg) * 100)))
        : 0;
    return {
      timestamp: new Date(epochMs).toISOString(),
      shopId,
      shopName,
      priceUsd: isBrl ? null : roundedPrice,
      priceBrl: isBrl ? roundedPrice : null,
      price: roundedPrice,
      regularPrice: roundedReg,
      cutPercent: cut,
      isAllTimeLow: isAtl,
    };
  };

  const nowMs = Date.now();

  if (Array.isArray(existingHistory) && existingHistory.length === 1) {
    const single = existingHistory[0];
    const singleMs = new Date(single.timestamp).getTime();
    const validSingleMs = Number.isFinite(singleMs) ? singleMs : nowMs - 30 * 86400 * 1000;
    const points: PricePoint[] = [];

    const singlePrice =
      typeof single.price === 'number' && Number.isFinite(single.price)
        ? single.price
        : isBrl
          ? (single.priceBrl ?? currentPrice)
          : (single.priceUsd ?? currentPrice);

    const baselineMs = Math.min(validSingleMs, nowMs - 60000) - 90 * 86400 * 1000;
    if (singlePrice > effectiveAtl + 0.001) {
      const atlShopCanonical = resolveStoreName(atlMeta?.shopName) || activeShopCanonical;
      const atlShopId = STORE_NAME_TO_SHOP_ID[atlShopCanonical] || activeShopId;
      const parsedAtlMs = atlMeta?.timestamp ? new Date(atlMeta.timestamp).getTime() : NaN;
      const atlMs =
        Number.isFinite(parsedAtlMs) && parsedAtlMs < nowMs - 60000 && parsedAtlMs !== validSingleMs
          ? parsedAtlMs
          : baselineMs;
      points.push(toPoint(atlMs, atlShopId, atlShopCanonical, effectiveAtl, regularPrice, true));
    } else if (regularPrice > singlePrice) {
      points.push(toPoint(baselineMs, activeShopId, activeShopCanonical, regularPrice, regularPrice, false));
    }

    points.push(single);

    if (validSingleMs < nowMs - 60000) {
      const currentIsAtl = currentPrice <= effectiveAtl + 0.001;
      points.push(toPoint(nowMs, activeShopId, activeShopCanonical, currentPrice, regularPrice, currentIsAtl));
    }

    points.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return points.slice(-MAX_PRICE_HISTORY_POINTS);
  }

  const parsedAtlMs = atlMeta?.timestamp ? new Date(atlMeta.timestamp).getTime() : NaN;
  const atlMs =
    Number.isFinite(parsedAtlMs) && parsedAtlMs < nowMs - 60000
      ? parsedAtlMs
      : nowMs - 90 * 86400 * 1000;
  const baselineMs = Math.min(atlMs, nowMs) - 180 * 86400 * 1000;

  const atlShopCanonical = resolveStoreName(atlMeta?.shopName) || activeShopCanonical;
  const atlShopId = STORE_NAME_TO_SHOP_ID[atlShopCanonical] || activeShopId;
  const atlRegular =
    typeof atlMeta?.regularPrice === 'number' && Number.isFinite(atlMeta.regularPrice) && atlMeta.regularPrice > 0
      ? Math.max(atlMeta.regularPrice, regularPrice)
      : regularPrice;

  const currentIsAtl = currentPrice <= effectiveAtl + 0.001;
  const points: PricePoint[] = [
    toPoint(baselineMs, activeShopId, activeShopCanonical, atlRegular, atlRegular, false),
    toPoint(atlMs, atlShopId, atlShopCanonical, effectiveAtl, atlRegular, true),
    toPoint(nowMs, activeShopId, activeShopCanonical, currentPrice, regularPrice, currentIsAtl),
  ];

  points.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return points;
}

/**
 * Fetches chronological price history from ITAD /games/history/v2 for verified storefronts
 * within the caller's bounded AbortSignal. Passes an explicit 24-month RFC3339 `since`
 * timestamp without milliseconds. Returns [] on failure so deal resolution stays resilient.
 */
export async function fetchItadPriceHistory(
  itadGameId: string,
  preferredCurrency: string,
  itadKey: string,
  signal: AbortSignal,
): Promise<RawItadHistoryLogEntry[]> {
  if (!itadGameId || !itadKey || signal.aborted) return [];

  const itadCountry = preferredCurrency.toUpperCase().trim() === 'BRL' ? 'BR' : 'US';
  const shopsParam = ITAD_VERIFIED_SHOP_IDS.join(',');
  const sinceIso = new Date(Date.now() - ITAD_HISTORY_LOOKBACK_DAYS * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const historyLogUrl = `${ITAD_BASE_URL}/games/history/v2?key=${itadKey}&id=${encodeURIComponent(itadGameId)}&country=${itadCountry}&shops=${shopsParam}&since=${encodeURIComponent(sinceIso)}`;

  try {
    const res = await fetchItadWithRetry(
      historyLogUrl,
      { headers: { 'User-Agent': USER_AGENT } },
      signal,
    );
    if (!res.ok) return [];
    const payload = (await res.json()) as unknown;
    return extractRawHistoryEntries(payload);
  } catch {
    return [];
  }
}

const ITAD_TIMEOUT_MS = 1800;
const ITAD_PRICES_TIMEOUT_MS = 3200;
const ITAD_HISTORY_TIMEOUT_MS = 2200;
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
      const jitterMs = Math.floor(Math.random() * 100);
      const delayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 400) + jitterMs
          : ITAD_RETRY_BASE_DELAY_MS * attempt + jitterMs;
      await abortableDelay(delayMs, signal);
    } catch (err: unknown) {
      lastError = err;
      if (signal.aborted || attempt === ITAD_MAX_ATTEMPTS) break;
      const jitterMs = Math.floor(Math.random() * 100);
      await abortableDelay(ITAD_RETRY_BASE_DELAY_MS * attempt + jitterMs, signal);
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
        const rawData = steamData?.[appId]?.data;
        if (!rawData || Array.isArray(rawData) || typeof rawData !== 'object') {
          return null;
        }
        return rawData;
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

function extractHistoryLowMeta(matchedItem: RawItadHistoryLowItem | null): {
  low: number | null;
  meta: HistoryLowMeta;
} {
  const rawLow = matchedItem?.low?.price?.amount;
  if (typeof rawLow !== 'number' || !Number.isFinite(rawLow) || rawLow < 0) {
    return { low: null, meta: {} };
  }
  const shopName =
    resolveStoreName(matchedItem?.low?.shop?.name) ||
    (matchedItem?.low?.shop?.id !== undefined && matchedItem?.low?.shop?.id !== null
      ? ITAD_SHOP_ID_TO_STORE[String(matchedItem.low.shop.id).trim()]?.shopName ?? null
      : null) ||
    matchedItem?.low?.shop?.name ||
    null;

  return {
    low: Number(rawLow.toFixed(2)),
    meta: {
      timestamp: matchedItem?.low?.timestamp ?? null,
      shopName,
      regularPrice:
        typeof matchedItem?.low?.regular?.amount === 'number' &&
        Number.isFinite(matchedItem.low.regular.amount)
          ? Number(matchedItem.low.regular.amount.toFixed(2))
          : null,
    },
  };
}

function ingestItadDealsIntoBreakdown(
  items: RawItadPriceOverviewItem[],
  options: {
    currency: string;
    currencySymbol: string;
    steamAppId: string | null;
    storeBreakdown: Record<string, StoreDeal>;
    isSecondary: boolean;
    onHistoryLowCandidate?: (val: unknown) => void;
  },
): void {
  const { currency, currencySymbol, steamAppId, storeBreakdown, isSecondary, onHistoryLowCandidate } = options;
  for (const item of items || []) {
    if (!isSecondary && item.historyLow && onHistoryLowCandidate) {
      onHistoryLowCandidate(item.historyLow.all?.amount);
      onHistoryLowCandidate(item.historyLow.y1?.amount);
      onHistoryLowCandidate(item.historyLow.m3?.amount);
    }

    for (const d of item.deals || []) {
      const shopName =
        resolveStoreName(d.shop?.name) ||
        (d.shop?.id !== undefined && d.shop?.id !== null
          ? ITAD_SHOP_ID_TO_STORE[String(d.shop.id).trim()]?.shopName ?? null
          : null);
      if (!shopName) continue; // STRICTLY IGNORE outside our 4 approved stores

      if (!isSecondary && onHistoryLowCandidate) {
        onHistoryLowCandidate(d.storeLow?.amount);
      }

      if (isSecondary && (shopName === 'Steam' || storeBreakdown[shopName])) {
        continue;
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
}

function buildStoreDealSummary(
  storeBreakdown: Record<string, StoreDeal>,
  currency: string,
  currencySymbol: string,
): {
  primaryDeal: StoreDeal;
  cheaperAlternative: StoreDeal | null;
  absoluteCheapest: StoreDeal;
} {
  const availableDeals = Object.values(storeBreakdown);
  const sortedByPrice = [...availableDeals].sort((a, b) => a.salePrice - b.salePrice);
  const absoluteCheapest = sortedByPrice[0];
  const primaryRaw = storeBreakdown['Steam'] || absoluteCheapest;
  const secondaryRaw = absoluteCheapest.salePrice < primaryRaw.salePrice ? absoluteCheapest : null;

  const toStoreDeal = (raw: StoreDeal): StoreDeal => ({
    shopName: raw.shopName,
    salePrice: raw.salePrice,
    regularPrice: raw.regularPrice,
    cutPercent: raw.cutPercent,
    url: raw.url,
    expiry: raw.expiry || null,
    currency,
    currencySymbol,
  });

  return {
    primaryDeal: toStoreDeal(primaryRaw),
    cheaperAlternative: secondaryRaw ? toStoreDeal(secondaryRaw) : null,
    absoluteCheapest,
  };
}

function ensureAtlInPriceHistory(
  priceHistory: PricePoint[],
  historyLow: number,
  historyLowMeta: HistoryLowMeta,
  primaryDeal: StoreDeal,
  currency: string,
): PricePoint[] {
  if (priceHistory.length === 0 || priceHistory.some((pt) => pt.isAllTimeLow)) {
    return priceHistory;
  }

  const isBrl = currency.toUpperCase().trim() === 'BRL';
  const roundedAtl = Number(historyLow.toFixed(2));
  const firstMs = new Date(priceHistory[0].timestamp).getTime();
  const parsedMetaMs = historyLowMeta.timestamp ? new Date(historyLowMeta.timestamp).getTime() : NaN;
  const atlEpochMs = Number.isFinite(parsedMetaMs)
    ? parsedMetaMs
    : (Number.isFinite(firstMs) ? firstMs : Date.now()) - 90 * 86400 * 1000;

  const atlShopCanonical =
    resolveStoreName(historyLowMeta.shopName) || resolveStoreName(primaryDeal.shopName) || 'Steam';
  const atlShopId = STORE_NAME_TO_SHOP_ID[atlShopCanonical] || 'steam';
  const atlReg =
    typeof historyLowMeta.regularPrice === 'number' &&
    Number.isFinite(historyLowMeta.regularPrice) &&
    historyLowMeta.regularPrice > 0
      ? Number(Math.max(historyLowMeta.regularPrice, roundedAtl).toFixed(2))
      : Number(Math.max(primaryDeal.regularPrice || roundedAtl, roundedAtl).toFixed(2));
  const cutPercent =
    atlReg > 0 && roundedAtl < atlReg
      ? Math.max(0, Math.min(100, Math.round(((atlReg - roundedAtl) / atlReg) * 100)))
      : 0;

  const atlPoint: PricePoint = {
    timestamp: new Date(atlEpochMs).toISOString(),
    shopId: atlShopId,
    shopName: atlShopCanonical,
    priceUsd: isBrl ? null : roundedAtl,
    priceBrl: isBrl ? roundedAtl : null,
    price: roundedAtl,
    regularPrice: atlReg,
    cutPercent,
    isAllTimeLow: true,
  };

  const next = [...priceHistory];
  if (next.length >= MAX_PRICE_HISTORY_POINTS) {
    // Drop an interior checkpoint so first/last timeline bounds remain anchored
    const removeIdx = next.length > 2 ? 1 : 0;
    next.splice(removeIdx, 1);
  }
  next.push(atlPoint);
  next.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return next.slice(0, MAX_PRICE_HISTORY_POINTS);
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
  syncItadRuntimeCaches();
  const cached = steamAppIdToItadUuidCache.get(steamAppId);
  if (cached) {
    return { id: cached.id, title: cached.title, transientError: false };
  }

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
        const entry = {
          id: lookupData.game.id,
          title: lookupData.game.title || null,
        };
        steamAppIdToItadUuidCache.set(steamAppId, entry);
        return {
          ...entry,
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
        const cleanUuid = mappedUuid.trim();
        steamAppIdToItadUuidCache.set(steamAppId, { id: cleanUuid, title: null });
        return { id: cleanUuid, title: null, transientError: false };
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
  syncItadRuntimeCaches();
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

  const lookupController = new AbortController();
  const pricesController = new AbortController();
  let lookupTimedOut = false;
  let pricesTimedOut = false;
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let pricesTimer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    lookupController.abort();
    pricesController.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      lookupController.abort();
      pricesController.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const activeLookupSignal = lookupController.signal;
  const activePricesSignal = pricesController.signal;

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

    // 1. Concurrently kick off bounded Steam Store details (1500ms) and ITAD resolution
    const steamPromise = steamAppId
      ? fetchSteamStoreAppDetails(steamAppId, country, externalSignal, STEAM_DETAILS_TIMEOUT_MS)
      : Promise.resolve(null);

    let historyLow: number | null = null;
    let historyLowMeta: {
      timestamp?: string | number | null;
      shopName?: string | null;
      regularPrice?: number | null;
    } = {};
    let rawHistoryEntries: RawItadHistoryLogEntry[] = [];
    const storeBreakdown: Record<string, StoreDeal> = {};
    let resolvedLookupTitle: string | null = null;
    let alternativeCheckStatus: 'confirmed' | 'degraded' | 'skipped' = itadKey ? 'confirmed' : 'skipped';
    let alternativeCheckDegraded = false;
    let secondarySearchExecuted = false;
    let primaryPricesSucceeded = false;
    let lookupTransientError = false;

    const recordCandidateHistoryLow = (val: unknown) => {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        const normalized = Number(val.toFixed(2));
        if (historyLow === null || normalized < historyLow) {
          historyLow = normalized;
        }
      }
    };

    const ingestDeals = (items: RawItadPriceOverviewItem[], isSecondary: boolean) => {
      ingestItadDealsIntoBreakdown(items, {
        currency,
        currencySymbol,
        steamAppId,
        storeBreakdown,
        isSecondary,
        onHistoryLowCandidate: isSecondary ? undefined : recordCandidateHistoryLow,
      });
    };

    const runItadPipeline = async (): Promise<'ITAD_DONE'> => {
      if (!itadKey) {
        return 'ITAD_DONE';
      }

      // Stage 1: Direct Steam AppID mapping first (bounded by ITAD_TIMEOUT_MS = 1800ms)
      if (!itadGameId) {
        const lookupDeadlinePromise = new Promise<'LOOKUP_TIMEOUT'>((resolve) => {
          lookupTimer = setTimeout(() => {
            lookupTimedOut = true;
            lookupController.abort(new DOMException(`ITAD lookup exceeded ${ITAD_TIMEOUT_MS}ms timeout`, 'TimeoutError'));
            resolve('LOOKUP_TIMEOUT');
          }, ITAD_TIMEOUT_MS);
        });

        const executeLookup = async (): Promise<'LOOKUP_DONE'> => {
          if (steamAppId) {
            const direct = await resolveItadIdBySteamAppId(steamAppId, itadKey, activeLookupSignal);
            if (direct.id) itadGameId = direct.id;
            if (direct.title) resolvedLookupTitle = direct.title;
            if (direct.transientError) lookupTransientError = true;
          } else if (title && title !== 'Monitored Title') {
            try {
              const sanitizedLookupTitle = sanitizeTitleForItadLookup(title) || title;
              const lookupUrl = `${ITAD_BASE_URL}/games/lookup/v1?key=${itadKey}&title=${encodeURIComponent(sanitizedLookupTitle)}`;
              const lookupRes = await fetchItadWithRetry(
                lookupUrl,
                { headers: { 'User-Agent': USER_AGENT } },
                activeLookupSignal,
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
          return 'LOOKUP_DONE';
        };

        const lookupOutcome = await Promise.race([executeLookup(), lookupDeadlinePromise]);
        if (lookupTimer) clearTimeout(lookupTimer);

        if (lookupOutcome === 'LOOKUP_TIMEOUT' || lookupTimedOut || activeLookupSignal.aborted) {
          alternativeCheckDegraded = true;
          alternativeCheckStatus = 'degraded';
          secondarySearchExecuted = false;
          console.warn(`[ITAD] Lookup exceeded ${ITAD_TIMEOUT_MS}ms timeout for ${rawGameIdentifier}; returning fast fallback.`);
          return 'ITAD_DONE';
        }
      }

      if (!title && resolvedLookupTitle) {
        title = resolvedLookupTitle;
      }
      if (!title && titleFallback) {
        title = titleFallback;
      }

      // Stage 2: Multi-store prices, historical low, and history log (bounded by ITAD_PRICES_TIMEOUT_MS = 3200ms)
      let primaryItadId = itadGameId || null;

      const pricesDeadlinePromise = new Promise<'PRICES_TIMEOUT'>((resolve) => {
        pricesTimer = setTimeout(() => {
          pricesTimedOut = true;
          pricesController.abort(new DOMException(`ITAD prices exceeded ${ITAD_PRICES_TIMEOUT_MS}ms timeout`, 'TimeoutError'));
          resolve('PRICES_TIMEOUT');
        }, ITAD_PRICES_TIMEOUT_MS);
      });

      const queryPricesAndHistory = async (targetItadId: string): Promise<boolean> => {
        const shopsParam = ITAD_VERIFIED_SHOP_IDS.join(',');
        const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${itadCountry}&shops=${shopsParam}`;
        const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${itadKey}&country=${itadCountry}&shops=${shopsParam}`;
        const requestBody = JSON.stringify([targetItadId]);
        const cacheKey = `${targetItadId}:${currency}`;

        const runHistoryLogTask = async (): Promise<void> => {
          const historyCtrl = new AbortController();
          const onPricesAbort = () => historyCtrl.abort();
          if (activePricesSignal.aborted) {
            historyCtrl.abort();
          } else {
            activePricesSignal.addEventListener('abort', onPricesAbort, { once: true });
          }
          const historyLogTimer = setTimeout(() => {
            historyCtrl.abort(new DOMException(`ITAD history exceeded ${ITAD_HISTORY_TIMEOUT_MS}ms timeout`, 'TimeoutError'));
          }, ITAD_HISTORY_TIMEOUT_MS);

          try {
            const entries = await fetchItadPriceHistory(targetItadId, currency, itadKey, historyCtrl.signal);
            if (entries.length > 0) {
              rawHistoryEntries = entries;
            }
          } finally {
            clearTimeout(historyLogTimer);
            activePricesSignal.removeEventListener('abort', onPricesAbort);
          }
        };

        // Check in-memory bulk price cache warmed by batchResolveItadDeals or recent modal clicks
        const cachedBulk = itadBulkPriceCache.get(cacheKey);
        if (cachedBulk && cachedBulk.expiresAt > Date.now()) {
          ingestDeals(cachedBulk.items, false);
          if (cachedBulk.historyLow !== null) {
            recordCandidateHistoryLow(cachedBulk.historyLow);
            historyLowMeta = { ...cachedBulk.historyLowMeta };
          }
          primaryPricesSucceeded = true;
          if (!activePricesSignal.aborted) {
            await runHistoryLogTask();
          }
          return true;
        }

        // Execute /games/prices/v3 FIRST so concurrent advisory calls never burst-starve primary storefront pricing
        let priceOk = false;
        let resolvedPriceData: RawItadPriceOverviewItem[] = [];
        try {
          const priceRes = await fetchItadWithRetry(
            priceUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: requestBody,
            },
            activePricesSignal,
          );
          if (priceRes.ok) {
            primaryPricesSucceeded = true;
            resolvedPriceData = (await priceRes.json()) as RawItadPriceOverviewItem[];
            ingestDeals(resolvedPriceData, false);
            priceOk = true;
          } else {
            alternativeCheckDegraded = true;
            alternativeCheckStatus = 'degraded';
          }
        } catch (primaryErr: unknown) {
          alternativeCheckDegraded = true;
          alternativeCheckStatus = 'degraded';
          const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
          console.error('ITAD primary prices/history query error:', msg);
        }

        if (!priceOk || activePricesSignal.aborted) {
          return priceOk;
        }

        // Skip redundant /games/historylow/v1 call if /games/prices/v3 already delivered historyLow
        const historyTask: Promise<void> =
          historyLow !== null
            ? Promise.resolve()
            : (async (): Promise<void> => {
                try {
                  const historyRes = await fetchItadWithRetry(
                    historyUrl,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                      body: requestBody,
                    },
                    activePricesSignal,
                  );
                  if (historyRes.ok) {
                    const historyData = (await historyRes.json()) as RawItadHistoryLowItem[];
                    const matchedItem =
                      (Array.isArray(historyData)
                        ? historyData.find((item) => item.id === targetItadId) || historyData[0]
                        : null) || null;
                    const extracted = extractHistoryLowMeta(matchedItem);
                    if (extracted.low !== null) {
                      recordCandidateHistoryLow(extracted.low);
                      historyLowMeta = extracted.meta;
                    }
                  }
                } catch {
                  // History low lookup is advisory; do not discard discovered store prices
                }
              })();

        await Promise.allSettled([historyTask, runHistoryLogTask()]);

        if (Array.isArray(resolvedPriceData) && resolvedPriceData.length > 0) {
          itadBulkPriceCache.set(cacheKey, {
            items: resolvedPriceData,
            historyLow,
            historyLowMeta: { ...historyLowMeta },
            expiresAt: Date.now() + ITAD_BULK_PRICE_CACHE_TTL_MS,
          });
        }

        return priceOk;
      };

      const executeStage2 = async (): Promise<'PRICES_DONE'> => {
        if (primaryItadId) {
          await queryPricesAndHistory(primaryItadId);
        }

        // Step 3 (Conditional Secondary Edition Search):
        // Runs ONLY if Step 2 did not already degrade and returned 0 non-Steam partner deals.
        const hasPartnerStore = Object.keys(storeBreakdown).some((k) => k !== 'Steam');
        if (!hasPartnerStore && !lookupTransientError && !alternativeCheckDegraded && !activePricesSignal.aborted) {
          const appDetailsForTitle = await steamPromise;
          if (appDetailsForTitle?.name) {
            officialSteamTitle = appDetailsForTitle.name;
            title = appDetailsForTitle.name;
          }

          const rawSearchTitle = officialSteamTitle || resolvedLookupTitle || titleFallback || title;
          const baseTitle = sanitizeTitleForItadLookup(rawSearchTitle);

          if (baseTitle && baseTitle !== 'Monitored Title' && baseTitle.length > 1 && !activePricesSignal.aborted) {
            try {
              const secSearchUrl = `${ITAD_BASE_URL}/games/search/v1?key=${itadKey}&title=${encodeURIComponent(baseTitle)}&results=5`;
              const secSearchRes = await fetchItadWithRetry(
                secSearchUrl,
                { headers: { 'User-Agent': USER_AGENT } },
                activePricesSignal,
              );

              if (secSearchRes.ok) {
                const searchItems = (await secSearchRes.json()) as RawItadSearchItem[];
                const exactIds: string[] = [];
                const editionIds: string[] = [];

                if (Array.isArray(searchItems)) {
                  const normalizeExact = (str: string): string =>
                    str
                      .replace(/[™®©℠]/g, '')
                      .replace(/\((?:tm|r|c)\)/gi, '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .toLowerCase();
                  const baseLower = normalizeExact(baseTitle);

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
                      if (normalizeExact(sItem.title) === baseLower) {
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

                  const primaryOk = await queryPricesAndHistory(primaryItadId);
                  if (!primaryOk) {
                    secondaryCompletedCleanly = false;
                  }
                }

                // Fetch secondary edition prices and merge non-Steam stores
                if (secondaryEditionIds.length > 0 && !activePricesSignal.aborted) {
                  try {
                    const secPriceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${itadCountry}`;
                    const secPriceRes = await fetchItadWithRetry(
                      secPriceUrl,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                        body: JSON.stringify(secondaryEditionIds),
                      },
                      activePricesSignal,
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

        return 'PRICES_DONE';
      };

      const stage2Outcome = await Promise.race([executeStage2(), pricesDeadlinePromise]);
      if (pricesTimer) clearTimeout(pricesTimer);

      if (stage2Outcome === 'PRICES_TIMEOUT' || pricesTimedOut) {
        if (!primaryPricesSucceeded) {
          alternativeCheckDegraded = true;
          alternativeCheckStatus = 'degraded';
          secondarySearchExecuted = false;
          console.warn(`[ITAD] Prices lookup exceeded ${ITAD_PRICES_TIMEOUT_MS}ms timeout for ${rawGameIdentifier}; returning fast fallback.`);
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

    if (itadKey) {
      await runItadPipeline();
    }

    if (lookupTimer) clearTimeout(lookupTimer);
    if (pricesTimer) clearTimeout(pricesTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

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

    const { primaryDeal, cheaperAlternative, absoluteCheapest } = buildStoreDealSummary(
      storeBreakdown,
      currency,
      currencySymbol,
    );

    const isDegradedState =
      Boolean(alternativeCheckDegraded) || String(alternativeCheckStatus) === 'degraded';
    let priceHistory: PricePoint[] = [];

    if (isDegradedState) {
      // Never fabricate an All-Time Low or synthetic chart from degraded Steam-only fallbacks
      historyLow = null;
      priceHistory = [];
    } else {
      priceHistory = transformItadPriceHistory(
        rawHistoryEntries,
        currency,
        historyLow,
        MAX_PRICE_HISTORY_POINTS,
      );

      const positiveHistoryPrices = priceHistory
        .map((pt) => pt.price)
        .filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0);
      if (positiveHistoryPrices.length > 0) {
        const minHistoryPrice = Math.min(...positiveHistoryPrices);
        if (historyLow === null || minHistoryPrice < historyLow) {
          historyLow = minHistoryPrice;
        }
      }

      if (historyLow !== null && absoluteCheapest.salePrice > 0 && absoluteCheapest.salePrice < historyLow) {
        historyLow = Number(absoluteCheapest.salePrice.toFixed(2));
      }

      if (priceHistory.length < 2 && historyLow !== null) {
        priceHistory = synthesizeAnchorPriceHistory(
          priceHistory,
          primaryDeal,
          cheaperAlternative,
          historyLow,
          currency,
          historyLowMeta,
        );
      } else if (priceHistory.length > 0 && historyLow !== null && !priceHistory.some((pt) => pt.isAllTimeLow)) {
        priceHistory = ensureAtlInPriceHistory(
          priceHistory,
          historyLow,
          historyLowMeta,
          primaryDeal,
          currency,
        );
      }
    }

    const primaryIsAtl =
      !isDegradedState &&
      primaryDeal.cutPercent > 0 &&
      primaryDeal.salePrice < primaryDeal.regularPrice &&
      historyLow !== null &&
      primaryDeal.salePrice <= historyLow;

    const cheaperIsAtl =
      !isDegradedState &&
      Boolean(cheaperAlternative) &&
      (cheaperAlternative?.cutPercent ?? 0) > 0 &&
      (cheaperAlternative?.salePrice ?? 0) < (cheaperAlternative?.regularPrice ?? 0) &&
      historyLow !== null &&
      (cheaperAlternative?.salePrice ?? 0) <= historyLow;

    const isAllTimeLow = !isDegradedState && historyLow !== null && (primaryIsAtl || cheaperIsAtl);

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
      priceHistory,
      expiry: primaryDeal.expiry || cheaperAlternative?.expiry || null,
      primaryDeal,
      cheaperAlternative,
      storeBreakdown,
      alternativeCheckStatus,
      alternativeCheckDegraded,
      isPlatformExclusive,
    };
  } catch (error: unknown) {
    if (lookupTimer) clearTimeout(lookupTimer);
    if (pricesTimer) clearTimeout(pricesTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error resolving deal info for ${rawGameIdentifier}:`, msg);
    return null;
  }
}

/**
 * Bulk-resolves multi-store prices and historical lows for a page of Steam AppIDs
 * using at most 3 ITAD HTTP requests (shop-61 lookup, prices/v3, and historylow/v1)
 * and warms the in-memory UUID + bulk price caches for subsequent modal inspections.
 */
export async function batchResolveItadDeals(
  appIds: Array<number | string>,
  currency: 'USD' | 'BRL' = 'USD',
  externalSignal?: AbortSignal,
): Promise<Map<string, GameDealInfo>> {
  syncItadRuntimeCaches();
  const results = new Map<string, GameDealInfo>();

  const itadKey = process.env.ITAD_API_KEY || ITAD_API_KEY;
  if (!itadKey || !Array.isArray(appIds) || appIds.length === 0) {
    return results;
  }

  const isBrl = String(currency || 'USD').toUpperCase().trim() === 'BRL';
  const normalizedCurrency: 'USD' | 'BRL' = isBrl ? 'BRL' : 'USD';
  const currencySymbol = isBrl ? 'R$' : '$';
  const itadCountry = isBrl ? 'BR' : 'US';
  const shopsParam = ITAD_VERIFIED_SHOP_IDS.join(',');

  const cleanAppIds: string[] = [];
  const seenAppIds = new Set<string>();
  for (const raw of appIds) {
    const clean = String(raw ?? '').trim();
    if (!clean || !/^\d+$/.test(clean) || seenAppIds.has(clean)) continue;
    seenAppIds.add(clean);
    cleanAppIds.push(clean);
  }
  if (cleanAppIds.length === 0) {
    return results;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
      return results;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeoutPromise = new Promise<'BATCH_TIMEOUT'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException(`ITAD batch exceeded ${ITAD_PRICES_TIMEOUT_MS}ms timeout`, 'TimeoutError'));
      resolve('BATCH_TIMEOUT');
    }, ITAD_PRICES_TIMEOUT_MS);
  });

  const buildDealFromOverviewItem = (
    appId: string,
    uuid: string,
    item: RawItadPriceOverviewItem,
    cachedLow: number | null,
    cachedMeta: HistoryLowMeta,
    titleHint: string | null,
  ): GameDealInfo | null => {
    const storeBreakdown: Record<string, StoreDeal> = {};
    let itemHistoryLow = cachedLow;
    const recordLow = (val: unknown) => {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        const normalized = Number(val.toFixed(2));
        if (itemHistoryLow === null || normalized < itemHistoryLow) {
          itemHistoryLow = normalized;
        }
      }
    };

    ingestItadDealsIntoBreakdown([item], {
      currency: normalizedCurrency,
      currencySymbol,
      steamAppId: appId,
      storeBreakdown,
      isSecondary: false,
      onHistoryLowCandidate: recordLow,
    });

    if (Object.keys(storeBreakdown).length === 0) {
      return null;
    }

    const { primaryDeal, cheaperAlternative, absoluteCheapest } = buildStoreDealSummary(
      storeBreakdown,
      normalizedCurrency,
      currencySymbol,
    );

    if (itemHistoryLow !== null && absoluteCheapest.salePrice > 0 && absoluteCheapest.salePrice < itemHistoryLow) {
      itemHistoryLow = Number(absoluteCheapest.salePrice.toFixed(2));
    }

    const priceHistory =
      itemHistoryLow !== null
        ? synthesizeAnchorPriceHistory(
            [],
            primaryDeal,
            cheaperAlternative,
            itemHistoryLow,
            normalizedCurrency,
            cachedMeta,
          )
        : [];

    const primaryIsAtl =
      primaryDeal.cutPercent > 0 &&
      primaryDeal.salePrice < primaryDeal.regularPrice &&
      itemHistoryLow !== null &&
      primaryDeal.salePrice <= itemHistoryLow;
    const cheaperIsAtl =
      Boolean(cheaperAlternative) &&
      (cheaperAlternative?.cutPercent ?? 0) > 0 &&
      (cheaperAlternative?.salePrice ?? 0) < (cheaperAlternative?.regularPrice ?? 0) &&
      itemHistoryLow !== null &&
      (cheaperAlternative?.salePrice ?? 0) <= itemHistoryLow;

    const isFree = primaryDeal.salePrice === 0 || Boolean(cheaperAlternative && cheaperAlternative.salePrice === 0);
    const partnerCount = Object.keys(storeBreakdown).filter((k) => k !== 'Steam').length;

    return {
      gameId: `steam_${appId}`,
      title: titleHint || 'Monitored Title',
      imageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
      reviewScore: null,
      steamAppId: appId,
      dealType: isFree ? 'FREE_TO_KEEP' : 'CURATED_DEAL',
      isAllTimeLow: itemHistoryLow !== null && (primaryIsAtl || cheaperIsAtl),
      allTimeLowPrice: itemHistoryLow,
      priceHistory,
      expiry: primaryDeal.expiry || cheaperAlternative?.expiry || null,
      primaryDeal,
      cheaperAlternative,
      storeBreakdown,
      alternativeCheckStatus: 'confirmed',
      alternativeCheckDegraded: false,
      isPlatformExclusive: partnerCount === 0 && Boolean(uuid),
    };
  };

  const executeBatch = async (): Promise<'BATCH_DONE'> => {
    try {
      for (let offset = 0; offset < cleanAppIds.length; offset += ITAD_BULK_BATCH_CHUNK_SIZE) {
        if (controller.signal.aborted) break;
        const chunkAppIds = cleanAppIds.slice(offset, offset + ITAD_BULK_BATCH_CHUNK_SIZE);

        // Step 1: 1 bulk POST /lookup/id/shop/61/v1 for uncached Steam AppIDs
        const missingAppIds = chunkAppIds.filter((id) => !steamAppIdToItadUuidCache.has(id));
        if (missingAppIds.length > 0 && !controller.signal.aborted) {
          try {
            const shopLookupUrl = `${ITAD_BASE_URL}/lookup/id/shop/61/v1?key=${itadKey}`;
            const shopRes = await fetchItadWithRetry(
              shopLookupUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                body: JSON.stringify(missingAppIds.map((id) => `app/${id}`)),
              },
              controller.signal,
            );
            if (shopRes.ok) {
              const shopMap = (await shopRes.json()) as Record<string, string | null>;
              for (const appId of missingAppIds) {
                const mappedUuid = shopMap?.[`app/${appId}`];
                if (typeof mappedUuid === 'string' && mappedUuid.trim().length > 0) {
                  steamAppIdToItadUuidCache.set(appId, { id: mappedUuid.trim(), title: null });
                }
              }
            }
          } catch (lookupErr: unknown) {
            const msg = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
            console.warn('[ITAD Bulk] Shop 61 batch lookup error:', msg);
          }
        }

        if (controller.signal.aborted) break;

        // Collect cached price hits first and determine which UUIDs require live batch fetch
        const appUuidPairs: Array<{ appId: string; uuid: string; title: string | null }> = [];
        const uuidsToFetch: string[] = [];
        const seenUuidsToFetch = new Set<string>();
        const nowMs = Date.now();

        for (const appId of chunkAppIds) {
          const uuidEntry = steamAppIdToItadUuidCache.get(appId);
          if (!uuidEntry?.id) continue;
          appUuidPairs.push({ appId, uuid: uuidEntry.id, title: uuidEntry.title });

          const cacheKey = `${uuidEntry.id}:${normalizedCurrency}`;
          const cachedPrice = itadBulkPriceCache.get(cacheKey);
          if (cachedPrice && cachedPrice.expiresAt > nowMs && cachedPrice.items.length > 0) {
            const built = buildDealFromOverviewItem(
              appId,
              uuidEntry.id,
              cachedPrice.items[0],
              cachedPrice.historyLow,
              cachedPrice.historyLowMeta,
              uuidEntry.title,
            );
            if (built) results.set(appId, built);
          } else if (!seenUuidsToFetch.has(uuidEntry.id)) {
            seenUuidsToFetch.add(uuidEntry.id);
            uuidsToFetch.push(uuidEntry.id);
          }
        }

        if (uuidsToFetch.length === 0 || controller.signal.aborted) {
          continue;
        }

        // Steps 2 & 3: Bulk POST /games/prices/v3 + POST /games/historylow/v1 in 1 parallel pair
        const pricesUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${itadKey}&country=${itadCountry}&shops=${shopsParam}`;
        const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${itadKey}&country=${itadCountry}&shops=${shopsParam}`;
        const uuidBody = JSON.stringify(uuidsToFetch);

        const [pricesSettled, historySettled] = await Promise.allSettled([
          fetchItadWithRetry(
            pricesUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: uuidBody,
            },
            controller.signal,
          ).then(async (res) => (res.ok ? ((await res.json()) as RawItadPriceOverviewItem[]) : null)),
          fetchItadWithRetry(
            historyUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: uuidBody,
            },
            controller.signal,
          ).then(async (res) => (res.ok ? ((await res.json()) as RawItadHistoryLowItem[]) : null)),
        ]);

        const priceItems = pricesSettled.status === 'fulfilled' && Array.isArray(pricesSettled.value)
          ? pricesSettled.value
          : null;
        if (!priceItems) {
          continue;
        }

        const priceItemByUuid = new Map<string, RawItadPriceOverviewItem>();
        for (const item of priceItems) {
          if (item?.id) {
            priceItemByUuid.set(item.id, item);
          }
        }

        const historyLowByUuid = new Map<string, { low: number | null; meta: HistoryLowMeta }>();
        if (historySettled.status === 'fulfilled' && Array.isArray(historySettled.value)) {
          for (const hItem of historySettled.value) {
            if (hItem?.id) {
              historyLowByUuid.set(hItem.id, extractHistoryLowMeta(hItem));
            }
          }
        }

        const writeNowMs = Date.now();
        for (const pair of appUuidPairs) {
          if (results.has(pair.appId)) continue;
          const pItem = priceItemByUuid.get(pair.uuid);
          if (!pItem) continue;

          const hEntry = historyLowByUuid.get(pair.uuid) || { low: null, meta: {} };
          const built = buildDealFromOverviewItem(
            pair.appId,
            pair.uuid,
            pItem,
            hEntry.low,
            hEntry.meta,
            pair.title,
          );

          if (built) {
            itadBulkPriceCache.set(`${pair.uuid}:${normalizedCurrency}`, {
              items: [pItem],
              historyLow: built.allTimeLowPrice ?? null,
              historyLowMeta: hEntry.meta,
              expiresAt: writeNowMs + ITAD_BULK_PRICE_CACHE_TTL_MS,
            });
            results.set(pair.appId, built);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ITAD Bulk] Batch resolution error:', msg);
    }
    return 'BATCH_DONE';
  };

  try {
    await Promise.race([executeBatch(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  return results;
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
