import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { HttpApiEvent } from '../../src/handlers/publicApi.js';
import type { GameDealInfo, SteamTrendingEntry } from '../../src/types/index.js';

// Mock external intelligence utilities before importing handler
vi.mock('../../src/utils/itadApi.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getGameDealInfo: vi.fn(),
  };
});

vi.mock('../../src/utils/platformStatus.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSteamTrendingGames: vi.fn(),
  };
});

vi.mock('../../src/utils/steamWeb.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveSteamId: vi.fn(),
    fetchSteamWishlist: vi.fn(),
    batchFetchSteamAppPrices: vi.fn(),
    resolveSteamAppTitles: vi.fn(),
    getPlayerLibraryDetailed: vi.fn(),
  };
});

vi.mock('../../src/utils/hltbNative.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getHowLongToBeatStats: vi.fn(),
  };
});

import {
  handler,
  createJsonResponse,
  buildMarketTelemetryPlaceholder,
  buildTrendingGamesList,
  resolveWishlistTelemetry,
  resolveBacklogTelemetry,
  formatCurrency,
  CORS_HEADERS,
  KNOWN_GAME_TITLES,
  CURATED_MARKET_APP_IDS,
} from '../../src/handlers/publicApi.js';
import { getHowLongToBeatStats } from '../../src/utils/hltbNative.js';
import { getGameDealInfo } from '../../src/utils/itadApi.js';
import { getSteamTrendingGames } from '../../src/utils/platformStatus.js';
import {
  resolveSteamId,
  fetchSteamWishlist,
  batchFetchSteamAppPrices,
  resolveSteamAppTitles,
  getPlayerLibraryDetailed,
} from '../../src/utils/steamWeb.js';

