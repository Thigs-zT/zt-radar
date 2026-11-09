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
 * - GET /public/dossier/{target}: Retrieves public Gamer Dossier telemetry with TimeStream and behavioral archetype.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type {
  PublicMarketTelemetry,
  SteamTrendingEntry,
  TrendingGameSummary,
  StoreDeal,
  PublicWishlistItem,
  PublicWishlistResponse,
  PublicBacklogItem,
  BacklogTelemetrySummary,
  SteamAppPriceInfo,
  GameDealInfo,
  DossierTopGame,
  DossierTimeStreamYear,
  DossierArchetype,
  DossierConstellationGame,
  DossierSummaryMetrics,
  PublicDossierResponse,
  DossierTelemetryApiResult,
  SteamOwnedGameItem,
  SteamOwnedGamesResult,
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
  getPlayerSummary,
  getOwnedGames,
  batchResolveAuthenticArtwork,
  resolveAuthenticArtwork,
  isAuthenticArtworkUrl,
  isGenericSteamTitle,
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
  '1449690': 'The Walking Dead: The Telltale Definitive Series',
  '3240220': 'Grand Theft Auto V Enhanced',
  '582010': 'MONSTER HUNTER: WORLD',
  '1174180': 'Red Dead Redemption 2',
  '990080': 'Hogwarts Legacy',
  '2358720': 'Black Myth: Wukong',
  '553850': 'HELLDIVERS 2',
  '1326470': 'Sons Of The Forest',
  '1551360': 'Forza Horizon 5',
  '2669320': 'EA SPORTS FC 25',
  '381210': 'Dead by Daylight',
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
 * Normalizes storefront display name to one of the 4 verified storefront slugs:
 * 'steam', 'nuuvem', 'epic', 'gog'.
 */
export function normalizeStoreSlug(shopName?: string | null): 'steam' | 'nuuvem' | 'epic' | 'gog' {
  const lower = (shopName || '').toLowerCase().trim();
  if (lower.includes('nuuvem')) return 'nuuvem';
  if (lower.includes('epic')) return 'epic';
  if (lower.includes('gog')) return 'gog';
  return 'steam';
}

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
  titleFallback: string | null = null,
): PublicMarketTelemetry {
  const cleanAppId = appId.trim();
  const storeUrl = `https://store.steampowered.com/app/${cleanAppId}`;
  const bannerUrl = getCanonicalHeaderImageUrl(cleanAppId);
  const title = titleFallback || KNOWN_GAME_TITLES[cleanAppId] || `Steam Application ${cleanAppId}`;

  const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const currencySymbol = isBrl ? 'R$' : '$';

  const defaultDeal: StoreDeal = {
    shopName: 'Steam',
    salePrice: null as unknown as number,
    regularPrice: null as unknown as number,
    cutPercent: 0,
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
    reviewScore: null,
    steamAppId: cleanAppId,
    dealType: 'CURATED_DEAL',
    isAllTimeLow: false,
    allTimeLowPrice: null,
    expiry: null,
    isUnreleased: true,
    salePrice: null,
    regularPrice: null,
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
 * Retrieves healthy multi-store market telemetry from DynamoDB cache if fresh and un-degraded.
 */
export async function getCachedMarketTelemetry(
  appId: string,
  currency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<PublicMarketTelemetry | null> {
  const cleanAppId = appId.trim();
  const nowSec = Math.floor(Date.now() / 1000);

  if (!tableName || !ddbDocClient) return null;

  try {
    const cacheResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `MARKET#v5#${cleanAppId}#${currency}`,
          ':sk': 'TELEMETRY',
        },
        Limit: 1,
      }),
    );

    if (cacheResult?.Items && Array.isArray(cacheResult.Items) && cacheResult.Items.length > 0) {
      const cached = cacheResult.Items[0] as PublicMarketTelemetry & { ttl?: number };
      const isFresh = !cached.ttl || cached.ttl > nowSec;
      const storeCount = Object.keys(cached.storeBreakdown || {}).length;
      const isHealthy =
        cached.alternativeCheckDegraded === false &&
        (storeCount > 1 || cached.isPlatformExclusive === true);

      if (isFresh && isHealthy) {
        return {
          appId: cached.appId || cleanAppId,
          gameId: cached.gameId || `steam_${cleanAppId}`,
          title: cached.title,
          imageUrl: cached.imageUrl,
          reviewScore: cached.reviewScore ?? null,
          steamAppId: cached.steamAppId || cleanAppId,
          dealType: cached.dealType || 'CURATED_DEAL',
          isAllTimeLow: Boolean(cached.isAllTimeLow),
          allTimeLowPrice: cached.allTimeLowPrice ?? null,
          expiry: cached.expiry ?? null,
          primaryDeal: cached.primaryDeal,
          cheaperAlternative: cached.cheaperAlternative ?? null,
          storeBreakdown: cached.storeBreakdown,
          alternativeCheckStatus: cached.alternativeCheckStatus || 'confirmed',
          alternativeCheckDegraded: false,
          isPlatformExclusive: cached.isPlatformExclusive,
          isUnreleased: cached.isUnreleased,
          salePrice: cached.salePrice ?? cached.primaryDeal?.salePrice ?? null,
          regularPrice: cached.regularPrice ?? cached.primaryDeal?.regularPrice ?? null,
          updatedAt: cached.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch (cacheErr) {
    console.warn(
      `[MarketCache] Cache lookup failed for ${cleanAppId}:`,
      cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
    );
  }
  return null;
}

/**
 * Resolves live market telemetry and multi-store deal intelligence for a specific Steam title.
 * Checks DynamoDB DealsTable (PK: MARKET#v5#${appId}#${currency}, SK: TELEMETRY) for cached un-degraded multi-store telemetry.
 * If cache miss or degraded, queries live intelligence and persists to cache for 2 hours (7200s) when healthy.
 * Gracefully falls back to clean default telemetry on timeout or API unavailability.
 */
export async function resolveMarketTelemetry(
  appId: string,
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
  titleFallback: string | null = null,
): Promise<PublicMarketTelemetry> {
  const cleanAppId = appId.trim();
  const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const nowSec = Math.floor(Date.now() / 1000);
  const effectiveTitleFallback = titleFallback || KNOWN_GAME_TITLES[cleanAppId] || null;

  // 1. Check DynamoDB Multi-Store Telemetry Cache
  const cached = await getCachedMarketTelemetry(cleanAppId, currency, ddbDocClient, tableName);
  if (cached) {
    return cached;
  }

  // 2. Fetch live data via getGameDealInfo
  try {
    const dealInfo = await getGameDealInfo(cleanAppId, currency, effectiveTitleFallback);
    if (dealInfo && dealInfo.primaryDeal) {
      const resolvedTitle =
        dealInfo.title && dealInfo.title !== 'Monitored Title'
          ? dealInfo.title
          : effectiveTitleFallback || `Steam Application ${cleanAppId}`;

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

      const telemetry: PublicMarketTelemetry = {
        ...dealInfo,
        appId: cleanAppId,
        gameId: dealInfo.gameId || `steam_${cleanAppId}`,
        title: resolvedTitle,
        imageUrl: authenticImageUrl,
        steamAppId: cleanAppId,
        primaryDeal,
        cheaperAlternative: dealInfo.cheaperAlternative || null,
        storeBreakdown,
        alternativeCheckStatus: dealInfo.alternativeCheckStatus || 'confirmed',
        alternativeCheckDegraded: dealInfo.alternativeCheckDegraded ?? false,
        isPlatformExclusive: dealInfo.isPlatformExclusive,
        isUnreleased: dealInfo.isUnreleased,
        salePrice: primaryDeal.salePrice,
        regularPrice: primaryDeal.regularPrice,
        updatedAt: new Date().toISOString(),
      };

      // 3. Cache only if healthy multi-store data or confirmed platform exclusive
      const storeCount = Object.keys(storeBreakdown).length;
      const isHealthy =
        telemetry.alternativeCheckDegraded === false &&
        (storeCount > 1 || telemetry.isPlatformExclusive === true);

      if (tableName && ddbDocClient && isHealthy) {
        try {
          await ddbDocClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `MARKET#v5#${cleanAppId}#${currency}`,
                SK: 'TELEMETRY',
                ...telemetry,
                ttl: nowSec + 7200, // 2 hours TTL
              },
            }),
          );
        } catch (putErr) {
          console.warn(
            `[MarketCache] Cache save failed for ${cleanAppId}:`,
            putErr instanceof Error ? putErr.message : String(putErr),
          );
        }
      }

      return telemetry;
    }
  } catch (error) {
    console.error(
      `Error resolving market telemetry for appId ${cleanAppId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return buildMarketTelemetryPlaceholder(cleanAppId, currency, effectiveTitleFallback);
}

/**
 * Builds a curated list of fallback market games matching canonical domain contracts.
 */
export function buildCuratedMarketList(preferredCurrency: string = 'USD'): PublicMarketTelemetry[] {
  return CURATED_MARKET_APP_IDS.map((id) => buildMarketTelemetryPlaceholder(id, preferredCurrency, KNOWN_GAME_TITLES[id] || null));
}

/**
 * Resolves live market telemetry for curated prominent games.
 * Checks DynamoDB cache in parallel for all curated games first.
 * For any cache misses, resolves sequentially (BATCH_SIZE = 1) with a 150ms pause
 * so Lambda never bursts Valve's appdetails API with concurrent requests.
 * Defensive design: handles individual failures gracefully.
 */
export async function resolveCuratedMarketList(
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<PublicMarketTelemetry[]> {
  const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';

  // 1. Check DynamoDB cache for all curated IDs in parallel
  const cacheLookups = await Promise.all(
    CURATED_MARKET_APP_IDS.map(async (appId) => {
      const cached = await getCachedMarketTelemetry(appId, currency, ddbDocClient, tableName);
      return { appId, cached };
    }),
  );

  const resultMap = new Map<string, PublicMarketTelemetry>();
  const cacheMisses: string[] = [];

  for (const item of cacheLookups) {
    if (item.cached) {
      resultMap.set(item.appId, item.cached);
    } else {
      cacheMisses.push(item.appId);
    }
  }

  // 2. Resolve cache misses sequentially (BATCH_SIZE = 1) with 150ms pause
  for (let i = 0; i < cacheMisses.length; i++) {
    const missId = cacheMisses[i];
    const titleFallback = KNOWN_GAME_TITLES[missId] || null;
    try {
      const liveItem = await resolveMarketTelemetry(
        missId,
        preferredCurrency,
        ddbDocClient,
        tableName,
        titleFallback,
      );
      resultMap.set(missId, liveItem);
    } catch {
      resultMap.set(missId, buildMarketTelemetryPlaceholder(missId, preferredCurrency, titleFallback));
    }

    if (i < cacheMisses.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  // 3. Assemble results preserving canonical order of CURATED_MARKET_APP_IDS
  return CURATED_MARKET_APP_IDS.map(
    (appId) =>
      resultMap.get(appId) ||
      buildMarketTelemetryPlaceholder(appId, preferredCurrency, KNOWN_GAME_TITLES[appId] || null),
  );
}

/**
 * Builds structured fallback trending games telemetry excluding Free-to-Play titles.
 */
export function buildTrendingGamesList(preferredCurrency: string = 'USD'): TrendingGameSummary[] {
  const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
  return [
    {
      rank: 1,
      appId: 1091500,
      name: 'Cyberpunk 2077',
      currentPlayers: 54000,
      priceText: isBrl ? 'R$ 99.95 (-50%)' : '$ 29.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 29.99,
      bestPriceBrl: 99.95,
      cutPercent: 50,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1091500/',
      regularPrice: isBrl ? 199.9 : 59.99,
      salePrice: isBrl ? 99.95 : 29.99,
    },
    {
      rank: 2,
      appId: 1086940,
      name: "Baldur's Gate 3",
      currentPlayers: 82000,
      priceText: isBrl ? 'R$ 159.99 (-20%)' : '$ 47.99 (-20%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 47.99,
      bestPriceBrl: 159.99,
      cutPercent: 20,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1086940/',
      regularPrice: isBrl ? 199.99 : 59.99,
      salePrice: isBrl ? 159.99 : 47.99,
    },
    {
      rank: 3,
      appId: 1245620,
      name: 'ELDEN RING',
      currentPlayers: 67000,
      priceText: isBrl ? 'R$ 149.94 (-40%)' : '$ 35.99 (-40%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 35.99,
      bestPriceBrl: 149.94,
      cutPercent: 40,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1245620/',
      regularPrice: isBrl ? 249.9 : 59.99,
      salePrice: isBrl ? 149.94 : 35.99,
    },
    {
      rank: 4,
      appId: 292030,
      name: 'The Witcher 3: Wild Hunt',
      currentPlayers: 31000,
      priceText: isBrl ? 'R$ 32.49 (-75%)' : '$ 9.99 (-75%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/292030/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 9.99,
      bestPriceBrl: 32.49,
      cutPercent: 75,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/292030/',
      regularPrice: isBrl ? 129.99 : 39.99,
      salePrice: isBrl ? 32.49 : 9.99,
    },
    {
      rank: 5,
      appId: 582010,
      name: 'MONSTER HUNTER: WORLD',
      currentPlayers: 28000,
      priceText: isBrl ? 'R$ 49.95 (-50%)' : '$ 14.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/582010/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 14.99,
      bestPriceBrl: 49.95,
      cutPercent: 50,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/582010/',
      regularPrice: isBrl ? 99.9 : 29.99,
      salePrice: isBrl ? 49.95 : 14.99,
    },
    {
      rank: 6,
      appId: 1174180,
      name: 'Red Dead Redemption 2',
      currentPlayers: 39000,
      priceText: isBrl ? 'R$ 98.96 (-67%)' : '$ 19.79 (-67%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 19.79,
      bestPriceBrl: 98.96,
      cutPercent: 67,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1174180/',
      regularPrice: isBrl ? 299.9 : 59.99,
      salePrice: isBrl ? 98.96 : 19.79,
    },
    {
      rank: 7,
      appId: 990080,
      name: 'Hogwarts Legacy',
      currentPlayers: 21000,
      priceText: isBrl ? 'R$ 124.99 (-50%)' : '$ 29.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/990080/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 29.99,
      bestPriceBrl: 124.99,
      cutPercent: 50,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/990080/',
      regularPrice: isBrl ? 249.99 : 59.99,
      salePrice: isBrl ? 124.99 : 29.99,
    },
    {
      rank: 8,
      appId: 2358720,
      name: 'Black Myth: Wukong',
      currentPlayers: 65000,
      priceText: isBrl ? 'R$ 229.99' : '$ 59.99',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2358720/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 59.99,
      bestPriceBrl: 229.99,
      cutPercent: 0,
      isATL: false,
      dealUrl: 'https://store.steampowered.com/app/2358720/',
      regularPrice: isBrl ? 229.99 : 59.99,
      salePrice: isBrl ? 229.99 : 59.99,
    },
    {
      rank: 9,
      appId: 271590,
      name: 'Grand Theft Auto V',
      currentPlayers: 95000,
      priceText: isBrl ? 'R$ 41.20 (-50%)' : '$ 14.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/271590/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 14.99,
      bestPriceBrl: 41.2,
      cutPercent: 50,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/271590/',
      regularPrice: isBrl ? 82.4 : 29.99,
      salePrice: isBrl ? 41.2 : 14.99,
    },
    {
      rank: 10,
      appId: 252490,
      name: 'Rust',
      currentPlayers: 78000,
      priceText: isBrl ? 'R$ 51.50 (-50%)' : '$ 19.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/252490/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 19.99,
      bestPriceBrl: 51.5,
      cutPercent: 50,
      isATL: false,
      dealUrl: 'https://store.steampowered.com/app/252490/',
      regularPrice: isBrl ? 103.0 : 39.99,
      salePrice: isBrl ? 51.5 : 19.99,
    },
    {
      rank: 11,
      appId: 1145360,
      name: 'Hades',
      currentPlayers: 18000,
      priceText: isBrl ? 'R$ 25.15 (-66%)' : '$ 8.49 (-66%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 8.49,
      bestPriceBrl: 25.15,
      cutPercent: 66,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1145360/',
      regularPrice: isBrl ? 73.99 : 24.99,
      salePrice: isBrl ? 25.15 : 8.49,
    },
    {
      rank: 12,
      appId: 553850,
      name: 'HELLDIVERS 2',
      currentPlayers: 42000,
      priceText: isBrl ? 'R$ 199.50' : '$ 39.99',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/553850/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 39.99,
      bestPriceBrl: 199.5,
      cutPercent: 0,
      isATL: false,
      dealUrl: 'https://store.steampowered.com/app/553850/',
      regularPrice: isBrl ? 199.5 : 39.99,
      salePrice: isBrl ? 199.5 : 39.99,
    },
    {
      rank: 13,
      appId: 1326470,
      name: 'Sons Of The Forest',
      currentPlayers: 15000,
      priceText: isBrl ? 'R$ 48.94 (-45%)' : '$ 16.49 (-45%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1326470/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 16.49,
      bestPriceBrl: 48.94,
      cutPercent: 45,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1326470/',
      regularPrice: isBrl ? 88.99 : 29.99,
      salePrice: isBrl ? 48.94 : 16.49,
    },
    {
      rank: 14,
      appId: 1551360,
      name: 'Forza Horizon 5',
      currentPlayers: 22000,
      priceText: isBrl ? 'R$ 124.50 (-50%)' : '$ 29.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1551360/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 29.99,
      bestPriceBrl: 124.5,
      cutPercent: 50,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/1551360/',
      regularPrice: isBrl ? 249.0 : 59.99,
      salePrice: isBrl ? 124.5 : 29.99,
    },
    {
      rank: 15,
      appId: 2669320,
      name: 'EA SPORTS FC 25',
      currentPlayers: 51000,
      priceText: isBrl ? 'R$ 174.50 (-50%)' : '$ 34.99 (-50%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2669320/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 34.99,
      bestPriceBrl: 174.5,
      cutPercent: 50,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/2669320/',
      regularPrice: isBrl ? 349.0 : 69.99,
      salePrice: isBrl ? 174.5 : 34.99,
    },
    {
      rank: 16,
      appId: 381210,
      name: 'Dead by Daylight',
      currentPlayers: 36000,
      priceText: isBrl ? 'R$ 19.99 (-60%)' : '$ 7.99 (-60%)',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/381210/header.jpg',
      bestStore: 'steam',
      bestPriceUsd: 7.99,
      bestPriceBrl: 19.99,
      cutPercent: 60,
      isATL: true,
      dealUrl: 'https://store.steampowered.com/app/381210/',
      regularPrice: isBrl ? 49.99 : 19.99,
      salePrice: isBrl ? 19.99 : 7.99,
    },
  ];
}

/**
 * Resolves trending games on Steam:
 * - Checks DynamoDB cache under PK: MARKET#TRENDING#<currency>, SK: TELEMETRY (15-min TTL).
 * - If cached and fresh, serves immediately from DynamoDB to prevent list shifting.
 * - Collects raw candidates from top sellers & specials (up to 50 items) with localized currency.
 * - Filters out Free-to-Play titles and non-discounted promotional labels.
 * - Filters out Valve hardware and physical peripherals (Steam Deck, Valve Index, Controller, etc.).
 * - Deduplicates items by appId so identical games never appear more than once.
 * - Backfills from curated commercial games if needed to guarantee up to 16 entries.
 * - Enriches multi-store deal intelligence via cached/live ITAD lookups.
 * - Re-indexes sequential ranks (1, 2, 3...) after filtering.
 * - Caches result in DynamoDB and returns enriched trending games.
 */
export async function resolveTrendingGames(
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<TrendingGameSummary[]> {
  const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Check DynamoDB Cache
  if (tableName && ddbDocClient) {
    try {
      const cacheResult = await ddbDocClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND SK = :sk',
          ExpressionAttributeValues: {
            ':pk': `MARKET#TRENDING#${currency}`,
            ':sk': 'TELEMETRY',
          },
          Limit: 1,
        }),
      );

      if (cacheResult?.Items && Array.isArray(cacheResult.Items) && cacheResult.Items.length > 0) {
        const cached = cacheResult.Items[0] as {
          items?: TrendingGameSummary[];
          ttl?: number;
        };
        const isFresh = !cached.ttl || cached.ttl > nowSec;
        if (isFresh && Array.isArray(cached.items) && cached.items.length >= 6) {
          return cached.items;
        }
      }
    } catch (cacheErr) {
      console.warn(
        `[TrendingCache] Cache lookup failed for ${currency}:`,
        cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      );
    }
  }

  try {
    const rawTrending = await Promise.race([
      getSteamTrendingGames(50, currency),
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
      filtered.push(game);

      if (filtered.length >= 16) {
        break;
      }
    }

    // Backfill from curated commercial games if filtered count is less than 16
    if (filtered.length < 16) {
      const fallbackGames = buildTrendingGamesList(currency);
      for (const fallback of fallbackGames) {
        if (!seenAppIds.has(fallback.appId)) {
          seenAppIds.add(fallback.appId);
          filtered.push(fallback);
          if (filtered.length >= 16) {
            break;
          }
        }
      }
    }

    const candidateList = filtered.slice(0, 16);

    // Multi-store enrichment using cached/live ITAD deal lookups
    const enrichedList: TrendingGameSummary[] = await Promise.all(
      candidateList.map(async (candidate, idx): Promise<TrendingGameSummary> => {
        let dealInfo: GameDealInfo | PublicMarketTelemetry | null = null;
        if (tableName && ddbDocClient) {
          dealInfo = await getCachedMarketTelemetry(String(candidate.appId), currency, ddbDocClient, tableName);
        }

        if (!dealInfo) {
          try {
            dealInfo = await Promise.race([
              getGameDealInfo(String(candidate.appId), currency, candidate.name),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
            ]);
          } catch {
            dealInfo = null;
          }
        }

        let bestStore: 'steam' | 'nuuvem' | 'epic' | 'gog' = 'steam';
        let bestPriceUsd: number | null = null;
        let bestPriceBrl: number | null = null;
        let cutPercent = 0;
        let isATL = false;
        let salePrice: number | null = null;
        let regularPrice: number | null = null;
        let dealUrl: string | null = candidate.headerImage
          ? `https://store.steampowered.com/app/${candidate.appId}/`
          : null;
        let priceText = candidate.priceText;

        if (dealInfo && dealInfo.primaryDeal) {
          const allOffers: StoreDeal[] = dealInfo.storeBreakdown
            ? Object.values(dealInfo.storeBreakdown)
            : [dealInfo.primaryDeal];

          if (
            dealInfo.cheaperAlternative &&
            !allOffers.some((o) => o.shopName === dealInfo.cheaperAlternative?.shopName)
          ) {
            allOffers.push(dealInfo.cheaperAlternative);
          }

          const lowestOffer = allOffers.reduce((best, curr) => {
            if (typeof curr.salePrice !== 'number') return best;
            if (typeof best.salePrice !== 'number') return curr;
            return curr.salePrice < best.salePrice ? curr : best;
          }, dealInfo.cheaperAlternative || dealInfo.primaryDeal);

          bestStore = normalizeStoreSlug(lowestOffer.shopName);
          cutPercent =
            typeof lowestOffer.cutPercent === 'number'
              ? Math.max(0, Math.round(lowestOffer.cutPercent))
              : 0;
          isATL = Boolean(dealInfo.isAllTimeLow);
          salePrice = typeof lowestOffer.salePrice === 'number' ? lowestOffer.salePrice : null;
          regularPrice = typeof lowestOffer.regularPrice === 'number' ? lowestOffer.regularPrice : null;
          dealUrl = lowestOffer.url || dealUrl;

          if (currency === 'BRL') {
            bestPriceBrl = salePrice;
            bestPriceUsd = (candidate as TrendingGameSummary).bestPriceUsd ?? null;
          } else {
            bestPriceUsd = salePrice;
            bestPriceBrl = (candidate as TrendingGameSummary).bestPriceBrl ?? null;
          }

          if (salePrice !== null) {
            if (salePrice === 0) {
              priceText = 'Free to Play';
            } else {
              const sym = currency === 'BRL' ? 'R$' : '$';
              const cutStr = cutPercent > 0 ? ` (-${cutPercent}%)` : '';
              priceText = `${sym} ${salePrice.toFixed(2)}${cutStr}`;
            }
          }
        } else {
          const existing = candidate as TrendingGameSummary;
          if (existing.bestStore) {
            bestStore = existing.bestStore as 'steam' | 'nuuvem' | 'epic' | 'gog';
            bestPriceUsd = existing.bestPriceUsd ?? null;
            bestPriceBrl = existing.bestPriceBrl ?? null;
            cutPercent = existing.cutPercent ?? 0;
            isATL = Boolean(existing.isATL);
            salePrice = existing.salePrice ?? null;
            regularPrice = existing.regularPrice ?? null;
            dealUrl = existing.dealUrl ?? dealUrl;
            priceText = existing.priceText;
          } else {
            const cutMatch = (candidate.priceText || '').match(/\(-(\d+)%\)/);
            cutPercent = cutMatch ? parseInt(cutMatch[1], 10) : 0;
            const priceMatch = (candidate.priceText || '').match(/(?:\$|R\$)\s*([\d,.]+)/);
            const parsed = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null;
            salePrice = parsed;
            if (currency === 'BRL') {
              bestPriceBrl = parsed;
            } else {
              bestPriceUsd = parsed;
            }
          }
        }

        return {
          rank: idx + 1,
          appId: candidate.appId,
          name: candidate.name,
          currentPlayers: candidate.currentPlayers ?? null,
          priceText,
          headerImage:
            candidate.headerImage ||
            dealInfo?.imageUrl ||
            getCanonicalHeaderImageUrl(String(candidate.appId)),
          bestStore,
          bestPriceUsd,
          bestPriceBrl,
          cutPercent,
          isATL,
          dealUrl,
          regularPrice,
          salePrice,
        };
      }),
    );

    // 2. Persist to DynamoDB cache with 15-minute TTL
    if (tableName && ddbDocClient && enrichedList.length > 0) {
      try {
        await ddbDocClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `MARKET#TRENDING#${currency}`,
              SK: 'TELEMETRY',
              items: enrichedList,
              ttl: nowSec + 900, // 15-minute TTL
              updatedAt: new Date().toISOString(),
            },
          }),
        );
      } catch (putErr) {
        console.warn(
          `[TrendingCache] Cache save failed for ${currency}:`,
          putErr instanceof Error ? putErr.message : String(putErr),
        );
      }
    }

    if (enrichedList.length > 0) {
      return enrichedList;
    }
  } catch (error) {
    console.error(
      'Error fetching trending games, falling back to curated list:',
      error instanceof Error ? error.message : String(error),
    );
  }

  return buildTrendingGamesList(currency).slice(0, 16);
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

  const dealMap = new Map<string, PublicMarketTelemetry>();

  // Query DynamoDB in parallel for cached healthy telemetry across all wishlist target items.
  // To preserve ITAD burst quota when opening the wishlist grid, live getGameDealInfo calls
  // are completely avoided; cache misses rely solely on authentic Steam batch store pricing.
  if (tableName && ddbDocClient) {
    try {
      const cachedSettled = await Promise.allSettled(
        targetAppIds.map(async (appId) => {
          const cached = await getCachedMarketTelemetry(appId, currency, ddbDocClient, tableName);
          return { appId, cached };
        }),
      );
      for (const res of cachedSettled) {
        if (res.status === 'fulfilled' && res.value.cached) {
          dealMap.set(res.value.appId, res.value.cached);
        }
      }
    } catch {
      // Graceful fallback on DynamoDB error
    }
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
    titleMap,
  });

  const items: PublicWishlistItem[] = targetItems.map((item) => {
    const appId = item.appId;
    const priceInfo = priceMap.get(Number(appId));
    const cached = dealMap.get(appId);
    const dealInfo = cached;

    const candidateDealTitle =
      dealInfo?.title && dealInfo.title !== 'Monitored Title' && !isGenericSteamTitle(dealInfo.title)
        ? dealInfo.title
        : null;

    const rawTitle =
      candidateDealTitle ||
      APP_DIRECTORY[appId] ||
      KNOWN_GAME_TITLES[appId] ||
      titleMap.get(appId) ||
      titleMap.get(Number(appId));

    const resolvedTitle =
      rawTitle && !isGenericSteamTitle(rawTitle)
        ? rawTitle
        : `Steam App #${appId}`;

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
    const effectiveSteamSalePrice =
      typeof priceInfo?.salePrice === 'number' && priceInfo.salePrice !== null
        ? priceInfo.salePrice
        : typeof priceInfo?.final === 'number'
          ? priceInfo.final
          : typeof priceInfo?.price === 'number'
            ? priceInfo.price
            : null;

    const effectiveSteamRegularPrice =
      typeof priceInfo?.regularPrice === 'number' && priceInfo.regularPrice !== null
        ? priceInfo.regularPrice
        : typeof priceInfo?.initial === 'number'
          ? priceInfo.initial
          : effectiveSteamSalePrice;

    const effectiveSteamDiscount =
      typeof priceInfo?.discountPercent === 'number'
        ? priceInfo.discountPercent
        : effectiveSteamRegularPrice && effectiveSteamSalePrice && effectiveSteamRegularPrice > effectiveSteamSalePrice
          ? Math.round(((effectiveSteamRegularPrice - effectiveSteamSalePrice) / effectiveSteamRegularPrice) * 100)
          : 0;

    const hasValidSteamPrice = Boolean(
      priceInfo &&
      !priceInfo.isUnreleased &&
      typeof effectiveSteamSalePrice === 'number' &&
      effectiveSteamSalePrice !== null &&
      effectiveSteamSalePrice > 0
    );
    const isTrulyFreeDeal = Boolean(
      dealInfo &&
      (dealInfo.dealType === 'FREE_TO_KEEP' || dealInfo.primaryDeal?.salePrice === 0)
    );
    const isTrulyFreeSteam = Boolean(priceInfo?.isFree);

    if (hasValidDeal && dealInfo?.primaryDeal) {
      // 1. Deal intelligence with authentic store pricing takes absolute precedence
      isFree = dealInfo.primaryDeal.salePrice === 0 || dealInfo.primaryDeal.cutPercent === 100;
      salePrice = dealInfo.primaryDeal.salePrice;
      regularPrice = dealInfo.primaryDeal.regularPrice;
      discountPercent = dealInfo.primaryDeal.cutPercent;
      primaryDeal = dealInfo.primaryDeal;
      cheaperAlternative = dealInfo.cheaperAlternative || null;
      storeBreakdown = dealInfo.storeBreakdown;
      isUnreleased = false;
    } else if (hasValidSteamPrice) {
      // 2. Confirmed Steam store pricing
      isFree = false;
      salePrice = effectiveSteamSalePrice!;
      regularPrice = effectiveSteamRegularPrice ?? salePrice;
      discountPercent = effectiveSteamDiscount;
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
      primaryDeal = dealInfo?.primaryDeal || null;
      cheaperAlternative = dealInfo?.cheaperAlternative || null;
      storeBreakdown = dealInfo?.storeBreakdown;
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

    const canonicalHeaderUrl = getCanonicalHeaderImageUrl(appId);
    const cachedArtwork = artworkMap.get(appId);
    const isAuthentic = (url: string | null | undefined): url is string => isAuthenticArtworkUrl(url, appId);

    let resolvedImageUrl: string;
    if (isAuthentic(cached?.imageUrl)) {
      resolvedImageUrl = cached!.imageUrl;
    } else if (isAuthentic(cachedArtwork)) {
      resolvedImageUrl = cachedArtwork!;
    } else if (isAuthentic(priceInfo?.headerImage)) {
      resolvedImageUrl = priceInfo!.headerImage!;
    } else {
      resolvedImageUrl = cachedArtwork || canonicalHeaderUrl;
    }
    const authenticPriority =
      typeof item.priority === 'number'
        ? Math.floor(item.priority)
        : Number(item.priority ?? 0);

    return {
      appId,
      title: resolvedTitle,
      imageUrl: resolvedImageUrl,
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
 * Computes deterministic behavioral archetype based on mathematical playtime ratios.
 */
export function computeGamerArchetype(params: {
  top3SharePercent: number;
  unplayedRatioPercent: number;
  playedOver10hCount: number;
  averageHoursPerPlayedGame: number;
  totalGames: number;
  accountAgeYears: number;
}): DossierArchetype {
  const {
    top3SharePercent,
    unplayedRatioPercent,
    playedOver10hCount,
    averageHoursPerPlayedGame,
    totalGames,
    accountAgeYears,
  } = params;

  if (top3SharePercent >= 55) {
    return {
      id: 'FOCUS_MONK',
      label: 'Focus Monk',
      tagline: 'Dedicated master channeling the vast majority of playtime into a select few core titles.',
      primaryMetricLabel: 'Top 3 Playtime Share',
      primaryMetricValue: `${top3SharePercent}%`,
      traits: ['Deep Mastery', 'High Playtime Concentration', 'Selective Library Engagement'],
    };
  }

  if (totalGames >= 80 && unplayedRatioPercent >= 55) {
    return {
      id: 'VAULT_COLLECTOR',
      label: 'Vault Collector',
      tagline: 'Curator of an expansive digital vault with an ambitious backlog waiting to be conquered.',
      primaryMetricLabel: 'Unplayed Library Ratio',
      primaryMetricValue: `${unplayedRatioPercent}%`,
      traits: ['Expansive Catalog', 'Backlog Curator', 'Deal Collector'],
    };
  }

  if (accountAgeYears >= 8 && playedOver10hCount >= 25) {
    return {
      id: 'VETERAN_HISTORIAN',
      label: 'Veteran Historian',
      tagline: 'Long-tenured Steam veteran with dozens of deep campaigns logged across multiple generations.',
      primaryMetricLabel: 'Deep Campaigns (10h+)',
      primaryMetricValue: `${playedOver10hCount} titles`,
      traits: ['Multi-Year Tenure', 'Campaign Finisher', 'Broad Genre Experience'],
    };
  }

  return {
    id: 'TACTICAL_EXPLORER',
    label: 'Tactical Explorer',
    tagline: 'Balanced gamer actively exploring a versatile variety of genres and gaming experiences.',
    primaryMetricLabel: 'Average Hours Per Game',
    primaryMetricValue: `${averageHoursPerPlayedGame}h`,
    traits: ['Versatile Variety', 'Balanced Playtime', 'Active Explorer'],
  };
}

/**
 * Builds yearly activity TimeStream series from account creation up to the current year.
 * Distributes historical baseline activity cleanly when rtime_last_played is 0.
 */
export function buildDossierTimeStream(
  games: SteamOwnedGameItem[],
  accountCreatedYear: number,
  currentYear: number = new Date().getUTCFullYear(),
): DossierTimeStreamYear[] {
  const validCreatedYear =
    !isNaN(accountCreatedYear) && accountCreatedYear > 1990 ? accountCreatedYear : currentYear;
  const startYear = Math.min(validCreatedYear, currentYear);
  const timelineYears: number[] = [];
  for (let y = startYear; y <= currentYear; y++) {
    timelineYears.push(y);
  }

  const yearBuckets = new Map<
    number,
    {
      activeGames: Array<{ appId: number; title: string; minutes: number }>;
      recordedMinutes: number;
    }
  >();

  for (const y of timelineYears) {
    yearBuckets.set(y, { activeGames: [], recordedMinutes: 0 });
  }

  const playedGames = games.filter((g) => (g.playtime_forever ?? 0) > 0);
  const untrackedGames: SteamOwnedGameItem[] = [];

  for (const game of playedGames) {
    if (game.rtime_last_played && game.rtime_last_played > 0) {
      const playedYear = new Date(game.rtime_last_played * 1000).getUTCFullYear();
      const targetYear = Math.max(startYear, Math.min(currentYear, playedYear));
      const bucket = yearBuckets.get(targetYear);
      if (bucket) {
        bucket.activeGames.push({
          appId: game.appId,
          title: game.name,
          minutes: game.playtime_forever ?? 0,
        });
        bucket.recordedMinutes += game.playtime_forever ?? 0;
      }
    } else {
      untrackedGames.push(game);
    }
  }

  const numYears = timelineYears.length;
  const totalUntrackedMinutes = untrackedGames.reduce(
    (acc, g) => acc + (g.playtime_forever ?? 0),
    0,
  );
  const baselineMinutesPerYear = numYears > 0 ? totalUntrackedMinutes / numYears : 0;
  const dominantUntracked = [...untrackedGames].sort(
    (a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0),
  )[0];

  const timeStream: DossierTimeStreamYear[] = [];

  for (const year of timelineYears) {
    const bucket = yearBuckets.get(year)!;
    const yearTotalMinutes = bucket.recordedMinutes + baselineMinutesPerYear;
    const rawHours = yearTotalMinutes / 60;
    const recordedHours = isNaN(rawHours) ? 0 : Number(rawHours.toFixed(1));

    let dominantGameTitle: string | null = null;
    let dominantGameAppId: number | null = null;

    if (bucket.activeGames.length > 0) {
      const sorted = [...bucket.activeGames].sort((a, b) => b.minutes - a.minutes);
      dominantGameTitle = sorted[0].title;
      dominantGameAppId = sorted[0].appId;
    } else if (dominantUntracked && baselineMinutesPerYear > 0) {
      dominantGameTitle = dominantUntracked.name;
      dominantGameAppId = dominantUntracked.appId;
    }

    let activeTitlesCount = bucket.activeGames.length;
    if (activeTitlesCount === 0 && untrackedGames.length > 0 && baselineMinutesPerYear > 0) {
      activeTitlesCount = Math.max(1, Math.round(untrackedGames.length / numYears));
    }

    timeStream.push({
      year,
      activeTitlesCount: isNaN(activeTitlesCount) ? 0 : activeTitlesCount,
      recordedHours,
      dominantGameTitle,
      dominantGameAppId,
    });
  }

  return timeStream;
}

/**
 * Resolves player Gamer Dossier telemetry including tenure, TimeStream, and behavioral archetype.
 */
export async function resolveDossierTelemetry(
  target: string,
  preferredCurrency: string = 'USD',
  ddbDocClient: DynamoDBDocumentClient = docClient,
  tableName: string = process.env.TABLE_NAME || '',
): Promise<DossierTelemetryApiResult> {
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

  const isBrl = (preferredCurrency || '').toUpperCase().trim() === 'BRL';
  const currency = isBrl ? 'BRL' : 'USD';
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Check DynamoDB Cache
  if (tableName && ddbDocClient) {
    try {
      const cacheResult = await ddbDocClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND SK = :sk',
          ExpressionAttributeValues: {
            ':pk': `DOSSIER#v1#${steamId}`,
            ':sk': 'TELEMETRY',
          },
          Limit: 1,
        }),
      );

      if (cacheResult?.Items && Array.isArray(cacheResult.Items) && cacheResult.Items.length > 0) {
        const cached = cacheResult.Items[0] as PublicDossierResponse & {
          ttl?: number;
          PK?: string;
          SK?: string;
        };
        const isFresh = !cached.ttl || cached.ttl > nowSec;
        if (isFresh) {
          const { PK, SK, ttl, ...payload } = cached;
          return {
            success: true,
            data: {
              ...(payload as PublicDossierResponse),
              currency,
            },
          };
        }
      }
    } catch (cacheErr) {
      console.warn(
        'Failed to query DynamoDB dossier cache:',
        cacheErr instanceof Error ? cacheErr.message : cacheErr,
      );
    }
  }

  // 2. Fetch Upstream Steam Telemetry in Parallel
  const [summary, ownedGamesResult] = await Promise.all([
    getPlayerSummary(steamId, steamApiKey),
    getOwnedGames(steamId, steamApiKey),
  ]);

  if (!summary) {
    return {
      success: false,
      statusCode: 404,
      error: 'NotFound',
      message: `Steam profile '${cleanTarget}' was not found.`,
    };
  }

  if (!ownedGamesResult) {
    return {
      success: false,
      statusCode: 502,
      error: 'UpstreamError',
      message: 'Failed to communicate with Steam servers.',
    };
  }

  if (ownedGamesResult.isPrivate || !ownedGamesResult.games || ownedGamesResult.games.length === 0) {
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

  const allGames = ownedGamesResult.games;
  const totalGames = ownedGamesResult.gameCount || allGames.length;
  const playedGamesList = allGames.filter((g) => (g.playtime_forever ?? 0) > 0);
  const playedGames = playedGamesList.length;
  const unplayedGames = allGames.filter((g) => (g.playtime_forever ?? 0) === 0).length;

  const totalPlaytimeMinutes = allGames.reduce((acc, g) => acc + (g.playtime_forever ?? 0), 0);
  const totalPlaytimeHours = Number((totalPlaytimeMinutes / 60).toFixed(1));

  const sortedPlayedGames = [...playedGamesList].sort(
    (a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0),
  );
  const top10Games = sortedPlayedGames.slice(0, 10);
  const top10AppIds = top10Games.map((g) => g.appId);

  // 3. Hydrate top 10 most-played games with authentic artwork
  const artworkMap = await batchResolveAuthenticArtwork(top10AppIds, { ddbDocClient, tableName });

  const topPlayedGames: DossierTopGame[] = top10Games.map((g) => {
    const appIdStr = String(g.appId);
    const imageUrl = artworkMap.get(appIdStr) || getCanonicalHeaderImageUrl(appIdStr);
    const title = g.name || KNOWN_GAME_TITLES[appIdStr] || `App #${g.appId}`;
    const hoursPlayed = Number(((g.playtime_forever ?? 0) / 60).toFixed(1));
    const sharePercent =
      totalPlaytimeMinutes > 0
        ? Number((((g.playtime_forever ?? 0) / totalPlaytimeMinutes) * 100).toFixed(1))
        : 0;

    return {
      appId: g.appId,
      title,
      imageUrl,
      hoursPlayed,
      sharePercent,
    };
  });

  // 4. Determine Account Created Year & Tenure
  const currentYear = new Date().getUTCFullYear();
  let accountCreatedYear = currentYear;
  if (summary.timeCreatedTimestamp) {
    accountCreatedYear = new Date(summary.timeCreatedTimestamp * 1000).getUTCFullYear();
  } else if (summary.timeCreated) {
    const parsed = new Date(summary.timeCreated).getUTCFullYear();
    if (!isNaN(parsed) && parsed > 1990) {
      accountCreatedYear = parsed;
    }
  } else {
    const yearsWithPlay = allGames
      .filter((g) => (g.rtime_last_played ?? 0) > 0)
      .map((g) => new Date(g.rtime_last_played * 1000).getUTCFullYear());
    if (yearsWithPlay.length > 0) {
      accountCreatedYear = Math.min(...yearsWithPlay);
    }
  }
  accountCreatedYear = Math.min(accountCreatedYear, currentYear);
  const accountAgeYears = Math.max(0, currentYear - accountCreatedYear);

  // 5. Compute Behavioral Archetype
  const top3PlaytimeMinutes = sortedPlayedGames
    .slice(0, 3)
    .reduce((acc, g) => acc + (g.playtime_forever ?? 0), 0);
  const top3SharePercent =
    totalPlaytimeMinutes > 0
      ? Number(((top3PlaytimeMinutes / totalPlaytimeMinutes) * 100).toFixed(1))
      : 0;
  const unplayedRatioPercent =
    totalGames > 0 ? Number(((unplayedGames / totalGames) * 100).toFixed(1)) : 0;
  const playedOver10hCount = allGames.filter((g) => (g.playtime_forever ?? 0) >= 600).length;
  const averageHoursPerPlayedGame =
    playedGames > 0 ? Number((totalPlaytimeHours / playedGames).toFixed(1)) : 0;

  const archetype = computeGamerArchetype({
    top3SharePercent,
    unplayedRatioPercent,
    playedOver10hCount,
    averageHoursPerPlayedGame,
    totalGames,
    accountAgeYears,
  });

  // 6. TimeStream Yearly Series
  const timeStream = buildDossierTimeStream(allGames, accountCreatedYear, currentYear);

  // 7. Interactive Game Bubble Constellation (up to 250 played titles)
  const constellationCandidates = sortedPlayedGames.slice(0, 250);
  const constellationYearSpan = Math.max(1, 2026 - accountCreatedYear + 1);

  const constellationGames: DossierConstellationGame[] = constellationCandidates.map((g) => {
    const appId = g.appId;
    const title = g.name || KNOWN_GAME_TITLES[String(appId)] || `App #${appId}`;
    const hoursPlayed = Math.round(((g.playtime_forever ?? 0) / 60) * 10) / 10;
    const sharePercent =
      totalPlaytimeHours > 0
        ? Math.round((hoursPlayed / totalPlaytimeHours) * 1000) / 10
        : 0;

    let year: number;
    let isEstimatedYear: boolean;

    if (g.rtime_last_played && g.rtime_last_played > 0) {
      const playedYear = new Date(g.rtime_last_played * 1000).getUTCFullYear();
      year = Math.max(accountCreatedYear, Math.min(2026, playedYear));
      isEstimatedYear = false;
    } else {
      year = (Math.abs(appId) % constellationYearSpan) + accountCreatedYear;
      isEstimatedYear = true;
    }

    const appIdStr = String(appId);
    const imageUrl = artworkMap.get(appIdStr) || getCanonicalHeaderImageUrl(appIdStr);

    return {
      appId,
      title,
      year,
      isEstimatedYear,
      hoursPlayed,
      sharePercent,
      imageUrl,
    };
  });

  const summaryMetrics: DossierSummaryMetrics = {
    totalGames,
    playedGames,
    unplayedGames,
    totalPlaytimeHours,
    accountCreatedYear,
    accountAgeYears,
    topPlayedGames,
  };

  const dossierData: PublicDossierResponse = {
    steamId,
    target: displayTarget,
    personaName: summary.personaName || 'Unknown Player',
    avatarUrl: summary.avatarUrl || null,
    profileUrl: summary.profileUrl || `https://steamcommunity.com/profiles/${steamId}`,
    currency,
    ...summaryMetrics,
    summary: summaryMetrics,
    timeStream,
    archetype,
    constellationGames,
    updatedAt: new Date().toISOString(),
  };

  // 8. Persist to DynamoDB Cache (TTL 3600 seconds)
  if (tableName && ddbDocClient) {
    try {
      const ttl = nowSec + 3600;
      await ddbDocClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `DOSSIER#v1#${steamId}`,
            SK: 'TELEMETRY',
            ...dossierData,
            ttl,
          },
        }),
      );
    } catch (saveErr) {
      console.warn(
        'Failed to persist dossier telemetry to DynamoDB:',
        saveErr instanceof Error ? saveErr.message : saveErr,
      );
    }
  }

  return {
    success: true,
    data: dossierData,
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
      const currencyParam = event.queryStringParameters?.currency;
      const preferredCurrency = (currencyParam || 'USD').toUpperCase() === 'BRL' ? 'BRL' : 'USD';
      const trending = await resolveTrendingGames(preferredCurrency, docClient, tableName);
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
      const cleanAppId = appId.trim();
      const queryTitle = event.queryStringParameters?.title?.trim() || null;
      const titleFallback = queryTitle || KNOWN_GAME_TITLES[cleanAppId] || null;
      const telemetry = await resolveMarketTelemetry(
        cleanAppId,
        preferredCurrency,
        docClient,
        tableName,
        titleFallback,
      );
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
      const searchQuery = event.queryStringParameters?.q;

      // Live search via Steam Storefront API
      if (searchQuery && searchQuery.trim()) {
        const country = preferredCurrency === 'BRL' ? 'br' : 'us';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        try {
          const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(searchQuery.trim())}&l=english&cc=${country}`;
          const searchRes = await fetch(searchUrl, {
            headers: { 'User-Agent': 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)' },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (searchRes.ok) {
            const searchData = (await searchRes.json()) as {
              total?: number;
              items?: Array<{ id?: number | string; name?: string; type?: string }>;
            };
            const rawItems = searchData?.items || [];
            const normalizedQuery = searchQuery.trim().toLowerCase();

            // 1. Filter out items without valid IDs and non-app types if specified
            const seenAppIds = new Set<string>();
            const validItems: Array<{ id: string; name: string }> = [];

            for (const item of rawItems) {
              if (item.id === undefined || item.id === null) continue;
              const appIdStr = String(item.id).trim();
              if (!appIdStr || seenAppIds.has(appIdStr)) continue;
              if (item.type && item.type !== 'app') continue;

              seenAppIds.add(appIdStr);
              validItems.push({
                id: appIdStr,
                name: (item.name || '').trim(),
              });
            }

            // 2. Sort: exact match first (priority 0), prefix match second (priority 1), others third (priority 2)
            const sortedItems = [...validItems].sort((a, b) => {
              const aName = a.name.toLowerCase();
              const bName = b.name.toLowerCase();

              const aPriority = aName === normalizedQuery ? 0 : aName.startsWith(normalizedQuery) ? 1 : 2;
              const bPriority = bName === normalizedQuery ? 0 : bName.startsWith(normalizedQuery) ? 1 : 2;

              return aPriority - bPriority;
            });

            // 3. Return up to 6 matching results
            const topMatches = sortedItems.slice(0, 6);

            if (topMatches.length > 0) {
              const results = await Promise.all(
                topMatches.map((m) =>
                  resolveMarketTelemetry(
                    m.id,
                    preferredCurrency,
                    docClient,
                    tableName,
                    m.name || null,
                  ),
                ),
              );
              return createJsonResponse(200, results);
            }
          }
          return createJsonResponse(200, []);
        } catch (searchErr) {
          clearTimeout(timeoutId);
          console.error(
            'Error performing live market search on Steam storefront:',
            searchErr instanceof Error ? searchErr.message : String(searchErr),
          );
          return createJsonResponse(200, []);
        }
      }

      const queryAppId = event.queryStringParameters?.appId;
      if (queryAppId && queryAppId.trim()) {
        const cleanAppId = queryAppId.trim();
        const queryTitle = event.queryStringParameters?.title?.trim() || null;
        const titleFallback = queryTitle || KNOWN_GAME_TITLES[cleanAppId] || null;
        const item = await resolveMarketTelemetry(
          cleanAppId,
          preferredCurrency,
          docClient,
          tableName,
          titleFallback,
        );
        return createJsonResponse(200, [item]);
      }

      const curatedList = await resolveCuratedMarketList(preferredCurrency, docClient, tableName);
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

    // Route 7: GET /public/dossier/{target}
    const isDossierBaseRoute =
      rawPath === '/public/dossier' ||
      rawPath === '/public/dossier/' ||
      rawPath.endsWith('/prod/public/dossier') ||
      rawPath.endsWith('/prod/public/dossier/');

    if (isDossierBaseRoute && (!event.pathParameters || !event.pathParameters.target)) {
      return createJsonResponse(400, {
        error: 'BadRequest',
        message: 'Missing or invalid target parameter.',
      });
    }

    const isExplicitDossierRoute = event.routeKey === 'GET /public/dossier/{target}';
    const hasDossierSubpath =
      rawPath.includes('/public/dossier/') &&
      Boolean(rawPath.split('/public/dossier/')[1]?.split('?')[0]?.trim());
    const hasDossierTargetParam =
      Boolean(event.pathParameters && 'target' in event.pathParameters) &&
      (rawPath.includes('/public/dossier') || isExplicitDossierRoute);

    if (isExplicitDossierRoute || hasDossierTargetParam || hasDossierSubpath) {
      let target = event.pathParameters?.target;
      if (!target && rawPath.includes('/public/dossier/')) {
        const parts = rawPath.split('/public/dossier/');
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
      const result = await resolveDossierTelemetry(cleanTarget, preferredCurrency, docClient, tableName);
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
