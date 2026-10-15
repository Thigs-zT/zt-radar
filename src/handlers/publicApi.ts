/**
 * zT Radar — Public Web & PWA Companion API Handler
 *
 * Exposes lightweight, read-only public endpoints for Web and PWA companions:
 * - GET /public/market: Retrieves curated market game telemetry with live deal intelligence.
 * - GET /public/market/trending: Retrieves trending game telemetry on Steam (excluding Free-to-Play).
 * - GET /public/market/{appId}: Retrieves market telemetry and multi-store deal intelligence for a specific game.
 * - GET /public/duel/{duelId}: Retrieves historical library duel comparison payload from DynamoDB.
 * - GET /public/wishlist/{target}: Retrieves public Steam wishlist telemetry with live pricing and store attribution.
 * - GET /public/backlog/{target}: Retrieves public Backlog Vault telemetry with playtime metrics and live store valuation.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type {
  PublicMarketTelemetry,
  SteamTrendingEntry,
  StoreDeal,
  PublicWishlistItem,
  PublicWishlistResponse,
  PublicBacklogItem,
  BacklogTelemetrySummary,
  SteamAppPriceInfo,
  GameDealInfo,
} from '../types/index.js';
import { getHowLongToBeatStats } from '../utils/hltbNative.js';
import { getGameDealInfo } from '../utils/itadApi.js';
import { getSteamTrendingGames } from '../utils/platformStatus.js';
import {
  resolveSteamId,
  fetchSteamWishlist,
  batchFetchSteamAppPrices,
  resolveSteamAppTitles,
  getPlayerLibraryDetailed,
  batchResolveAuthenticArtwork,
  resolveAuthenticArtwork,
  getCanonicalHeaderImageUrl,
  APP_DIRECTORY,
} from '../utils/steamWeb.js';

const ddbClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(ddbClient);

export const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'X-Content-Type-Options': 'nosniff',
};

export interface PublicApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpApiEvent {
  version?: string;
  routeKey?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
    stage?: string;
    time?: string;
    timeEpoch?: number;
    [key: string]: unknown;
  };
  body?: string;
  isBase64Encoded?: boolean;
}

/** Known game titles dictionary for reliable fallback identification. */
export const KNOWN_GAME_TITLES: Record<string, string> = {
  '1091500': 'Cyberpunk 2077',
  '1086940': "Baldur's Gate 3",
  '1245620': 'ELDEN RING',
  '292030': 'The Witcher 3: Wild Hunt',
  '1172470': 'Apex Legends',
  '1145360': 'Hades',
  '730': 'Counter-Strike 2',
  '271590': 'Grand Theft Auto V',
  '252490': 'Rust',
};

/** Prominent monitored games for curated market listings. */
export const CURATED_MARKET_APP_IDS: string[] = ['1091500', '1086940', '1245620', '292030'];

/** Institutional Free-to-Play titles to exclude from trending deals. */
export const KNOWN_F2P_APP_IDS = new Set<number>([730, 570, 440, 1172470, 230410, 578080]);

/** Known Valve hardware and physical peripheral Steam AppIDs to exclude from game charts. */
export const KNOWN_HARDWARE_APP_IDS = new Set<number>([
  1675200, // Steam Deck
  2133010, // Steam Deck Docking Station
  1059530, // Valve Index VR Kit
  1059550, // Valve Index Headset
  1059570, // Valve Index Controllers
  1059540, // Valve Index Base Station
  353370,  // Steam Controller
  353380,  // Steam Link
]);

/** Hardware and physical peripheral name patterns to exclude from trending game charts. */
export const HARDWARE_NAME_PATTERNS: RegExp[] = [
  /\bsteam deck\b/i,
  /\bsteam frame\b/i,
  /\bsteam machine\b/i,
  /\bvalve index\b/i,
  /\bsteam controller\b/i,
  /\bsteam link\b/i,
  /\bcontroller\b/i,
  /\bheadset\b/i,
  /\bdocking station\b/i,
  /\bbase station\b/i,
  /\bvr kit\b/i,
];

/**
 * Constructs a standardized HTTP API Gateway response with security and CORS headers.
 */
export function createJsonResponse<T>(statusCode: number, data: T): PublicApiResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data),
  };
}

/**
 * Builds fallback structured market telemetry matching canonical domain contracts.
 */