describe('Public Web API Handler', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const originalEnv = { ...process.env };
  const MOCK_TABLE = 'zTRadarTestTable';

  const mockDealBaldursGate: GameDealInfo = {
    gameId: 'steam_1086940',
    title: "Baldur's Gate 3",
    imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
    reviewScore: 96,
    steamAppId: '1086940',
    dealType: 'CURATED_DEAL',
    isAllTimeLow: false,
    allTimeLowPrice: 47.99,
    expiry: null,
    primaryDeal: {
      shopName: 'Steam',
      salePrice: 47.99,
      regularPrice: 59.99,
      cutPercent: 20,
      url: 'https://store.steampowered.com/app/1086940/',
      expiry: null,
      currency: 'USD',
      currencySymbol: '$',
    },
    cheaperAlternative: {
      shopName: 'GOG',
      salePrice: 44.99,
      regularPrice: 59.99,
      cutPercent: 25,
      url: 'https://www.gog.com/game/baldurs_gate_iii',
      expiry: null,
      currency: 'USD',
      currencySymbol: '$',
    },
    storeBreakdown: {
      Steam: {
        shopName: 'Steam',
        salePrice: 47.99,
        regularPrice: 59.99,
        cutPercent: 20,
        url: 'https://store.steampowered.com/app/1086940/',
        expiry: null,
        currency: 'USD',
        currencySymbol: '$',
      },
      GOG: {
        shopName: 'GOG',
        salePrice: 44.99,
        regularPrice: 59.99,
        cutPercent: 25,
        url: 'https://www.gog.com/game/baldurs_gate_iii',
        expiry: null,
        currency: 'USD',
        currencySymbol: '$',
      },
    },
    alternativeCheckStatus: 'confirmed',
    alternativeCheckDegraded: false,
  };

  const mockDealBaldursGateBrl: GameDealInfo = {
    ...mockDealBaldursGate,
    allTimeLowPrice: 159.99,
    primaryDeal: {
      shopName: 'Steam',
      salePrice: 159.99,
      regularPrice: 199.99,
      cutPercent: 20,
      url: 'https://store.steampowered.com/app/1086940/',
      expiry: null,
      currency: 'BRL',
      currencySymbol: 'R$',
    },
    cheaperAlternative: {
      shopName: 'Nuuvem',
      salePrice: 149.99,
      regularPrice: 199.99,
      cutPercent: 25,
      url: 'https://www.nuuvem.com/item/baldurs-gate-3',
      expiry: null,
      currency: 'BRL',
      currencySymbol: 'R$',
    },
    storeBreakdown: {
      Steam: {
        shopName: 'Steam',
        salePrice: 159.99,
        regularPrice: 199.99,
        cutPercent: 20,
        url: 'https://store.steampowered.com/app/1086940/',
        expiry: null,
        currency: 'BRL',
        currencySymbol: 'R$',
      },
      Nuuvem: {
        shopName: 'Nuuvem',
        salePrice: 149.99,
        regularPrice: 199.99,
        cutPercent: 25,
        url: 'https://www.nuuvem.com/item/baldurs-gate-3',
        expiry: null,
        currency: 'BRL',
        currencySymbol: 'R$',
      },
    },
  };

  const mockTrendingRaw: SteamTrendingEntry[] = [
    {
      rank: 1,
      appId: 730,
      name: 'Counter-Strike 2',
      currentPlayers: 1250000,
      priceText: 'Free to Play',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/730/header.jpg',
    },
    {
      rank: 2,
      appId: 1091500,
      name: 'Cyberpunk 2077',
      currentPlayers: 54000,
      priceText: '$ 29.99 (-50%)',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
    },
    {
      rank: 3,
      appId: 1086940,
      name: "Baldur's Gate 3",
      currentPlayers: 82000,
      priceText: '$ 47.99 (-20%)',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
    },
    {
      rank: 4,
      appId: 570,
      name: 'Dota 2',
      currentPlayers: 650000,
      priceText: 'Free to Play',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/570/header.jpg',
    },
    {
      rank: 5,
      appId: 1245620,
      name: 'ELDEN RING',
      currentPlayers: 67000,
      priceText: '$ 35.99 (-40%)',
      headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
    },
  ];

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    process.env.TABLE_NAME = MOCK_TABLE;

    // Default mock implementation for getGameDealInfo
    vi.mocked(getGameDealInfo).mockImplementation(async (rawId, currency = 'USD') => {
      const cleanId = String(rawId).replace('steam:', '').trim();
      const isBrl = currency === 'BRL';

      if (cleanId === '1086940') {
        return isBrl ? mockDealBaldursGateBrl : mockDealBaldursGate;
      }

      const title = KNOWN_GAME_TITLES[cleanId] || `Steam Application ${cleanId}`;
      const sym = isBrl ? 'R$' : '$';
      const salePrice = isBrl ? 99.99 : 19.99;
      const regularPrice = isBrl ? 199.99 : 39.99;

      return {
        gameId: `steam_${cleanId}`,
        title,
        imageUrl: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cleanId}/header.jpg`,
        reviewScore: 85,
        steamAppId: cleanId,
        dealType: 'CURATED_DEAL',
        isAllTimeLow: false,
        allTimeLowPrice: salePrice,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice,
          regularPrice,
          cutPercent: 50,
          url: `https://store.steampowered.com/app/${cleanId}`,
          expiry: null,
          currency: isBrl ? 'BRL' : 'USD',
          currencySymbol: sym,
        },
        cheaperAlternative: null,
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice,
            regularPrice,
            cutPercent: 50,
            url: `https://store.steampowered.com/app/${cleanId}`,
            expiry: null,
            currency: isBrl ? 'BRL' : 'USD',
            currencySymbol: sym,
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
      };
    });

    // Default mock implementation for getSteamTrendingGames
    vi.mocked(getSteamTrendingGames).mockResolvedValue(mockTrendingRaw);

    // Default mock implementations for Steam Web utilities
    vi.mocked(resolveSteamId).mockImplementation(async (target) => {
      const trimmed = (target || '').trim();
      if (/^\d{17}$/.test(trimmed)) return trimmed;
      if (trimmed === 'zthigs') return '76561198327022168';
      if (trimmed.includes('76561198327022168')) return '76561198327022168';
      if (trimmed.includes('zthigs')) return '76561198327022168';
      return null;
    });

    vi.mocked(fetchSteamWishlist).mockResolvedValue({
      success: true,
      items: [
        { appId: '1086940', priority: 1, dateAdded: 1700000000 },
        { appId: '1091500', priority: 2, dateAdded: 1690000000 },
      ],
    });

    vi.mocked(batchFetchSteamAppPrices).mockResolvedValue(
      new Map([
        [
          1086940,
          {
            initial: 59.99,
            final: 47.99,
            isFree: false,
          },
        ],
        [
          1091500,
          {
            initial: 59.99,
            final: 29.99,
            isFree: false,
          },
        ],
      ]),
    );

    vi.mocked(resolveSteamAppTitles).mockResolvedValue(
      new Map([
        ['1086940', "Baldur's Gate 3"],
        ['1091500', 'Cyberpunk 2077'],
      ]),
    );

    vi.mocked(getPlayerLibraryDetailed).mockResolvedValue({
      isPrivate: false,
      gameCount: 3,
      games: [
        {
          appid: 1086940,
          name: "Baldur's Gate 3",
          playtime_forever: 0,
          img_icon_url: 'icon_bg3',
        },
        {
          appid: 1091500,
          name: 'Cyberpunk 2077',
          playtime_forever: 0,
          img_icon_url: 'icon_cp2077',
        },
        {
          appid: 1245620,
          name: 'ELDEN RING',
          playtime_forever: 3600,
          img_icon_url: 'icon_er',
        },
      ],
    });

    vi.mocked(getHowLongToBeatStats).mockImplementation(async (name) => {
      if (name.includes("Baldur's Gate")) {
        return {
          success: true,
          gameTitle: "Baldur's Gate 3",
          mainStoryHours: 75,
        };
      }
      if (name.includes('Cyberpunk')) {
        return {
          success: true,
          gameTitle: 'Cyberpunk 2077',
          mainStoryHours: 30,
        };
      }
      return { success: false, error: 'DATA_UNAVAILABLE' };
    });
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
    it('should return live structured market telemetry with multi-store deal intelligence', async () => {
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
      expect(data.title).toBe("Baldur's Gate 3");
      expect(data.imageUrl).toBe(
        'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
      );
      expect(data.steamAppId).toBe('1086940');
      expect(data.dealType).toBe('CURATED_DEAL');
      expect(data.reviewScore).toBe(96);

      // Primary deal (Steam)
      expect(data.primaryDeal).toBeDefined();
      expect(data.primaryDeal.shopName).toBe('Steam');
      expect(data.primaryDeal.salePrice).toBe(47.99);
      expect(data.primaryDeal.regularPrice).toBe(59.99);
      expect(data.primaryDeal.cutPercent).toBe(20);
      expect(data.primaryDeal.currency).toBe('USD');
      expect(data.primaryDeal.currencySymbol).toBe('$');

      // Alternative cheaper deal (GOG)
      expect(data.cheaperAlternative).toBeDefined();
      expect(data.cheaperAlternative.shopName).toBe('GOG');
      expect(data.cheaperAlternative.salePrice).toBe(44.99);
      expect(data.cheaperAlternative.cutPercent).toBe(25);

      // Multi-store breakdown
      expect(data.storeBreakdown).toBeDefined();
      expect(data.storeBreakdown.Steam).toBeDefined();
      expect(data.storeBreakdown.GOG).toBeDefined();
      expect(data.updatedAt).toBeDefined();

      expect(getGameDealInfo).toHaveBeenCalledWith('1086940', 'USD');
    });

    it('should support regional BRL currency parameter when provided', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/1086940',
        pathParameters: {
          appId: '1086940',
        },
        queryStringParameters: {
          currency: 'BRL',
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
      const data = JSON.parse(response.body);
      expect(data.primaryDeal.currency).toBe('BRL');
      expect(data.primaryDeal.currencySymbol).toBe('R$');
      expect(data.primaryDeal.salePrice).toBe(159.99);
      expect(data.cheaperAlternative?.shopName).toBe('Nuuvem');
      expect(data.cheaperAlternative?.salePrice).toBe(149.99);

      expect(getGameDealInfo).toHaveBeenCalledWith('1086940', 'BRL');
    });

    it('should extract appId from rawPath if pathParameters is missing', async () => {
      const event: HttpApiEvent = {
        rawPath: '/prod/public/market/1091500',
        requestContext: {
          http: {
            method: 'GET',
            path: '/prod/public/market/1091500',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.appId).toBe('1091500');
      expect(data.title).toBe('Cyberpunk 2077');
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

    it('should gracefully fallback to cached placeholder telemetry when deal lookup throws or times out', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(getGameDealInfo).mockRejectedValueOnce(new Error('ITAD API timeout'));

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
      const data = JSON.parse(response.body);
      expect(data.appId).toBe('1086940');
      expect(data.title).toBe("Baldur's Gate 3");
      expect(data.primaryDeal).toBeDefined();
      expect(data.primaryDeal.shopName).toBe('Steam');
      expect(data.imageUrl).toBe(
        'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
      );
      consoleSpy.mockRestore();
    });
  });

  describe('Route: GET /public/market', () => {
    it('should return 200 and an array of curated prominent games matching domain types', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market',
        rawPath: '/public/market',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(CURATED_MARKET_APP_IDS.length);

      const appIds = data.map((g: { appId: string }) => g.appId);
      expect(appIds).toContain('1091500'); // Cyberpunk 2077
      expect(appIds).toContain('1086940'); // Baldur's Gate 3
      expect(appIds).toContain('1245620'); // Elden Ring
      expect(appIds).toContain('292030'); // The Witcher 3

      expect(data[0].appId).toBeDefined();
      expect(data[0].primaryDeal).toBeDefined();
      expect(data[0].primaryDeal.shopName).toBe('Steam');
      expect(data[0].imageUrl).toContain('header.jpg');
    });

    it('should return filtered game array when appId query parameter is provided', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market',
        rawPath: '/public/market',
        queryStringParameters: {
          appId: '1091500',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].appId).toBe('1091500');
      expect(data[0].title).toBe('Cyberpunk 2077');
    });

    it('should support currency parameter for curated market list (?currency=BRL)', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market',
        rawPath: '/public/market',
        queryStringParameters: {
          currency: 'BRL',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].primaryDeal.currency).toBe('BRL');
      expect(data[0].primaryDeal.currencySymbol).toBe('R$');
    });

    it('should confirm USD is the strict global default currency when currency parameter is omitted or set to USD', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market',
        rawPath: '/public/market',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].primaryDeal.currency).toBe('USD');
      expect(data[0].primaryDeal.currencySymbol).toBe('$');
      expect(getGameDealInfo).toHaveBeenCalledWith(expect.any(String), 'USD');
    });

    it('should confirm USD default when unsupported currency code is supplied', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market',
        rawPath: '/public/market',
        queryStringParameters: {
          currency: 'EUR',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].primaryDeal.currency).toBe('USD');
      expect(data[0].primaryDeal.currencySymbol).toBe('$');
      expect(getGameDealInfo).toHaveBeenCalledWith(expect.any(String), 'USD');
    });
  });

  describe('Route: GET /public/market/trending', () => {
    it('should return 200 and an array of trending games excluding Free-to-Play titles', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/trending',
        rawPath: '/public/market/trending',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/trending',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(3); // CS2 and Dota 2 excluded from 5 items

      // Confirm F2P titles were filtered out
      const appIds = data.map((g: SteamTrendingEntry) => g.appId);
      expect(appIds).not.toContain(730); // CS2
      expect(appIds).not.toContain(570); // Dota 2

      // Verify sequential ranks starting at 1
      expect(data[0].rank).toBe(1);
      expect(data[0].appId).toBe(1091500); // Cyberpunk 2077
      expect(data[0].name).toBe('Cyberpunk 2077');
      expect(data[0].priceText).toBe('$ 29.99 (-50%)');

      expect(data[1].rank).toBe(2);
      expect(data[1].appId).toBe(1086940); // Baldur's Gate 3

      expect(data[2].rank).toBe(3);
      expect(data[2].appId).toBe(1245620); // ELDEN RING
    });

    it('should filter out Valve hardware and physical peripherals from trending games', async () => {
      const mockHardwareAndGames: SteamTrendingEntry[] = [
        {
          rank: 1,
          appId: 1675200,
          name: 'Steam Deck OLED',
          currentPlayers: null,
          priceText: '$ 549.00',
          headerImage: 'https://example.com/steam_deck.jpg',
        },
        {
          rank: 2,
          appId: 1091500,
          name: 'Cyberpunk 2077',
          currentPlayers: 54000,
          priceText: '$ 29.99 (-50%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
        },
        {
          rank: 3,
          appId: 1059530,
          name: 'Valve Index VR Kit',
          currentPlayers: null,
          priceText: '$ 999.00',
          headerImage: 'https://example.com/valve_index.jpg',
        },
        {
          rank: 4,
          appId: 353370,
          name: 'Steam Controller',
          currentPlayers: null,
          priceText: '$ 49.99',
          headerImage: 'https://example.com/controller.jpg',
        },
        {
          rank: 5,
          appId: 1086940,
          name: "Baldur's Gate 3",
          currentPlayers: 82000,
          priceText: '$ 47.99 (-20%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
        },
        {
          rank: 6,
          appId: 9999999,
          name: 'Steam Frame VR Headset',
          currentPlayers: null,
          priceText: '$ 799.00',
          headerImage: 'https://example.com/frame.jpg',
        },
        {
          rank: 7,
          appId: 1245620,
          name: 'ELDEN RING',
          currentPlayers: 67000,
          priceText: '$ 35.99 (-40%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
        },
      ];

      vi.mocked(getSteamTrendingGames).mockResolvedValueOnce(mockHardwareAndGames);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/trending',
        rawPath: '/public/market/trending',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/trending',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(3);

      const appIds = data.map((g: SteamTrendingEntry) => g.appId);
      expect(appIds).not.toContain(1675200);
      expect(appIds).not.toContain(1059530);
      expect(appIds).not.toContain(353370);
      expect(appIds).not.toContain(9999999);

      expect(data[0].rank).toBe(1);
      expect(data[0].name).toBe('Cyberpunk 2077');
      expect(data[1].rank).toBe(2);
      expect(data[1].name).toBe("Baldur's Gate 3");
      expect(data[2].rank).toBe(3);
      expect(data[2].name).toBe('ELDEN RING');
    });

    it('should strictly deduplicate items by appId and preserve sequential ranks', async () => {
      const mockDuplicates: SteamTrendingEntry[] = [
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
          appId: 1091500,
          name: 'Cyberpunk 2077 (Duplicate)',
          currentPlayers: 54000,
          priceText: '$ 29.99 (-50%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
        },
        {
          rank: 3,
          appId: 1086940,
          name: "Baldur's Gate 3",
          currentPlayers: 82000,
          priceText: '$ 47.99 (-20%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
        },
        {
          rank: 4,
          appId: 1091500,
          name: 'Cyberpunk 2077 (Triple)',
          currentPlayers: 54000,
          priceText: '$ 29.99 (-50%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
        },
        {
          rank: 5,
          appId: 1245620,
          name: 'ELDEN RING',
          currentPlayers: 67000,
          priceText: '$ 35.99 (-40%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
        },
        {
          rank: 6,
          appId: 1086940,
          name: "Baldur's Gate 3 (Duplicate)",
          currentPlayers: 82000,
          priceText: '$ 47.99 (-20%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
        },
      ];

      vi.mocked(getSteamTrendingGames).mockResolvedValueOnce(mockDuplicates);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/trending',
        rawPath: '/public/market/trending',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/trending',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(3);

      expect(data[0].rank).toBe(1);
      expect(data[0].appId).toBe(1091500);
      expect(data[1].rank).toBe(2);
      expect(data[1].appId).toBe(1086940);
      expect(data[2].rank).toBe(3);
      expect(data[2].appId).toBe(1245620);
    });

    it('should gracefully fallback to curated trending games if live probe fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(getSteamTrendingGames).mockRejectedValueOnce(new Error('Steam API unreachable'));

      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/trending',
        rawPath: '/public/market/trending',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/trending',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].rank).toBe(1);
      // Fallback list also does not contain F2P
      const appIds = data.map((g: SteamTrendingEntry) => g.appId);
      expect(appIds).not.toContain(730);
      consoleSpy.mockRestore();
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
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
      expect(data.message).toContain('non-existent-duel');
    });

    it('should return 204 with CORS headers on OPTIONS preflight request for duel endpoint', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'OPTIONS',
            path: '/public/duel/test-duel-123',
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
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      consoleSpy.mockRestore();
    });
  });

  describe('Route: GET /public/wishlist/{target}', () => {
    it('should successfully retrieve and enrich public wishlist telemetry using a numeric SteamID64', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

      const data = JSON.parse(response.body);
      expect(data.steamId).toBe('76561198327022168');
      expect(data.totalSteamWishlist).toBe(2);
      expect(data.currency).toBe('USD');
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items).toHaveLength(2);

      const firstItem = data.items[0];
      expect(firstItem.appId).toBe('1086940');
      expect(firstItem.title).toBe("Baldur's Gate 3");
      expect(firstItem.imageUrl).toContain('1086940');
      expect(firstItem.url).toBe('https://store.steampowered.com/app/1086940');
      expect(firstItem.store).toBe('Steam');
      expect(firstItem.currency).toBe('USD');
      expect(firstItem.currencySymbol).toBe('$');
      expect(firstItem.regularPrice).toBe(59.99);
      expect(firstItem.salePrice).toBe(47.99);
      expect(firstItem.discountPercent).toBe(20);
      expect(firstItem.isFree).toBe(false);
      expect(firstItem.primaryDeal).toBeDefined();
      expect(firstItem.primaryDeal.shopName).toBe('Steam');
    });

    it('should successfully resolve vanity username and return public wishlist telemetry', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/zthigs',
        pathParameters: {
          target: 'zthigs',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/zthigs',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.steamId).toBe('76561198327022168');
      expect(data.totalSteamWishlist).toBe(2);
    });

    it('should successfully resolve full profile URL and return wishlist telemetry', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/https%3A%2F%2Fsteamcommunity.com%2Fid%2Fzthigs',
        pathParameters: {
          target: 'https%3A%2F%2Fsteamcommunity.com%2Fid%2Fzthigs',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/https%3A%2F%2Fsteamcommunity.com%2Fid%2Fzthigs',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.steamId).toBe('76561198327022168');
    });

    it('should support regional BRL currency (?currency=BRL) across items and pricing', async () => {
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            1086940,
            {
              initial: 199.99,
              final: 159.99,
              isFree: false,
            },
          ],
        ]),
      );

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        queryStringParameters: {
          currency: 'BRL',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.currency).toBe('BRL');
      expect(data.items[0].currency).toBe('BRL');
      expect(data.items[0].currencySymbol).toBe('R$');
      expect(data.items[0].regularPrice).toBe(199.99);
      expect(data.items[0].salePrice).toBe(159.99);
      expect(vi.mocked(batchFetchSteamAppPrices)).toHaveBeenCalledWith(
        expect.any(Array),
        'br',
        100,
      );
    });

    it('should enrich top wishlist items with multi-store deal intelligence when available', async () => {
      vi.mocked(getGameDealInfo).mockResolvedValueOnce(mockDealBaldursGate);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      const bg3 = data.items[0];
      expect(bg3.cheaperAlternative).toBeDefined();
      expect(bg3.cheaperAlternative?.shopName).toBe('GOG');
      expect(bg3.storeBreakdown?.['GOG']).toBeDefined();
    });

    it('should return empty items array when wishlist is empty', async () => {
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.totalSteamWishlist).toBe(0);
      expect(data.items).toEqual([]);
    });

    it('should return 403 WishlistPrivate when Steam profile is private', async () => {
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: false,
        error: 'PRIVATE_OR_NOT_FOUND',
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(403);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      const data = JSON.parse(response.body);
      expect(data.error).toBe('WishlistPrivate');
      expect(data.message).toBe('This Steam profile is private or does not exist.');
    });

    it('should return 404 NotFound when target vanity cannot be resolved to a SteamID', async () => {
      vi.mocked(resolveSteamId).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/unknownuser999',
        pathParameters: {
          target: 'unknownuser999',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/unknownuser999',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(404);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
      expect(data.message).toContain('Unable to resolve Steam profile');
    });

    it('should return 400 BadRequest when target parameter is missing or whitespace', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/',
        pathParameters: {
          target: '   ',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 400 BadRequest when requesting base /public/wishlist without target', async () => {
      const event: HttpApiEvent = {
        rawPath: '/public/wishlist',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 500 ConfigurationError when Steam API key is missing', async () => {
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: false,
        error: 'CONFIG_REQUIRED',
      });

      const event: HttpApiEvent = {
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(500);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('ConfigurationError');
    });

    it('should return 502 UpstreamError when Steam API returns a network or server error', async () => {
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: false,
        error: 'FETCH_ERROR',
      });

      const event: HttpApiEvent = {
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(502);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UpstreamError');
    });

    it('should return 204 with CORS headers on OPTIONS preflight request to wishlist route', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'OPTIONS',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    });

    it('should cap target items to 100 while preserving totalSteamWishlist count when wishlist is large', async () => {
      const largeItems = Array.from({ length: 150 }, (_, i) => ({
        appId: String(200000 + i),
        priority: i + 1,
        dateAdded: 1700000000 - i * 1000,
      }));

      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: largeItems,
      });

      const event: HttpApiEvent = {
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/wishlist/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.totalSteamWishlist).toBe(150);
      expect(data.items).toHaveLength(100);
    });
  });

  describe('Route: GET /public/backlog/{target}', () => {
    it('should successfully retrieve and calculate backlog telemetry for numeric SteamID64', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

      const data = JSON.parse(response.body);
      expect(data.steamId).toBe('76561198327022168');
      expect(data.target).toBe('76561198327022168');
      expect(data.currency).toBe('USD');
      expect(data.currencySymbol).toBe('$');
      expect(data.totalGamesOwned).toBe(3);
      expect(data.unplayedCount).toBe(2);
      expect(data.unplayedRatioPercent).toBe(66.7);
      expect(data.totalBacklogValue).toBe(77.98);
      expect(data.totalBacklogValueFormatted).toBe('$ 77.98');
      expect(data.estimatedHoursToClear).toBe(105);
      expect(Array.isArray(data.unplayedItems)).toBe(true);
      expect(data.unplayedItems).toHaveLength(2);

      const firstItem = data.unplayedItems[0];
      expect(firstItem.appId).toBe(1086940);
      expect(firstItem.title).toBe("Baldur's Gate 3");
      expect(firstItem.playtimeForever).toBe(0);
      expect(firstItem.price).toBe(47.99);
      expect(firstItem.priceFormatted).toBe('$ 47.99');
      expect(firstItem.estimatedHours).toBe(75);
      expect(firstItem.imageUrl).toContain('1086940');
    });

    it('should resolve vanity username and calculate backlog metrics', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/zthigs',
        pathParameters: {
          target: 'zthigs',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/zthigs',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.steamId).toBe('76561198327022168');
      expect(data.target).toBe('zthigs');
      expect(data.unplayedCount).toBe(2);
    });

    it('should resolve full Steam profile URL', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/https%3A%2F%2Fsteamcommunity.com%2Fid%2Fzthigs',
        pathParameters: {
          target: 'https%3A%2F%2Fsteamcommunity.com%2Fid%2Fzthigs',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/https%3A%2F%2Fsteamcommunity.com%2Fid%2Fzthigs',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.steamId).toBe('76561198327022168');
      expect(data.target).toBe('zthigs');
    });

    it('should support regional BRL currency (?currency=BRL) with factual store data and pt-BR formatting', async () => {
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            1086940,
            {
              initial: 199.99,
              final: 159.99,
              isFree: false,
            },
          ],
          [
            1091500,
            {
              initial: 199.99,
              final: 99.99,
              isFree: false,
            },
          ],
        ]),
      );

      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        queryStringParameters: {
          currency: 'BRL',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.currency).toBe('BRL');
      expect(data.currencySymbol).toBe('R$');
      expect(data.totalBacklogValue).toBe(259.98);
      expect(data.totalBacklogValueFormatted).toBe('R$ 259,98');
      expect(data.unplayedItems[0].priceFormatted).toBe('R$ 159,99');
      expect(vi.mocked(batchFetchSteamAppPrices)).toHaveBeenCalledWith(
        expect.any(Array),
        'br',
        100,
      );
    });

    it('should handle 100% completed library with zero unplayed titles', async () => {
      vi.mocked(getPlayerLibraryDetailed).mockResolvedValueOnce({
        isPrivate: false,
        gameCount: 2,
        games: [
          { appid: 1086940, name: "Baldur's Gate 3", playtime_forever: 500, img_icon_url: null },
          { appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 1200, img_icon_url: null },
        ],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.unplayedCount).toBe(0);
      expect(data.unplayedRatioPercent).toBe(0);
      expect(data.totalBacklogValue).toBe(0);
      expect(data.totalBacklogValueFormatted).toBe('$ 0.00');
      expect(data.estimatedHoursToClear).toBe(0);
      expect(data.unplayedItems).toEqual([]);
    });

    it('should return 403 LibraryPrivate when Steam library is set to private', async () => {
      vi.mocked(getPlayerLibraryDetailed).mockResolvedValueOnce({
        isPrivate: true,
        gameCount: 0,
        games: [],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(403);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      const data = JSON.parse(response.body);
      expect(data.error).toBe('LibraryPrivate');
      expect(data.message).toBe('This Steam library is private or does not exist.');
    });

    it('should return 404 NotFound when target vanity cannot be resolved', async () => {
      vi.mocked(resolveSteamId).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/unknownuser999',
        pathParameters: {
          target: 'unknownuser999',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/unknownuser999',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(404);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
      expect(data.message).toContain('Unable to resolve Steam profile');
    });

    it('should return 400 BadRequest when target parameter is missing or whitespace', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/backlog/{target}',
        rawPath: '/public/backlog/',
        pathParameters: {
          target: '   ',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 400 BadRequest when base /public/backlog route is accessed without target', async () => {
      const event: HttpApiEvent = {
        rawPath: '/public/backlog',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 502 UpstreamError when Steam API fails to return library data', async () => {
      vi.mocked(getPlayerLibraryDetailed).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(502);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UpstreamError');
    });

    it('should return 204 with CORS headers on OPTIONS preflight request to backlog route', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'OPTIONS',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    });

    it('should cap unplayedItems at 100 titles while reflecting total unplayedCount', async () => {
      const largeGames = Array.from({ length: 150 }, (_, i) => ({
        appid: 300000 + i,
        name: `Backlog Game ${i}`,
        playtime_forever: 0,
        img_icon_url: null,
      }));

      vi.mocked(getPlayerLibraryDetailed).mockResolvedValueOnce({
        isPrivate: false,
        gameCount: 150,
        games: largeGames,
      });

      const event: HttpApiEvent = {
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/backlog/76561198327022168',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.unplayedCount).toBe(150);
      expect(data.unplayedItems).toHaveLength(100);
    });

    it('should format currency correctly via formatCurrency helper', () => {
      expect(formatCurrency(4520.5, 'BRL')).toBe('R$ 4.520,50');
      expect(formatCurrency(4520.5, 'USD')).toBe('$ 4,520.50');
      expect(formatCurrency(0, 'BRL')).toBe('R$ 0,00');
      expect(formatCurrency(0, 'USD')).toBe('$ 0.00');
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
