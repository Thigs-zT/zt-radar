import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler, createJsonResponse, buildMarketTelemetryPlaceholder, CORS_HEADERS } from '../../src/handlers/publicApi.js';
import type { HttpApiEvent } from '../../src/handlers/publicApi.js';

describe('Public Web API Handler', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const originalEnv = { ...process.env };
  const MOCK_TABLE = 'zTRadarTestTable';

  beforeEach(() => {
    ddbMock.reset();
    process.env.TABLE_NAME = MOCK_TABLE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('CORS and Preflight Handling', () => {
    it('should return 204 with CORS headers on OPTIONS preflight request', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'OPTIONS',
            path: '/public/market/1086940',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
      expect(response.headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    });

    it('should return 405 Method Not Allowed for unsupported HTTP methods', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'POST',
            path: '/public/market/1086940',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(405);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('MethodNotAllowed');
      expect(body.message).toContain('POST');
    });
  });

  describe('Route: GET /public/market/{appId}', () => {
    it('should return structured market telemetry for a valid appId', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/1086940',
        pathParameters: {
          appId: '1086940',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/1086940',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

      const data = JSON.parse(response.body);
      expect(data.appId).toBe('1086940');
      expect(data.gameId).toBe('steam_1086940');
      expect(data.steamAppId).toBe('1086940');
      expect(data.dealType).toBe('CURATED_DEAL');
      expect(data.primaryDeal).toBeDefined();
      expect(data.primaryDeal.shopName).toBe('Steam');
      expect(data.primaryDeal.salePrice).toBe(19.99);
      expect(data.primaryDeal.regularPrice).toBe(29.99);
      expect(data.primaryDeal.cutPercent).toBe(33);
      expect(data.primaryDeal.currency).toBe('USD');
      expect(data.storeBreakdown).toBeDefined();
      expect(data.storeBreakdown.Steam).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it('should extract appId from rawPath if pathParameters is missing', async () => {
      const event: HttpApiEvent = {
        rawPath: '/prod/public/market/730',
        requestContext: {
          http: {
            method: 'GET',
            path: '/prod/public/market/730',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.appId).toBe('730');
      expect(data.gameId).toBe('steam_730');
    });

    it('should return 400 Bad Request when appId is missing or empty', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/',
        pathParameters: {
          appId: '',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
      expect(data.message).toContain('appId');
    });
  });

  describe('Route: GET /public/duel/{duelId}', () => {
    it('should return 200 and duel payload when duel is found in DynamoDB', async () => {
      const mockPayload = {
        winner: 'A',
        playerA: { personaName: 'Alice', steamId: '76561198000000001' },
        playerB: { personaName: 'Bob', steamId: '76561198000000002' },
        commonGamesCount: 15,
      };

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: 'DUEL#test-duel-123',
            SK: 'METADATA',
            payload: mockPayload,
            created_at: '2026-09-29T12:00:00Z',
          },
        ],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/duel/{duelId}',
        rawPath: '/public/duel/test-duel-123',
        pathParameters: {
          duelId: 'test-duel-123',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/duel/test-duel-123',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      const data = JSON.parse(response.body);
      expect(data).toEqual(mockPayload);

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls.length).toBe(1);
      expect(queryCalls[0].args[0].input.TableName).toBe(MOCK_TABLE);
      expect(queryCalls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('DUEL#test-duel-123');
    });

    it('should return item directly if record does not have a nested payload field', async () => {
      const flatRecord = {
        PK: 'DUEL#flat-duel-456',
        SK: 'METADATA',
        duelId: 'flat-duel-456',
        winner: 'B',
      };

      ddbMock.on(QueryCommand).resolves({
        Items: [flatRecord],
      });

      const event: HttpApiEvent = {
        pathParameters: {
          duelId: 'flat-duel-456',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/duel/flat-duel-456',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.PK).toBe('DUEL#flat-duel-456');
      expect(data.winner).toBe('B');
    });

    it('should return 404 Not Found when duel record is not in DynamoDB', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [],
      });

      const event: HttpApiEvent = {
        pathParameters: {
          duelId: 'non-existent-duel',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/duel/non-existent-duel',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
      expect(data.message).toContain('non-existent-duel');
    });

    it('should return 400 Bad Request when duelId is missing or empty', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/duel/{duelId}',
        rawPath: '/public/duel/',
        pathParameters: {
          duelId: '   ',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/duel/',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 500 when TABLE_NAME is not configured', async () => {
      delete process.env.TABLE_NAME;

      const event: HttpApiEvent = {
        pathParameters: {
          duelId: 'any-duel',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/duel/any-duel',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(500);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('ConfigurationError');
    });
  });

  describe('Unknown Routes and Error Handling', () => {
    it('should return 404 for unmatched routes', async () => {
      const event: HttpApiEvent = {
        rawPath: '/public/unknown/route',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/unknown/route',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
    });

    it('should catch unexpected DynamoDB exceptions and return 500', async () => {
      ddbMock.on(QueryCommand).rejects(new Error('DynamoDB connection timeout'));

      const event: HttpApiEvent = {
        pathParameters: {
          duelId: 'error-duel',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/duel/error-duel',
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await handler(event);

      expect(response.statusCode).toBe(500);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('InternalServerError');

      consoleSpy.mockRestore();
    });
  });
});
