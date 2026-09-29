/**
 * zT Radar — Public Web & PWA Companion API Handler
 *
 * Exposes lightweight, read-only public endpoints for Web and PWA companions:
 * - GET /public/market/{appId}: Retrieves market telemetry and deal intelligence for a specific game.
 * - GET /public/duel/{duelId}: Retrieves historical library duel comparison payload from DynamoDB.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { PublicMarketTelemetry } from '../types/index.js';

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
 * Builds placeholder structured market telemetry matching canonical domain contracts.
 */
export function buildMarketTelemetryPlaceholder(appId: string): PublicMarketTelemetry {
  const cleanAppId = appId.trim();
  const storeUrl = `https://store.steampowered.com/app/${cleanAppId}`;
  const bannerUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cleanAppId}/header.jpg`;

  return {
    appId: cleanAppId,
    gameId: `steam_${cleanAppId}`,
    title: `Steam Application ${cleanAppId}`,
    imageUrl: bannerUrl,
    reviewScore: 80,
    steamAppId: cleanAppId,
    dealType: 'CURATED_DEAL',
    isAllTimeLow: false,
    allTimeLowPrice: 19.99,
    expiry: null,
    primaryDeal: {
      shopName: 'Steam',
      salePrice: 19.99,
      regularPrice: 29.99,
      cutPercent: 33,
      url: storeUrl,
      expiry: null,
      currency: 'USD',
      currencySymbol: '$',
    },
    cheaperAlternative: null,
    storeBreakdown: {
      Steam: {
        shopName: 'Steam',
        salePrice: 19.99,
        regularPrice: 29.99,
        cutPercent: 33,
        url: storeUrl,
        expiry: null,
        currency: 'USD',
        currencySymbol: '$',
      },
    },
    alternativeCheckStatus: 'confirmed',
    alternativeCheckDegraded: false,
    updatedAt: new Date().toISOString(),
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
    // Route: GET /public/market/{appId}
    const isMarketRoute =
      event.routeKey === 'GET /public/market/{appId}' ||
      rawPath.includes('/public/market/') ||
      Boolean(event.pathParameters?.appId && !event.pathParameters?.duelId);

    if (isMarketRoute) {
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

      const telemetry = buildMarketTelemetryPlaceholder(appId);
      return createJsonResponse(200, telemetry);
    }

    // Route: GET /public/duel/{duelId}
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
        })
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
