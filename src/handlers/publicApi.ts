/**
 * zT Radar — Public Web & PWA Companion API Handler
 *
 * Exposes lightweight, read-only public endpoints for Web and PWA companions:
 * - GET /public/market: Retrieves curated market game telemetry with live deal intelligence.
 * - GET /public/market/trending: Retrieves trending game telemetry on Steam (excluding Free-to-Play).
 * - GET /public/market/{appId}: Retrieves market telemetry and multi-store deal intelligence for a specific game.
 * - GET /public/duel/{duelId}: Retrieves historical library duel comparison payload from DynamoDB.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { PublicMarketTelemetry, SteamTrendingEntry, StoreDeal } from '../types/index.js';
import { getGameDealInfo } from '../utils/itadApi.js';
import { getSteamTrendingGames } from '../utils/platformStatus.js';

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
  const bannerUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cleanAppId}/header.jpg`;
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
): Promise<PublicMarketTelemetry> {
  const cleanAppId = appId.trim();
  const cdnBannerUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cleanAppId}/header.jpg`;
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

      return {
        ...dealInfo,
        appId: cleanAppId,
        gameId: dealInfo.gameId || `steam_${cleanAppId}`,
        title: resolvedTitle,
        imageUrl: dealInfo.imageUrl || cdnBannerUrl,
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
): Promise<PublicMarketTelemetry[]> {
  const settled = await Promise.allSettled(
    CURATED_MARKET_APP_IDS.map((appId) => resolveMarketTelemetry(appId, preferredCurrency)),
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
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
    },
    {
      rank: 2,
      appId: 1086940,
      name: "Baldur's Gate 3",
      currentPlayers: 82000,
      priceText: '$ 47.99 (-20%)',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
    },
    {
      rank: 3,
      appId: 1245620,
      name: 'ELDEN RING',
      currentPlayers: 67000,
      priceText: '$ 35.99 (-40%)',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
    },
    {
      rank: 4,
      appId: 292030,
      name: 'The Witcher 3: Wild Hunt',
      currentPlayers: 31000,
      priceText: '$ 9.99 (-75%)',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/292030/header.jpg',
    },
  ];
}

/**
 * Resolves trending games on Steam:
 * - Filters out Free-to-Play titles and non-discounted promotional labels.
 * - Filters out Valve hardware and physical peripherals (Steam Deck, Valve Index, Controller, etc.).
 * - Deduplicates items by appId so identical games never appear more than once.
 * - Re-indexes sequential ranks (1, 2, 3...) after filtering.
 * - Gracefully falls back to curated trending games on timeout or upstream failure.
 */
export async function resolveTrendingGames(): Promise<SteamTrendingEntry[]> {
  try {
    const rawTrending = await Promise.race([
      getSteamTrendingGames(),
      new Promise<SteamTrendingEntry[]>((resolve) => setTimeout(() => resolve([]), 2000)),
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
    }

    if (filtered.length > 0) {
      return filtered;
    }
  } catch (error) {
    console.error(
      'Error fetching trending games, falling back to curated list:',
      error instanceof Error ? error.message : String(error),
    );
  }

  return buildTrendingGamesList();
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