export function buildMarketTelemetryPlaceholder(
  appId: string,
  preferredCurrency: string = 'USD',
): PublicMarketTelemetry {
  const cleanAppId = appId.trim();
  const storeUrl = `https://store.steampowered.com/app/${cleanAppId}`;
  const bannerUrl = getCanonicalHeaderImageUrl(cleanAppId);
  const title = KNOWN_GAME_TITLES[cleanAppId] || `Steam Application ${cleanAppId}`;

  const isBrl = preferredCurrency.toUpperCase() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const currencySymbol = isBrl ? 'R$' : '$';
  const regularPrice = isBrl ? 149.99 : 29.99;
  const salePrice = isBrl ? 74.99 : 19.99;
  const cutPercent = isBrl ? 50 : 33;

  const defaultDeal: StoreDeal = {
    shopName: 'Steam',
    salePrice,
    regularPrice,
    cutPercent,
    url: storeUrl,
    expiry: null,
    currency,
    currencySymbol,
  };

  return {
    appId: cleanAppId,
    gameId: `steam_${cleanAppId}`,
    title,
    imageUrl: bannerUrl,
    reviewScore: 80,
    steamAppId: cleanAppId,
    dealType: 'CURATED_DEAL',
    isAllTimeLow: false,
    allTimeLowPrice: salePrice,
    expiry: null,
    primaryDeal: defaultDeal,
    cheaperAlternative: null,
    storeBreakdown: {
      Steam: defaultDeal,
    },
    alternativeCheckStatus: 'confirmed',
    alternativeCheckDegraded: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Resolves live market telemetry and multi-store deal intelligence for a specific Steam title.
 * Gracefully falls back to clean default telemetry on timeout or API unavailability.
 */
export async function resolveMarketTelemetry(
  appId: string,
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<PublicMarketTelemetry> {
  const cleanAppId = appId.trim();
  const isBrl = preferredCurrency.toUpperCase() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';

  try {
    const dealInfo = await getGameDealInfo(cleanAppId, currency);
    if (dealInfo && dealInfo.primaryDeal) {
      const resolvedTitle =
        dealInfo.title && dealInfo.title !== 'Monitored Title'
          ? dealInfo.title
          : KNOWN_GAME_TITLES[cleanAppId] || `Steam Application ${cleanAppId}`;

      const primaryDeal = dealInfo.primaryDeal;
      const storeBreakdown =
        dealInfo.storeBreakdown && Object.keys(dealInfo.storeBreakdown).length > 0
          ? dealInfo.storeBreakdown
          : { [primaryDeal.shopName]: primaryDeal };

      const authenticImageUrl = await resolveAuthenticArtwork(cleanAppId, {
        ddbDocClient,
        tableName,
        fetchedHeader: dealInfo.imageUrl,
      });

      return {
        ...dealInfo,
        appId: cleanAppId,
        gameId: dealInfo.gameId || `steam_${cleanAppId}`,
        title: resolvedTitle,
        imageUrl: authenticImageUrl,
        steamAppId: cleanAppId,
        primaryDeal,
        cheaperAlternative: dealInfo.cheaperAlternative || null,
        storeBreakdown,
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (error) {
    console.error(
      `Error resolving market telemetry for appId ${cleanAppId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return buildMarketTelemetryPlaceholder(cleanAppId, currency);
}

/**
 * Builds a curated list of fallback market games matching canonical domain contracts.
 */
export function buildCuratedMarketList(preferredCurrency: string = 'USD'): PublicMarketTelemetry[] {
  return CURATED_MARKET_APP_IDS.map((id) => buildMarketTelemetryPlaceholder(id, preferredCurrency));
}

/**
 * Resolves live market telemetry for curated prominent games in parallel.
 * Defensive design: handles individual failures gracefully via Promise.allSettled.
 */
export async function resolveCuratedMarketList(
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<PublicMarketTelemetry[]> {
  const settled = await Promise.allSettled(
    CURATED_MARKET_APP_IDS.map((appId) => resolveMarketTelemetry(appId, preferredCurrency, ddbDocClient, tableName)),
  );

  return settled.map((result, idx) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const fallbackId = CURATED_MARKET_APP_IDS[idx];
    return buildMarketTelemetryPlaceholder(fallbackId, preferredCurrency);
  });
}

/**
 * Builds structured fallback trending games telemetry excluding Free-to-Play titles.
 */
export function buildTrendingGamesList(): SteamTrendingEntry[] {
  return [
    {
      rank: 1,
      appId: 1091500,
      name: 'Cyberpunk 2077',
      currentPlayers: 54000,
      priceText: '$ 29.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
    },
    {
      rank: 2,
      appId: 1086940,
      name: "Baldur's Gate 3",
      currentPlayers: 82000,
      priceText: '$ 47.99 (-20%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
    },
    {
      rank: 3,
      appId: 1245620,
      name: 'ELDEN RING',
      currentPlayers: 67000,
      priceText: '$ 35.99 (-40%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
    },
    {
      rank: 4,
      appId: 292030,
      name: 'The Witcher 3: Wild Hunt',
      currentPlayers: 31000,
      priceText: '$ 9.99 (-75%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/292030/header.jpg',
    },
    {
      rank: 5,
      appId: 582010,
      name: 'MONSTER HUNTER: WORLD',
      currentPlayers: 28000,
      priceText: '$ 14.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/582010/header.jpg',
    },
    {
      rank: 6,
      appId: 1174180,
      name: 'Red Dead Redemption 2',
      currentPlayers: 39000,
      priceText: '$ 19.79 (-67%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg',
    },
    {
      rank: 7,
      appId: 990080,
      name: 'Hogwarts Legacy',
      currentPlayers: 21000,
      priceText: '$ 29.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/990080/header.jpg',
    },
    {
      rank: 8,
      appId: 2358720,
      name: 'Black Myth: Wukong',
      currentPlayers: 65000,
      priceText: '$ 59.99',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2358720/header.jpg',
    },
  ];
}

/**
 * Resolves trending games on Steam:
 * - Collects raw candidates from top sellers & specials (up to 50 items).
 * - Filters out Free-to-Play titles and non-discounted promotional labels.
 * - Filters out Valve hardware and physical peripherals (Steam Deck, Valve Index, Controller, etc.).
 * - Deduplicates items by appId so identical games never appear more than once.
 * - Backfills from curated commercial games if needed to guarantee between 6 and 8 entries.
 * - Re-indexes sequential ranks (1, 2, 3...) after filtering.
 * - Gracefully falls back to curated trending games on timeout or upstream failure.
 */
export async function resolveTrendingGames(): Promise<SteamTrendingEntry[]> {
  try {
    const rawTrending = await Promise.race([
      getSteamTrendingGames(50),
      new Promise<SteamTrendingEntry[]>((resolve) => setTimeout(() => resolve([]), 4000)),
    ]);

    const seenAppIds = new Set<number>();
    const filtered: SteamTrendingEntry[] = [];

    for (const game of rawTrending || []) {
      // 1. Deduplicate by appId
      if (!game.appId || seenAppIds.has(game.appId)) {
        continue;
      }

      // 2. Filter out institutional Free-to-Play titles
      if (KNOWN_F2P_APP_IDS.has(game.appId)) {
        continue;
      }

      // 3. Filter out Free to Play price text
      const priceLower = (game.priceText || '').toLowerCase();
      if (priceLower.includes('free')) {
        continue;
      }

      // 4. Filter out known hardware AppIDs
      if (KNOWN_HARDWARE_APP_IDS.has(game.appId)) {
        continue;
      }

      // 5. Filter out hardware and physical peripheral titles
      const name = game.name || '';
      if (HARDWARE_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
        continue;
      }

      seenAppIds.add(game.appId);
      filtered.push({
        ...game,
        rank: filtered.length + 1,
      });

      if (filtered.length >= 8) {
        break;
      }
    }

    // Backfill from curated commercial games if filtered count is less than 6
    if (filtered.length < 6) {
      const fallbackGames = buildTrendingGamesList();
      for (const fallback of fallbackGames) {
        if (!seenAppIds.has(fallback.appId)) {
          seenAppIds.add(fallback.appId);
          filtered.push({
            ...fallback,
            rank: filtered.length + 1,
          });
          if (filtered.length >= 8) {
            break;
          }
        }
      }
    }

    if (filtered.length > 0) {
      return filtered.slice(0, 8).map((game, idx) => ({
        ...game,
        rank: idx + 1,
      }));
    }
  } catch (error) {
    console.error(
      'Error fetching trending games, falling back to curated list:',
      error instanceof Error ? error.message : String(error),
    );
  }

  return buildTrendingGamesList().slice(0, 8);
}


export type WishlistTelemetryResult =
  | { success: true; data: PublicWishlistResponse }
  | { success: false; statusCode: number; error: string; message: string };

export interface WishlistPaginationOptions {
  page?: number;
  limit?: number;
  ddbDocClient?: DynamoDBDocumentClient;
  tableName?: string;
}

/**
 * Resolves public Steam wishlist telemetry for a user:
 * - Accepts SteamID64, vanity username, or full profile URL.
 * - Resolves target into SteamID64.
 * - Fetches user's wishlist games sorted by date_added descending.
 * - Enriches items with pricing, active discount %, and store attribution.
 * - Enforces defensive limits to stay well within Lambda execution constraints.
 */
export async function resolveWishlistTelemetry(
  target: string,
  preferredCurrency: string = 'USD',
  paginationOrDocClient?: WishlistPaginationOptions | DynamoDBDocumentClient,
  docClientOrTableName?: DynamoDBDocumentClient | string,
  maybeTableName?: string,
): Promise<WishlistTelemetryResult> {
  const cleanTarget = target.trim();
  if (!cleanTarget) {
    return {
      success: false,
      statusCode: 400,
      error: 'BadRequest',
      message: 'Missing or invalid target parameter.',
    };
  }

  let page = 1;
  let limit = 100;
  let ddbDocClient: DynamoDBDocumentClient = docClient;
  let tableName: string = process.env.TABLE_NAME || '';

  if (paginationOrDocClient) {
    if (typeof paginationOrDocClient === 'object' && 'send' in paginationOrDocClient) {
      ddbDocClient = paginationOrDocClient as DynamoDBDocumentClient;
      if (typeof docClientOrTableName === 'string') {
        tableName = docClientOrTableName;
      }
    } else {
      const opts = paginationOrDocClient as WishlistPaginationOptions;
      if (opts.page !== undefined) page = Math.max(1, Math.floor(opts.page));
      if (opts.limit !== undefined) limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
      if (opts.ddbDocClient) ddbDocClient = opts.ddbDocClient;
      if (opts.tableName) tableName = opts.tableName;

      if (typeof docClientOrTableName === 'object' && docClientOrTableName && 'send' in docClientOrTableName) {
        ddbDocClient = docClientOrTableName as DynamoDBDocumentClient;
      }
      if (typeof maybeTableName === 'string') {
        tableName = maybeTableName;
      }
    }
  }

  const steamApiKey = process.env.STEAM_API_KEY || '';
  const steamId = await resolveSteamId(cleanTarget, steamApiKey);
  if (!steamId) {
    return {
      success: false,
      statusCode: 404,
      error: 'NotFound',
      message: `Unable to resolve Steam profile for '${cleanTarget}'.`,
    };
  }

  const wishlistResult = await fetchSteamWishlist(steamId, steamApiKey);
  if (!wishlistResult.success) {
    if (wishlistResult.error === 'PRIVATE_OR_NOT_FOUND') {
      return {
        success: false,
        statusCode: 403,
        error: 'WishlistPrivate',
        message: 'This Steam profile is private or does not exist.',
      };
    }
    if (wishlistResult.error === 'CONFIG_REQUIRED') {
      return {
        success: false,
        statusCode: 500,
        error: 'ConfigurationError',
        message: 'Steam API configuration is missing.',
      };
    }
    if (wishlistResult.error === 'INVALID_ID') {
      return {
        success: false,
        statusCode: 400,
        error: 'BadRequest',
        message: 'Invalid SteamID provided.',
      };
    }
    return {
      success: false,
      statusCode: 502,
      error: 'UpstreamError',
      message: 'Failed to communicate with Steam servers.',
    };
  }

  const rawItems = wishlistResult.items || [];
  const totalSteamWishlist = rawItems.length;

  const isBrl = preferredCurrency.toUpperCase() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const currencySymbol = isBrl ? 'R$' : '$';
  const countryCode = isBrl ? 'br' : 'us';

  const totalPages = Math.max(1, Math.ceil(totalSteamWishlist / limit));

  if (totalSteamWishlist === 0) {
    return {
      success: true,
      data: {
        steamId,
        totalSteamWishlist: 0,
        page,
        limit,
        totalPages: 1,
        currency,
        items: [],
      },
    };
  }

  // Preserve the exact priority integer from Valve's IWishlistService without distortion
  // Sort items by dateAdded descending
  const sortedItems = [...rawItems].sort((a, b) => b.dateAdded - a.dateAdded);
  
  // Support full-collection pagination parameters (page, limit)
  const startIndex = (page - 1) * limit;
  const targetItems = sortedItems.slice(startIndex, startIndex + limit);
  const targetAppIds = targetItems.map((item) => item.appId);

  // Fetch prices in batch and resolve known titles concurrently
  const [priceMap, titleMap] = await Promise.all([
    batchFetchSteamAppPrices(targetAppIds, countryCode, limit),
    resolveSteamAppTitles(targetAppIds, 1200),
  ]);

  // Enrich candidates: top items on current page (up to 12) + any unpriced items from batch store query
  const topCandidates = targetItems.slice(0, 12);
  const unpricedCandidates = targetItems.filter((candidate) => {
    const p = priceMap.get(Number(candidate.appId));
    return !p || p.salePrice === null || p.isUnreleased;
  }).slice(0, 15);

  const candidateMap = new Map<string, (typeof targetItems)[0]>();
  for (const item of [...topCandidates, ...unpricedCandidates]) {
    candidateMap.set(item.appId, item);
  }
  const enrichmentCandidates = Array.from(candidateMap.values());
  const dealMap = new Map<string, GameDealInfo>();
  try {
    const dealSettled = await Promise.allSettled(
      enrichmentCandidates.map(async (candidate) => {
        const deal = await getGameDealInfo(candidate.appId, currency);
        return { appId: candidate.appId, deal };
      }),
    );
    for (const res of dealSettled) {
      if (res.status === 'fulfilled' && res.value.deal) {
        dealMap.set(res.value.appId, res.value.deal);
      }
    }
  } catch {
    // Graceful fallback to batch cache if ITAD enrichment encounters issues
  }

  // Collect authentic headers from store price overview and deal intelligence
  const fetchedHeaders = new Map<string, string>();
  for (const [id, info] of priceMap.entries()) {
    if (info.headerImage) {
      fetchedHeaders.set(String(id), info.headerImage);
    }
  }
  for (const [id, deal] of dealMap.entries()) {
    if (deal.imageUrl) {
      fetchedHeaders.set(String(id), deal.imageUrl);
    }
  }

  // Resolve authentic artwork URLs with DynamoDB cache (30-day TTL) and canonical fallback
  const artworkMap = await batchResolveAuthenticArtwork(targetAppIds, {
    ddbDocClient,
    tableName,
    fetchedHeaders,
  });

  const items: PublicWishlistItem[] = targetItems.map((item) => {
    const appId = item.appId;
    const priceInfo = priceMap.get(Number(appId));
    const dealInfo = dealMap.get(appId);

    const resolvedTitle =
      (dealInfo?.title && dealInfo.title !== 'Monitored Title' ? dealInfo.title : null) ||
      APP_DIRECTORY[appId] ||
      KNOWN_GAME_TITLES[appId] ||
      titleMap.get(appId) ||
      titleMap.get(Number(appId)) ||
      `Steam App #${appId}`;

    let isFree = false;
    let isUnreleased = false;
    let regularPrice: number | null = null;
    let salePrice: number | null = null;
    let discountPercent = 0;
    let primaryDeal: StoreDeal | null = null;
    let cheaperAlternative: StoreDeal | null = null;
    let storeBreakdown: Record<string, StoreDeal> | undefined = undefined;

    const hasValidDeal = Boolean(
      dealInfo?.primaryDeal &&
      (dealInfo.primaryDeal.salePrice > 0 || dealInfo.primaryDeal.regularPrice > 0)
    );
    const hasValidSteamPrice = Boolean(
      priceInfo &&
      !priceInfo.isUnreleased &&
      typeof priceInfo.salePrice === 'number' &&
      priceInfo.salePrice !== null &&
      priceInfo.salePrice > 0
    );
    const isTrulyFreeDeal = Boolean(
      dealInfo &&
      (dealInfo.dealType === 'FREE_TO_KEEP' || dealInfo.primaryDeal?.salePrice === 0)
    );
    const isTrulyFreeSteam = Boolean(priceInfo?.isFree);

    if (hasValidDeal) {
      // 1. Deal intelligence with authentic store pricing takes absolute precedence
      isFree = dealInfo!.primaryDeal.salePrice === 0 || dealInfo!.primaryDeal.cutPercent === 100;
      salePrice = dealInfo!.primaryDeal.salePrice;
      regularPrice = dealInfo!.primaryDeal.regularPrice;
      discountPercent = dealInfo!.primaryDeal.cutPercent;
      primaryDeal = dealInfo!.primaryDeal;
      cheaperAlternative = dealInfo!.cheaperAlternative || null;
      storeBreakdown = dealInfo!.storeBreakdown;
      isUnreleased = false;
    } else if (hasValidSteamPrice) {
      // 2. Confirmed Steam store pricing
      isFree = false;
      salePrice = priceInfo!.salePrice!;
      regularPrice = priceInfo!.regularPrice ?? priceInfo!.initial ?? salePrice;
      discountPercent = priceInfo!.discountPercent ?? 0;
      isUnreleased = false;
      const steamDeal: StoreDeal = {
        shopName: 'Steam',
        salePrice,
        regularPrice,
        cutPercent: discountPercent,
        url: `https://store.steampowered.com/app/${appId}`,
        expiry: null,
        currency,
        currencySymbol,
      };
      primaryDeal = steamDeal;
      storeBreakdown = { Steam: steamDeal };
    } else if (isTrulyFreeDeal) {
      // 3. Free to keep promotion or 100% free deal
      isFree = true;
      salePrice = 0;
      regularPrice = 0;
      discountPercent = 0;
      isUnreleased = false;
      primaryDeal = dealInfo!.primaryDeal || null;
      cheaperAlternative = dealInfo!.cheaperAlternative || null;
      storeBreakdown = dealInfo!.storeBreakdown;
    } else if (isTrulyFreeSteam) {
      // 4. Free-to-play title confirmed by Steam store
      isFree = true;
      salePrice = 0;
      regularPrice = 0;
      discountPercent = 0;
      isUnreleased = false;
    } else {
      // 5. Unannounced / unreleased / unpriced title (both dealInfo and priceInfo confirm no store pricing exists)
      isFree = false;
      isUnreleased = true;
      salePrice = null;
      regularPrice = null;
      discountPercent = 0;
      primaryDeal = null;
      cheaperAlternative = null;
      storeBreakdown = undefined;
    }

    const authenticImageUrl = artworkMap.get(appId) || getCanonicalHeaderImageUrl(appId);
    const authenticPriority =
      typeof item.priority === 'number'
        ? Math.floor(item.priority)
        : Number(item.priority ?? 0);

    return {
      appId,
      title: resolvedTitle,
      imageUrl: authenticImageUrl,
      url: `https://store.steampowered.com/app/${appId}`,
      store: 'Steam',
      priority: authenticPriority,
      dateAdded: item.dateAdded,
      salePrice,
      regularPrice,
      discountPercent,
      isFree,
      isUnreleased,
      currency,
      currencySymbol,
      primaryDeal,
      cheaperAlternative,
      storeBreakdown,
    };
  });

  return {
    success: true,
    data: {
      steamId,
      totalSteamWishlist,
      page,
      limit,
      totalPages,
      currency,
      items,
    },
  };
}

/**
 * Formats a numeric price into a localized currency string with canonical symbols.
 * BRL uses pt-BR formatting (e.g. R$ 4.520,50), USD uses en-US formatting (e.g. $ 4,520.50).
 */
export function formatCurrency(value: number, currency: string = 'USD'): string {
  const isBrl = currency.toUpperCase() === 'BRL';
  const sym = isBrl ? 'R$' : '$';
  const locale = isBrl ? 'pt-BR' : 'en-US';
  const formatted = Number(value || 0).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sym} ${formatted}`;
}

export type BacklogTelemetryApiResult =
  | { success: true; data: BacklogTelemetrySummary }
  | { success: false; statusCode: number; error: string; message: string };

/**
 * Resolves public Steam Backlog Vault telemetry for a user:
 * - Accepts SteamID64, vanity username, or full profile URL.
 * - Resolves target into SteamID64.
 * - Queries user's owned games library using IPlayerService/GetOwnedGames/v1.
 * - Filters unplayed titles (playtime_forever === 0) and non-F2P.
 * - Computes total backlog MSRP valuation and HLTB completion hours without synthetic conversion.
 * - Supports dual-currency (BRL/USD).
 */
export async function resolveBacklogTelemetry(
  target: string,
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<BacklogTelemetryApiResult> {
  const cleanTarget = (target || '').trim();
  if (!cleanTarget) {
    return {
      success: false,
      statusCode: 400,
      error: 'BadRequest',
      message: 'Missing or invalid target parameter.',
    };
  }

  const steamApiKey = process.env.STEAM_API_KEY || '';
  const steamId = await resolveSteamId(cleanTarget, steamApiKey);
  if (!steamId) {
    return {
      success: false,
      statusCode: 404,
      error: 'NotFound',
      message: `Unable to resolve Steam profile for '${cleanTarget}'.`,
    };
  }

  const library = await getPlayerLibraryDetailed(steamId, steamApiKey);
  if (!library) {
    return {
      success: false,
      statusCode: 502,
      error: 'UpstreamError',
      message: 'Failed to communicate with Steam servers.',
    };
  }

  if (library.isPrivate) {
    return {
      success: false,
      statusCode: 403,
      error: 'LibraryPrivate',
      message: 'This Steam library is private or does not exist.',
    };
  }

  let displayTarget = cleanTarget;
  const vanityMatch = cleanTarget.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (vanityMatch) {
    displayTarget = vanityMatch[1];
  } else {
    const profileMatch = cleanTarget.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    if (profileMatch) {
      displayTarget = profileMatch[1];
    }
  }

  const allGames = library.games || [];
  const totalGamesOwned = library.gameCount || allGames.length;

  // Filter paid games (excluding known institutional F2P games)
  const paidGames = allGames.filter((g) => {
    if (!g) return false;
    const appId = Number(g.appid ?? 0);
    if (KNOWN_F2P_APP_IDS.has(appId)) return false;
    if (g.is_free || g.is_free_to_play) return false;
    return true;
  });

  // Filter unplayed titles (playtime_forever === 0)
  const unplayedGames = paidGames.filter((g) => (g.playtime_forever ?? 0) === 0);
  const unplayedCount = unplayedGames.length;
  const unplayedRatioPercent =
    totalGamesOwned > 0 ? Number(((unplayedCount / totalGamesOwned) * 100).toFixed(1)) : 0;

  const isBrl = preferredCurrency.toUpperCase() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const currencySymbol = isBrl ? 'R$' : '$';
  const countryCode = isBrl ? 'br' : 'us';

  if (unplayedCount === 0) {
    return {
      success: true,
      data: {
        steamId,
        target: displayTarget,
        currency,
        currencySymbol,
        totalGamesOwned,
        unplayedCount: 0,
        unplayedRatioPercent: 0,
        estimatedHoursToClear: 0,
        totalBacklogValue: 0,
        totalBacklogValueFormatted: formatCurrency(0, currency),
        unplayedItems: [],
      },
    };
  }

  // Cap items to enrich at 100 to prevent Lambda timeouts
  const targetGames = unplayedGames.slice(0, 100);
  const targetAppIds = targetGames.map((g) => g.appid);

  let priceMap = new Map<number, SteamAppPriceInfo>();
  try {
    priceMap = await batchFetchSteamAppPrices(targetAppIds, countryCode, 100);
  } catch {
    // Graceful fallback on price fetch failure
  }

  // Collect authentic headers from store price overview
  const fetchedHeaders = new Map<string, string>();
  for (const [id, info] of priceMap.entries()) {
    if (info.headerImage) {
      fetchedHeaders.set(String(id), info.headerImage);
    }
  }

  // Resolve authentic artwork URLs with DynamoDB cache (30-day TTL) and canonical fallback
  const artworkMap = await batchResolveAuthenticArtwork(targetAppIds, {
    ddbDocClient,
    tableName,
    fetchedHeaders,
  });

  // Query HLTB stats concurrently for top 8 unplayed titles
  const hltbCandidates = targetGames.slice(0, 8);
  const hltbMap = new Map<number, number>();
  try {
    const hltbSettled = await Promise.allSettled(
      hltbCandidates.map(async (g) => {
        const name = g.name || APP_DIRECTORY[g.appid] || KNOWN_GAME_TITLES[g.appid];
        if (!name) return { appId: g.appid, hours: null };
        const stats = await getHowLongToBeatStats(name, 1200);
        const hours = stats.success ? stats.mainStoryHours || stats.allPlayStylesHours || null : null;
        return { appId: g.appid, hours };
      }),
    );
    for (const res of hltbSettled) {
      if (res.status === 'fulfilled' && res.value.hours) {
        hltbMap.set(res.value.appId, res.value.hours);
      }
    }
  } catch {
    // Non-blocking fallback
  }

  const DEFAULT_MEDIAN_HOURS = 14.5;
  let totalBacklogValue = 0;
  let totalHours = 0;

  const unplayedItems: PublicBacklogItem[] = targetGames.map((g) => {
    const appId = g.appid;
    const resolvedName =
      g.name && !g.name.startsWith('App #')
        ? g.name
        : APP_DIRECTORY[appId] || KNOWN_GAME_TITLES[appId] || g.name || `Steam App #${appId}`;

    const priceInfo = priceMap.get(appId);
    let price: number | null = null;
    let priceFormatted = 'Unpriced';

    if (priceInfo) {
      if (priceInfo.isFree) {
        price = 0;
        priceFormatted = 'Free / Included';
      } else if (priceInfo.isDelisted) {
        price = null;
        priceFormatted = 'Delisted / Legacy';
      } else {
        const rawPrice = priceInfo.final ?? priceInfo.initial ?? null;
        if (rawPrice !== null && rawPrice > 0) {
          price = rawPrice;
          totalBacklogValue += rawPrice;
          priceFormatted = formatCurrency(rawPrice, currency);
        }
      }
    }

    const hours = hltbMap.get(appId) ?? null;
    totalHours += hours ?? DEFAULT_MEDIAN_HOURS;

    const iconUrl = g.img_icon_url
      ? `http://media.steampowered.com/steamcommunity/public/images/apps/${appId}/${g.img_icon_url}.jpg`
      : null;

    const authenticImageUrl =
      artworkMap.get(String(appId)) || getCanonicalHeaderImageUrl(appId);

    return {
      appId,
      name: resolvedName,
      title: resolvedName,
      playtimeMinutes: g.playtime_forever ?? 0,
      playtimeForever: g.playtime_forever ?? 0,
      imageUrl: authenticImageUrl,
      iconUrl,
      url: `https://store.steampowered.com/app/${appId}`,
      price,
      priceFormatted,
      estimatedHours: hours,
    };
  });

  // For any remaining unplayed games beyond the first 100:
  if (unplayedCount > targetGames.length) {
    totalHours += (unplayedCount - targetGames.length) * DEFAULT_MEDIAN_HOURS;
  }

  const roundedBacklogValue = Number(totalBacklogValue.toFixed(2));
  const estimatedHoursToClear = Math.round(totalHours);

  return {
    success: true,
    data: {
      steamId,
      target: displayTarget,
      currency,
      currencySymbol,
      totalGamesOwned,
      unplayedCount,
      unplayedRatioPercent,
      estimatedHoursToClear,
      totalBacklogValue: roundedBacklogValue,
      totalBacklogValueFormatted: formatCurrency(roundedBacklogValue, currency),
      unplayedItems,
    },
  };
}

/**
 * Main Lambda handler for the Public Web API companion endpoints.
 */
export const handler = async (event: HttpApiEvent): Promise<PublicApiResponse> => {
  const httpMethod = (event.requestContext?.http?.method || '').toUpperCase();
  const rawPath = event.rawPath || event.requestContext?.http?.path || '';
  const tableName = process.env.TABLE_NAME || '';

  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  if (httpMethod !== 'GET') {
    return createJsonResponse(405, {
      error: 'MethodNotAllowed',
      message: `HTTP method ${httpMethod} is not permitted on this endpoint.`,
    });
  }

  try {
    // Route 1: GET /public/market/trending
    const isTrendingRoute =
      event.routeKey === 'GET /public/market/trending' ||
      rawPath.endsWith('/public/market/trending') ||
      rawPath.endsWith('/public/market/trending/');

    if (isTrendingRoute) {
      const trending = await resolveTrendingGames();
      return createJsonResponse(200, trending);
    }

    // Route 2: GET /public/market/{appId}
    const isExplicitSingleRoute = event.routeKey === 'GET /public/market/{appId}';
    const hasAppIdParam = Boolean(event.pathParameters && 'appId' in event.pathParameters);
    const hasMarketSubpath =
      rawPath.includes('/public/market/') &&
      Boolean(rawPath.split('/public/market/')[1]?.split('/')[0]?.trim());

    if (isExplicitSingleRoute || hasAppIdParam || hasMarketSubpath) {
      let appId = event.pathParameters?.appId;
      if (!appId && rawPath.includes('/public/market/')) {
        const parts = rawPath.split('/public/market/');
        appId = parts[1]?.split('/')[0];
      }

      if (!appId || appId.trim() === '') {
        return createJsonResponse(400, {
          error: 'BadRequest',
          message: 'Missing or invalid appId path parameter.',
        });
      }

      const currencyParam = event.queryStringParameters?.currency;
      const preferredCurrency = (currencyParam || 'USD').toUpperCase() === 'BRL' ? 'BRL' : 'USD';
      const telemetry = await resolveMarketTelemetry(appId, preferredCurrency);
      return createJsonResponse(200, telemetry);
    }

    // Route 3: GET /public/market
    const isMarketListRoute =
      event.routeKey === 'GET /public/market' ||
      rawPath === '/public/market' ||
      rawPath === '/public/market/' ||
      rawPath.endsWith('/prod/public/market') ||
      rawPath.endsWith('/prod/public/market/');

    if (isMarketListRoute) {
      const currencyParam = event.queryStringParameters?.currency;
      const preferredCurrency = (currencyParam || 'USD').toUpperCase() === 'BRL' ? 'BRL' : 'USD';
      const queryAppId = event.queryStringParameters?.appId;

      if (queryAppId && queryAppId.trim()) {
        const item = await resolveMarketTelemetry(queryAppId.trim(), preferredCurrency);
        return createJsonResponse(200, [item]);
      }

      const curatedList = await resolveCuratedMarketList(preferredCurrency);
      return createJsonResponse(200, curatedList);
    }

    // Route 4: GET /public/duel/{duelId}
    const isDuelRoute =
      event.routeKey === 'GET /public/duel/{duelId}' ||
      rawPath.includes('/public/duel/') ||
      Boolean(event.pathParameters?.duelId);

    if (isDuelRoute) {
      let duelId = event.pathParameters?.duelId;
      if (!duelId && rawPath.includes('/public/duel/')) {
        const parts = rawPath.split('/public/duel/');
        duelId = parts[1]?.split('/')[0];
      }

      if (!duelId || duelId.trim() === '') {
        return createJsonResponse(400, {
          error: 'BadRequest',
          message: 'Missing or invalid duelId path parameter.',
        });
      }

      const cleanDuelId = duelId.trim();

      if (!tableName) {
        console.error('DynamoDB TABLE_NAME environment variable is not defined.');
        return createJsonResponse(500, {
          error: 'ConfigurationError',
          message: 'Database table configuration is missing.',
        });
      }

      const queryResult = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: {
            ':pk': `DUEL#${cleanDuelId}`,
          },
          Limit: 1,
        }),
      );

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createJsonResponse(404, {
          error: 'NotFound',
          message: `Duel payload for identifier '${cleanDuelId}' was not found.`,
        });
      }

      const duelRecord = queryResult.Items[0];
      const payload = duelRecord.payload ?? duelRecord;
      return createJsonResponse(200, payload);
    }

    // Route 5: GET /public/wishlist/{target}
    const isWishlistBaseRoute =
      rawPath === '/public/wishlist' ||
      rawPath === '/public/wishlist/' ||
      rawPath.endsWith('/prod/public/wishlist') ||
      rawPath.endsWith('/prod/public/wishlist/');

    if (isWishlistBaseRoute && (!event.pathParameters || !event.pathParameters.target)) {
      return createJsonResponse(400, {
        error: 'BadRequest',
        message: 'Missing or invalid target parameter.',
      });
    }

    const isExplicitWishlistRoute = event.routeKey === 'GET /public/wishlist/{target}';
    const hasWishlistSubpath =
      rawPath.includes('/public/wishlist/') &&
      Boolean(rawPath.split('/public/wishlist/')[1]?.split('?')[0]?.trim());
    const hasWishlistTargetParam =
      Boolean(event.pathParameters && 'target' in event.pathParameters) &&
      (rawPath.includes('/public/wishlist') || isExplicitWishlistRoute);

    if (isExplicitWishlistRoute || hasWishlistTargetParam || hasWishlistSubpath) {
      let target = event.pathParameters?.target;
      if (!target && rawPath.includes('/public/wishlist/')) {
        const parts = rawPath.split('/public/wishlist/');
        target = parts[1]?.split('?')[0];
      }

      if (!target || target.trim() === '') {
        return createJsonResponse(400, {
          error: 'BadRequest',
          message: 'Missing or invalid target parameter.',
        });
      }

      let cleanTarget = target.trim();
      try {
        cleanTarget = decodeURIComponent(cleanTarget).trim();
      } catch {
        // Fallback to raw target
      }

      const currencyParam = event.queryStringParameters?.currency;
      const preferredCurrency = (currencyParam || 'USD').toUpperCase() === 'BRL' ? 'BRL' : 'USD';
      const pageParam = event.queryStringParameters?.page;
      const limitParam = event.queryStringParameters?.limit;
      const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
      const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || 100)) : 100;

      const result = await resolveWishlistTelemetry(cleanTarget, preferredCurrency, { page, limit });
      if (!result.success) {
        return createJsonResponse(result.statusCode, {
          error: result.error,
          message: result.message,
        });
      }

      return createJsonResponse(200, result.data);
    }

    // Route 6: GET /public/backlog/{target}
    const isBacklogBaseRoute =
      rawPath === '/public/backlog' ||
      rawPath === '/public/backlog/' ||
      rawPath.endsWith('/prod/public/backlog') ||
      rawPath.endsWith('/prod/public/backlog/');

    if (isBacklogBaseRoute && (!event.pathParameters || !event.pathParameters.target)) {
      return createJsonResponse(400, {
        error: 'BadRequest',
        message: 'Missing or invalid target parameter.',
      });
    }

    const isExplicitBacklogRoute = event.routeKey === 'GET /public/backlog/{target}';
    const hasBacklogSubpath =
      rawPath.includes('/public/backlog/') &&
      Boolean(rawPath.split('/public/backlog/')[1]?.split('?')[0]?.trim());
    const hasBacklogTargetParam =
      Boolean(event.pathParameters && 'target' in event.pathParameters) &&
      (rawPath.includes('/public/backlog') || isExplicitBacklogRoute);

    if (isExplicitBacklogRoute || hasBacklogTargetParam || hasBacklogSubpath) {
      let target = event.pathParameters?.target;
      if (!target && rawPath.includes('/public/backlog/')) {
        const parts = rawPath.split('/public/backlog/');
        target = parts[1]?.split('?')[0];
      }

      if (!target || target.trim() === '') {
        return createJsonResponse(400, {
          error: 'BadRequest',
          message: 'Missing or invalid target parameter.',
        });
      }

      let cleanTarget = target.trim();
      try {
        cleanTarget = decodeURIComponent(cleanTarget).trim();
      } catch {
        // Fallback to raw target
      }

      const currencyParam = event.queryStringParameters?.currency;
      const preferredCurrency = (currencyParam || 'USD').toUpperCase() === 'BRL' ? 'BRL' : 'USD';
      const result = await resolveBacklogTelemetry(cleanTarget, preferredCurrency);
      if (!result.success) {
        return createJsonResponse(result.statusCode, {
          error: result.error,
          message: result.message,
        });
      }

      return createJsonResponse(200, result.data);
    }

    return createJsonResponse(404, {
      error: 'NotFound',
      message: `The requested endpoint '${rawPath}' was not found.`,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown internal error';
    console.error('Unhandled error in publicApi handler:', errorMessage);
    return createJsonResponse(500, {
      error: 'InternalServerError',
      message: 'An unexpected error occurred while processing the request.',
    });
  }
};
