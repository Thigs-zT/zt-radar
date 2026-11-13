import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
    getPlayerSummary: vi.fn(),
    getPlayerSummaries: vi.fn(),
    getSteamFriendList: vi.fn(),
    getOwnedGames: vi.fn(),
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
  resolveDossierTelemetry,
  computeGamerArchetype,
  buildDossierTimeStream,
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
  getPlayerSummary,
  getPlayerSummaries,
  getSteamFriendList,
  getOwnedGames,
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
      const sym = isBrl ? 'R$' : '$';

      if (cleanId === '1086940') {
        return isBrl ? mockDealBaldursGateBrl : mockDealBaldursGate;
      }

      if (cleanId === '1091500') {
        return {
          gameId: 'steam_1091500',
          title: 'Cyberpunk 2077',
          imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
          reviewScore: 86,
          steamAppId: '1091500',
          dealType: 'CURATED_DEAL',
          isAllTimeLow: true,
          allTimeLowPrice: isBrl ? 99.95 : 29.99,
          expiry: null,
          primaryDeal: {
            shopName: 'Steam',
            salePrice: isBrl ? 99.95 : 29.99,
            regularPrice: isBrl ? 199.90 : 59.99,
            cutPercent: 50,
            url: 'https://store.steampowered.com/app/1091500',
            expiry: null,
            currency: isBrl ? 'BRL' : 'USD',
            currencySymbol: sym,
          },
          cheaperAlternative: null,
          storeBreakdown: {
            Steam: {
              shopName: 'Steam',
              salePrice: isBrl ? 99.95 : 29.99,
              regularPrice: isBrl ? 199.90 : 59.99,
              cutPercent: 50,
              url: 'https://store.steampowered.com/app/1091500',
              expiry: null,
              currency: isBrl ? 'BRL' : 'USD',
              currencySymbol: sym,
            },
          },
          alternativeCheckStatus: 'confirmed',
          alternativeCheckDegraded: false,
        };
      }

      const title = KNOWN_GAME_TITLES[cleanId] || `Steam Application ${cleanId}`;
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

    vi.mocked(getPlayerSummary).mockResolvedValue({
      steamId: '76561198327022168',
      personaName: 'zThigs',
      profileUrl: 'https://steamcommunity.com/profiles/76561198327022168',
      avatarUrl: 'https://cdn/avatar.jpg',
      visibilityState: 3,
      isPrivate: false,
      personaState: 1,
      personaStateLabel: 'Online',
      currentlyPlaying: null,
      currentlyPlayingId: null,
      timeCreated: '2020-05-10',
      timeCreatedTimestamp: 1589068800,
      countryCode: 'BR',
      realName: null,
    });

    vi.mocked(getOwnedGames).mockResolvedValue({
      isPrivate: false,
      gameCount: 3,
      games: [
        {
          appId: 1086940,
          appid: 1086940,
          name: "Baldur's Gate 3",
          playtime_forever: 6000,
          rtime_last_played: 1735689600,
          img_icon_url: 'icon_bg3',
        },
        {
          appId: 1245620,
          appid: 1245620,
          name: 'ELDEN RING',
          playtime_forever: 3600,
          rtime_last_played: 1704067200,
          img_icon_url: 'icon_er',
        },
        {
          appId: 1091500,
          appid: 1091500,
          name: 'Cyberpunk 2077',
          playtime_forever: 0,
          rtime_last_played: 0,
          img_icon_url: 'icon_cp2077',
        },
      ],
    });

    vi.mocked(getSteamFriendList).mockResolvedValue({
      success: true,
      friends: [
        { steamId: '76561198000000003', relationship: 'friend', friendSince: 1650000000 },
        { steamId: '76561198000000001', relationship: 'friend', friendSince: 1600000000 },
        { steamId: '76561198000000002', relationship: 'friend', friendSince: 1620000000 },
      ],
    });

    vi.mocked(getPlayerSummaries).mockResolvedValue([
      {
        steamId: '76561198000000003',
        personaName: 'Zelda',
        profileUrl: 'https://steamcommunity.com/profiles/76561198000000003',
        avatarUrl: 'https://avatars.steamstatic.com/zelda_full.jpg',
        visibilityState: 3,
        isPrivate: false,
        personaState: 1,
        personaStateLabel: 'Online',
        currentlyPlaying: null,
        currentlyPlayingId: null,
        timeCreated: null,
        countryCode: null,
        realName: null,
      },
      {
        steamId: '76561198000000001',
        personaName: 'alice',
        profileUrl: 'https://steamcommunity.com/id/alice',
        avatarUrl: 'https://avatars.steamstatic.com/alice_full.jpg',
        visibilityState: 3,
        isPrivate: false,
        personaState: 0,
        personaStateLabel: 'Offline',
        currentlyPlaying: null,
        currentlyPlayingId: null,
        timeCreated: null,
        countryCode: null,
        realName: null,
      },
      {
        steamId: '76561198000000002',
        personaName: 'Bob',
        profileUrl: 'https://steamcommunity.com/id/bob',
        avatarUrl: 'https://avatars.steamstatic.com/bob_medium.jpg',
        visibilityState: 3,
        isPrivate: false,
        personaState: 1,
        personaStateLabel: 'Online',
        currentlyPlaying: null,
        currentlyPlayingId: null,
        timeCreated: null,
        countryCode: null,
        realName: null,
      },
    ]);
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

      expect(getGameDealInfo).toHaveBeenCalledWith('1086940', 'USD', "Baldur's Gate 3");
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

      expect(getGameDealInfo).toHaveBeenCalledWith('1086940', 'BRL', "Baldur's Gate 3");
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
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
      );
      consoleSpy.mockRestore();
    });

    it('should return cached multi-store telemetry immediately from DynamoDB when fresh cache exists', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cachedTelemetry = {
        PK: 'MARKET#v5#1086940#USD',
        SK: 'TELEMETRY',
        appId: '1086940',
        gameId: 'steam_1086940',
        title: "Baldur's Gate 3",
        imageUrl: 'https://example.com/cached-bg3.jpg',
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
        ttl: nowSec + 1800,
        updatedAt: new Date().toISOString(),
      };

      ddbMock.on(QueryCommand).resolves({
        Items: [cachedTelemetry],
      });

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
      expect(data.title).toBe("Baldur's Gate 3");
      expect(data.imageUrl).toBe('https://example.com/cached-bg3.jpg');
      expect(data.storeBreakdown.Steam).toBeDefined();
      expect(data.storeBreakdown.GOG).toBeDefined();
      expect(data.alternativeCheckDegraded).toBe(false);

      // Verify getGameDealInfo was NOT invoked due to instant cache hit
      expect(getGameDealInfo).not.toHaveBeenCalled();
    });

    it('should bypass cache and fetch live data when cached record is degraded', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const degradedCached = {
        PK: 'MARKET#v5#1086940#USD',
        SK: 'TELEMETRY',
        appId: '1086940',
        title: "Baldur's Gate 3 (Degraded)",
        storeBreakdown: {
          Steam: { shopName: 'Steam', salePrice: 59.99, regularPrice: 59.99, cutPercent: 0, url: '', expiry: null, currency: 'USD', currencySymbol: '$' },
        },
        alternativeCheckStatus: 'degraded',
        alternativeCheckDegraded: true,
        ttl: nowSec + 1800,
      };

      ddbMock.on(QueryCommand).resolves({
        Items: [degradedCached],
      });

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
      // Verify getGameDealInfo WAS called to heal degraded cache
      expect(getGameDealInfo).toHaveBeenCalledWith('1086940', 'USD', "Baldur's Gate 3");
    });

    it('should bypass cache and fetch live data when cached record has only 1 store and is not platform exclusive', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const singleStoreCached = {
        PK: 'MARKET#v5#1086940#USD',
        SK: 'TELEMETRY',
        appId: '1086940',
        title: "Baldur's Gate 3 (Single Store Poisoned)",
        storeBreakdown: {
          Steam: { shopName: 'Steam', salePrice: 59.99, regularPrice: 59.99, cutPercent: 0, url: '', expiry: null, currency: 'USD', currencySymbol: '$' },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false, // Poisoned: marked false despite only 1 store
        isPlatformExclusive: false,
        ttl: nowSec + 1800,
      };

      ddbMock.on(QueryCommand).resolves({
        Items: [singleStoreCached],
      });

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
      // Verify getGameDealInfo WAS called because single-store non-exclusive was rejected
      expect(getGameDealInfo).toHaveBeenCalledWith('1086940', 'USD', "Baldur's Gate 3");
    });

    it('should persist live telemetry to DynamoDB cache when alternativeCheckDegraded is false with 86400s TTL', async () => {
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
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThanOrEqual(1);

      const marketPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#1086940#USD');
      expect(marketPut).toBeDefined();
      expect(marketPut?.args[0].input.Item?.SK).toBe('TELEMETRY');
      expect(marketPut?.args[0].input.Item?.alternativeCheckDegraded).toBe(false);
      // Verify 24-hour TTL (86400 seconds) for verified multi-store telemetry
      const nowSec = Math.floor(Date.now() / 1000);
      expect(marketPut?.args[0].input.Item?.ttl).toBeGreaterThanOrEqual(nowSec + 86300);
      expect(marketPut?.args[0].input.Item?.ttl).toBeLessThanOrEqual(nowSec + 86500);
    });

    it('should accept optional title query parameter and pass it into getGameDealInfo', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/1449690',
        pathParameters: {
          appId: '1449690',
        },
        queryStringParameters: {
          title: 'The Walking Dead Custom Title',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/1449690',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(getGameDealInfo).toHaveBeenCalledWith(
        '1449690',
        'USD',
        'The Walking Dead Custom Title',
      );
    });

    it('should NOT cache degraded live telemetry in DynamoDB when alternativeCheckDegraded is true', async () => {
      vi.mocked(getGameDealInfo).mockResolvedValueOnce({
        ...mockDealBaldursGate,
        alternativeCheckStatus: 'degraded',
        alternativeCheckDegraded: true,
      });

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
      const putCalls = ddbMock.commandCalls(PutCommand);
      const marketPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#1086940#USD');
      expect(marketPut).toBeUndefined();
    });

    it('should NOT cache Steam-only fallback (0 partner deals) in DynamoDB even if isPlatformExclusive is true', async () => {
      vi.mocked(getGameDealInfo).mockResolvedValueOnce({
        gameId: 'steam_1029690',
        title: 'Sniper Elite 5',
        imageUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1029690/header.jpg',
        reviewScore: 81,
        steamAppId: '1029690',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: false,
        allTimeLowPrice: null,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 49.99,
          regularPrice: 49.99,
          cutPercent: 0,
          url: 'https://store.steampowered.com/app/1029690/',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        cheaperAlternative: null,
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 49.99,
            regularPrice: 49.99,
            cutPercent: 0,
            url: 'https://store.steampowered.com/app/1029690/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
        isPlatformExclusive: true,
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/1029690',
        pathParameters: {
          appId: '1029690',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/1029690',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.appId).toBe('1029690');
      expect(data.primaryDeal.shopName).toBe('Steam');
      expect(data.primaryDeal.salePrice).toBe(49.99);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const marketPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#1029690#USD');
      expect(marketPut).toBeUndefined();
    });

    it('should bypass stale Steam-only cache record even if marked isPlatformExclusive and heal via live lookup', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const poisonedSteamOnlyCached = {
        PK: 'MARKET#v5#1029690#USD',
        SK: 'TELEMETRY',
        appId: '1029690',
        title: 'Sniper Elite 5',
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 49.99,
            regularPrice: 49.99,
            cutPercent: 0,
            url: 'https://store.steampowered.com/app/1029690/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
        isPlatformExclusive: true,
        ttl: nowSec + 86400,
      };

      ddbMock.on(QueryCommand).resolves({
        Items: [poisonedSteamOnlyCached],
      });

      vi.mocked(getGameDealInfo).mockResolvedValueOnce({
        gameId: 'steam_1029690',
        title: 'Sniper Elite 5',
        imageUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1029690/header.jpg',
        reviewScore: 81,
        steamAppId: '1029690',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        allTimeLowPrice: 9.99,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 49.99,
          regularPrice: 49.99,
          cutPercent: 0,
          url: 'https://store.steampowered.com/app/1029690/',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        cheaperAlternative: {
          shopName: 'Epic Games Store',
          salePrice: 9.99,
          regularPrice: 49.99,
          cutPercent: 80,
          url: 'https://store.epicgames.com/p/sniper-elite-5',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 49.99,
            regularPrice: 49.99,
            cutPercent: 0,
            url: 'https://store.steampowered.com/app/1029690/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          'Epic Games Store': {
            shopName: 'Epic Games Store',
            salePrice: 9.99,
            regularPrice: 49.99,
            cutPercent: 80,
            url: 'https://store.epicgames.com/p/sniper-elite-5',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/1029690',
        pathParameters: {
          appId: '1029690',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/1029690',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.cheaperAlternative?.shopName).toBe('Epic Games Store');
      expect(data.cheaperAlternative?.salePrice).toBe(9.99);
      expect(getGameDealInfo).toHaveBeenCalledWith('1029690', 'USD', null);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const healedPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#1029690#USD');
      expect(healedPut).toBeDefined();
      expect(healedPut?.args[0].input.Item?.ttl).toBeGreaterThanOrEqual(nowSec + 86300);
    });

    it('should trigger fast graceful fallback without caching when deal lookup stalls beyond timeout', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        vi.mocked(getGameDealInfo).mockImplementationOnce(() => new Promise(() => {}));

        const event: HttpApiEvent = {
          routeKey: 'GET /public/market/{appId}',
          rawPath: '/public/market/1029690',
          pathParameters: {
            appId: '1029690',
          },
          queryStringParameters: {
            title: 'Sniper Elite 5',
          },
          requestContext: {
            http: {
              method: 'GET',
              path: '/public/market/1029690',
            },
          },
        };

        const responsePromise = handler(event);
        await vi.advanceTimersByTimeAsync(2600);
        const response = await responsePromise;

        expect(response.statusCode).toBe(200);
        const data = JSON.parse(response.body);
        expect(data.appId).toBe('1029690');
        expect(data.title).toBe('Sniper Elite 5');
        expect(data.primaryDeal?.shopName).toBe('Steam');

        const putCalls = ddbMock.commandCalls(PutCommand);
        const marketPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#1029690#USD');
        expect(marketPut).toBeUndefined();
      } finally {
        vi.useRealTimers();
        warnSpy.mockRestore();
      }
    });

    it('should preserve authoritative Steam price and avoid negative caching when ITAD returns degraded fallback', async () => {
      vi.mocked(getGameDealInfo).mockResolvedValueOnce({
        gameId: 'steam_489830',
        title: 'The Elder Scrolls V: Skyrim Special Edition',
        imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/489830/header.jpg',
        reviewScore: 94,
        steamAppId: '489830',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: false,
        allTimeLowPrice: null,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 13.19,
          regularPrice: 39.99,
          cutPercent: 67,
          url: 'https://store.steampowered.com/app/489830/',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        cheaperAlternative: null,
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 13.19,
            regularPrice: 39.99,
            cutPercent: 67,
            url: 'https://store.steampowered.com/app/489830/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'degraded',
        alternativeCheckDegraded: true,
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/489830',
        pathParameters: {
          appId: '489830',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/489830',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.appId).toBe('489830');
      expect(data.title).toBe('The Elder Scrolls V: Skyrim Special Edition');
      expect(data.primaryDeal?.shopName).toBe('Steam');
      expect(data.primaryDeal?.salePrice).toBe(13.19);
      expect(data.primaryDeal?.regularPrice).toBe(39.99);
      expect(data.primaryDeal?.cutPercent).toBe(67);
      expect(data.storeBreakdown?.Steam?.salePrice).toBe(13.19);
      expect(data.alternativeCheckDegraded).toBe(true);
      expect(data.alternativeCheckStatus).toBe('degraded');

      const putCalls = ddbMock.commandCalls(PutCommand);
      const marketPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#489830#USD');
      expect(marketPut).toBeUndefined();
    });

    it('should forward priceHistory and allTimeLowPrice into GET /public/market/{appId}, persist to DynamoDB, and restore from cache', async () => {
      const sampleHistory = [
        {
          timestamp: '2024-05-01T12:00:00.000Z',
          shopId: 'steam',
          shopName: 'Steam',
          priceUsd: 59.99,
          priceBrl: null,
          price: 59.99,
          regularPrice: 59.99,
          cutPercent: 0,
          isAllTimeLow: false,
        },
        {
          timestamp: '2024-11-28T12:00:00.000Z',
          shopId: 'gog',
          shopName: 'GOG',
          priceUsd: 44.99,
          priceBrl: null,
          price: 44.99,
          regularPrice: 59.99,
          cutPercent: 25,
          isAllTimeLow: true,
        },
      ];

      vi.mocked(getGameDealInfo).mockResolvedValueOnce({
        ...mockDealBaldursGate,
        allTimeLowPrice: 44.99,
        priceHistory: sampleHistory,
      });

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

      const liveResponse = await handler(event);
      expect(liveResponse.statusCode).toBe(200);

      const liveData = JSON.parse(liveResponse.body);
      expect(liveData.allTimeLowPrice).toBe(44.99);
      expect(liveData.priceHistory).toEqual(sampleHistory);

      // Verify DynamoDB PutCommand persisted priceHistory and allTimeLowPrice alongside storeBreakdown
      const putCalls = ddbMock.commandCalls(PutCommand);
      const marketPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#v5#1086940#USD');
      expect(marketPut).toBeDefined();
      expect(marketPut?.args[0].input.Item?.allTimeLowPrice).toBe(44.99);
      expect(marketPut?.args[0].input.Item?.priceHistory).toEqual(sampleHistory);

      // Verify subsequent cache hit restores priceHistory and allTimeLowPrice without calling getGameDealInfo
      vi.mocked(getGameDealInfo).mockClear();
      ddbMock.on(QueryCommand).resolves({
        Items: marketPut?.args[0].input.Item ? [marketPut.args[0].input.Item] : [],
      });

      const cachedResponse = await handler(event);
      expect(cachedResponse.statusCode).toBe(200);
      const cachedData = JSON.parse(cachedResponse.body);
      expect(cachedData.allTimeLowPrice).toBe(44.99);
      expect(cachedData.priceHistory).toEqual(sampleHistory);
      expect(getGameDealInfo).not.toHaveBeenCalled();
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
      expect(getGameDealInfo).toHaveBeenCalledWith(expect.any(String), 'USD', expect.anything());
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
      expect(getGameDealInfo).toHaveBeenCalledWith(expect.any(String), 'USD', expect.anything());
    });

    it('should search Steam Storefront API and return matched game telemetry when q parameter is provided', async () => {
      const originalFetch = globalThis.fetch;
      const capturedUrls: string[] = [];
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        capturedUrls.push(urlStr);
        if (urlStr.includes('store.steampowered.com/api/storesearch')) {
          return {
            ok: true,
            json: async () => ({
              total: 1,
              items: [{ id: 292030, name: 'The Witcher 3: Wild Hunt — Remastered', type: 'app' }],
            }),
          } as Response;
        }
        return originalFetch(url);
      });

      try {
        const event: HttpApiEvent = {
          routeKey: 'GET /public/market',
          rawPath: '/public/market',
          queryStringParameters: {
            q: 'witcher 3',
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
        expect(data[0].appId).toBe('292030');

        const searchCall = capturedUrls.find((u) => u.includes('api/storesearch'));
        expect(searchCall).toBeDefined();
        expect(searchCall).toContain('term=witcher%203');
        expect(searchCall).toContain('cc=us');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should route country=br to Steam Storefront API when q and currency=BRL are provided', async () => {
      const originalFetch = globalThis.fetch;
      const capturedUrls: string[] = [];
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        capturedUrls.push(urlStr);
        if (urlStr.includes('store.steampowered.com/api/storesearch')) {
          return {
            ok: true,
            json: async () => ({
              total: 1,
              items: [{ id: 1091500, name: 'Cyberpunk 2077', type: 'app' }],
            }),
          } as Response;
        }
        return originalFetch(url);
      });

      try {
        const event: HttpApiEvent = {
          routeKey: 'GET /public/market',
          rawPath: '/public/market',
          queryStringParameters: {
            q: 'cyberpunk',
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
        expect(data[0].appId).toBe('1091500');

        const searchCall = capturedUrls.find((u) => u.includes('api/storesearch'));
        expect(searchCall).toBeDefined();
        expect(searchCall).toContain('cc=br');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return empty array when live search q yields no matching items', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/storesearch')) {
          return {
            ok: true,
            json: async () => ({
              total: 0,
              items: [],
            }),
          } as Response;
        }
        return originalFetch(url);
      });

      try {
        const event: HttpApiEvent = {
          routeKey: 'GET /public/market',
          rawPath: '/public/market',
          queryStringParameters: {
            q: 'nonexistentgamexyz',
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
        expect(data.length).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should prioritize exact case-insensitive title match over fuzzy top matches when q parameter is provided', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/storesearch')) {
          return {
            ok: true,
            json: async () => ({
              total: 2,
              items: [
                { id: 1145350, name: 'Hades II', type: 'app' },
                { id: 1145360, name: 'Hades', type: 'app' },
              ],
            }),
          } as Response;
        }
        return originalFetch(url);
      });

      try {
        const event: HttpApiEvent = {
          routeKey: 'GET /public/market',
          rawPath: '/public/market',
          queryStringParameters: {
            q: 'hades',
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
        expect(data.length).toBe(2);
        expect(data[0].appId).toBe('1145360');
        expect(data[1].appId).toBe('1145350');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return up to 6 matching results from Steam Store search when multiple games match query', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/storesearch')) {
          return {
            ok: true,
            json: async () => ({
              total: 8,
              items: [
                { id: 101, name: 'ELDEN RING Shadow of the Erdtree', type: 'app' },
                { id: 1245620, name: 'ELDEN RING', type: 'app' },
                { id: 102, name: 'ELDEN RING NIGHTREIGN', type: 'app' },
                { id: 103, name: 'ELDEN RING Deluxe Edition', type: 'app' },
                { id: 104, name: 'ELDEN RING Soundtrack', type: 'app' },
                { id: 105, name: 'ELDEN RING Artbook', type: 'app' },
                { id: 106, name: 'ELDEN RING Extra 1', type: 'app' },
                { id: 107, name: 'ELDEN RING Extra 2', type: 'app' },
              ],
            }),
          } as Response;
        }
        return originalFetch(url);
      });

      try {
        const event: HttpApiEvent = {
          routeKey: 'GET /public/market',
          rawPath: '/public/market',
          queryStringParameters: {
            q: 'elden ring',
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
        expect(data.length).toBe(6);
        // Exact match comes first
        expect(data[0].appId).toBe('1245620');
        expect(data[0].title).toBe('ELDEN RING');
        // Other matches follow
        expect(data[1].appId).toBe('101');
        expect(data[2].appId).toBe('102');
      } finally {
        globalThis.fetch = originalFetch;
      }
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
      expect(data.length).toBeGreaterThanOrEqual(6);
      expect(data.length).toBeLessThanOrEqual(16);

      // Confirm F2P titles were filtered out
      const appIds = data.map((g: SteamTrendingEntry) => g.appId);
      expect(appIds).not.toContain(730); // CS2
      expect(appIds).not.toContain(570); // Dota 2

      // Verify sequential ranks starting at 1
      data.forEach((entry: SteamTrendingEntry, idx: number) => {
        expect(entry.rank).toBe(idx + 1);
      });
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
      expect(data.length).toBeGreaterThanOrEqual(6);
      expect(data.length).toBeLessThanOrEqual(16);

      const appIds = data.map((g: SteamTrendingEntry) => g.appId);
      expect(appIds).not.toContain(1675200);
      expect(appIds).not.toContain(1059530);
      expect(appIds).not.toContain(353370);
      expect(appIds).not.toContain(9999999);

      data.forEach((entry: SteamTrendingEntry, idx: number) => {
        expect(entry.rank).toBe(idx + 1);
      });
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
      expect(data.length).toBeGreaterThanOrEqual(6);
      expect(data.length).toBeLessThanOrEqual(16);

      data.forEach((entry: SteamTrendingEntry, idx: number) => {
        expect(entry.rank).toBe(idx + 1);
      });
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

    it('should route currency=BRL to getSteamTrendingGames when currency=BRL is provided', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/market/trending',
        rawPath: '/public/market/trending',
        queryStringParameters: {
          currency: 'BRL',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/trending',
          },
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(getSteamTrendingGames).toHaveBeenCalledWith(50, 'BRL');
    });

    it('should serve trending telemetry immediately from DynamoDB cache when fresh cache exists', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cachedTrending: SteamTrendingEntry[] = [
        { rank: 1, appId: 1091500, name: 'Cyberpunk 2077', currentPlayers: 54000, priceText: '$ 29.99 (-50%)', headerImage: 'https://example.com/cp.jpg' },
        { rank: 2, appId: 1086940, name: "Baldur's Gate 3", currentPlayers: 82000, priceText: '$ 47.99 (-20%)', headerImage: 'https://example.com/bg.jpg' },
        { rank: 3, appId: 1245620, name: 'ELDEN RING', currentPlayers: 67000, priceText: '$ 35.99 (-40%)', headerImage: 'https://example.com/er.jpg' },
        { rank: 4, appId: 292030, name: 'The Witcher 3: Wild Hunt', currentPlayers: 31000, priceText: '$ 9.99 (-75%)', headerImage: 'https://example.com/w3.jpg' },
        { rank: 5, appId: 582010, name: 'MONSTER HUNTER: WORLD', currentPlayers: 28000, priceText: '$ 14.99 (-50%)', headerImage: 'https://example.com/mhw.jpg' },
        { rank: 6, appId: 1174180, name: 'Red Dead Redemption 2', currentPlayers: 39000, priceText: '$ 19.79 (-67%)', headerImage: 'https://example.com/rdr2.jpg' },
      ];

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: 'MARKET#TRENDING#USD',
            SK: 'TELEMETRY',
            items: cachedTrending,
            ttl: nowSec + 900,
          },
        ],
      });

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
      expect(data.length).toBe(6);
      expect(data[0].name).toBe('Cyberpunk 2077');
      expect(data[0].headerImage).toBe('https://example.com/cp.jpg');

      // Verify getSteamTrendingGames was NOT called due to instant cache hit
      expect(getSteamTrendingGames).not.toHaveBeenCalled();
    });

    it('should persist fresh trending games to DynamoDB with 15-minute TTL on cache miss', async () => {
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
      const putCalls = ddbMock.commandCalls(PutCommand);
      const trendingPut = putCalls.find((call) => call.args[0].input.Item?.PK === 'MARKET#TRENDING#USD');
      expect(trendingPut).toBeDefined();
      expect(trendingPut?.args[0].input.Item?.SK).toBe('TELEMETRY');
      expect(Array.isArray(trendingPut?.args[0].input.Item?.items)).toBe(true);
      expect(trendingPut?.args[0].input.Item?.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should enrich trending games with multi-store ITAD deal intelligence, lowest storefront, and accurate flags', async () => {
      // Mock game where Steam is full price ($59.99, 0% cut) but Nuuvem has 15% discount ($50.99)
      const mockNuuvemCheaperDeal: GameDealInfo = {
        gameId: 'steam_999001',
        title: 'Action RPG Hit',
        imageUrl: 'https://example.com/action.jpg',
        reviewScore: 90,
        steamAppId: '999001',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        allTimeLowPrice: 50.99,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 59.99,
          regularPrice: 59.99,
          cutPercent: 0,
          url: 'https://store.steampowered.com/app/999001/',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        cheaperAlternative: {
          shopName: 'Nuuvem',
          salePrice: 50.99,
          regularPrice: 59.99,
          cutPercent: 15,
          url: 'https://www.nuuvem.com/item/action-rpg-hit',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 59.99,
            regularPrice: 59.99,
            cutPercent: 0,
            url: 'https://store.steampowered.com/app/999001/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          Nuuvem: {
            shopName: 'Nuuvem',
            salePrice: 50.99,
            regularPrice: 59.99,
            cutPercent: 15,
            url: 'https://www.nuuvem.com/item/action-rpg-hit',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
      };

      vi.mocked(getSteamTrendingGames).mockResolvedValueOnce([
        {
          rank: 1,
          appId: 999001,
          name: 'Action RPG Hit',
          currentPlayers: 45000,
          priceText: '$ 59.99',
          headerImage: 'https://example.com/action.jpg',
        },
      ]);

      vi.mocked(getGameDealInfo).mockImplementation(async (rawId): Promise<GameDealInfo | null> => {
        if (String(rawId).includes('999001')) {
          return mockNuuvemCheaperDeal;
        }
        return null;
      });

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
      expect(data.length).toBe(16);

      // Verify the first game was enriched with Nuuvem offer
      const enrichedGame = data[0];
      expect(enrichedGame.appId).toBe(999001);
      expect(enrichedGame.bestStore).toBe('nuuvem');
      expect(enrichedGame.cutPercent).toBe(15);
      expect(enrichedGame.bestPriceUsd).toBe(50.99);
      expect(enrichedGame.priceText).toBe('$ 50.99 (-15%)');
      expect(enrichedGame.isATL).toBe(true);
      expect(enrichedGame.dealUrl).toBe('https://www.nuuvem.com/item/action-rpg-hit');
    });

    it('should pre-check MARKET#v5 per-game cache during trending resolution and skip live ITAD calls for cached titles', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cachedSkyrimTelemetry = {
        PK: 'MARKET#v5#489830#USD',
        SK: 'TELEMETRY',
        appId: '489830',
        gameId: 'steam_489830',
        title: 'The Elder Scrolls V: Skyrim Special Edition',
        imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/489830/header.jpg',
        reviewScore: 94,
        steamAppId: '489830',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        allTimeLowPrice: 9.99,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 13.19,
          regularPrice: 39.99,
          cutPercent: 67,
          url: 'https://store.steampowered.com/app/489830/',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        cheaperAlternative: {
          shopName: 'Nuuvem',
          salePrice: 9.99,
          regularPrice: 39.99,
          cutPercent: 75,
          url: 'https://www.nuuvem.com/item/the-elder-scrolls-v-skyrim-special-edition',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 13.19,
            regularPrice: 39.99,
            cutPercent: 67,
            url: 'https://store.steampowered.com/app/489830/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          Nuuvem: {
            shopName: 'Nuuvem',
            salePrice: 9.99,
            regularPrice: 39.99,
            cutPercent: 75,
            url: 'https://www.nuuvem.com/item/the-elder-scrolls-v-skyrim-special-edition',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          GOG: {
            shopName: 'GOG',
            salePrice: 11.99,
            regularPrice: 39.99,
            cutPercent: 70,
            url: 'https://www.gog.com/game/the_elder_scrolls_v_skyrim_special_edition',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          'Epic Games Store': {
            shopName: 'Epic Games Store',
            salePrice: 13.19,
            regularPrice: 39.99,
            cutPercent: 67,
            url: 'https://store.epicgames.com/p/skyrim-special-edition',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
        ttl: nowSec + 86400,
        updatedAt: new Date().toISOString(),
      };

      ddbMock.on(QueryCommand).callsFake((input) => {
        const pk = input?.ExpressionAttributeValues?.[':pk'];
        if (pk === 'MARKET#v5#489830#USD') {
          return { Items: [cachedSkyrimTelemetry] };
        }
        return { Items: [] };
      });

      vi.mocked(getSteamTrendingGames).mockResolvedValueOnce([
        {
          rank: 1,
          appId: 489830,
          name: 'The Elder Scrolls V: Skyrim Special Edition',
          currentPlayers: 28000,
          priceText: '$ 13.19 (-67%)',
          headerImage: 'https://example.com/skyrim.jpg',
        },
        {
          rank: 2,
          appId: 999002,
          name: 'Cold Indie Hit',
          currentPlayers: 19000,
          priceText: '$ 19.99 (-50%)',
          headerImage: 'https://example.com/cold-indie.jpg',
        },
      ]);

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

      const skyrimEntry = data.find((entry: { appId: number }) => entry.appId === 489830);
      expect(skyrimEntry).toBeDefined();
      expect(skyrimEntry.bestStore).toBe('nuuvem');
      expect(skyrimEntry.bestPriceUsd).toBe(9.99);
      expect(skyrimEntry.cutPercent).toBe(75);
      expect(skyrimEntry.isATL).toBe(true);
      expect(skyrimEntry.dealUrl).toBe('https://www.nuuvem.com/item/the-elder-scrolls-v-skyrim-special-edition');

      // Warm per-game cache hit must consume 0 live ITAD calls for 489830, while resolving cold 999002
      const dealCallAppIds = vi.mocked(getGameDealInfo).mock.calls.map((call) => String(call[0]));
      expect(dealCallAppIds).not.toContain('489830');
      expect(dealCallAppIds).toContain('999002');
    });

    it('should cross-hydrate MARKET#v5 per-game cache from trending so immediate /public/market/{appId} clicks serve all partner stores with zero extra ITAD calls', async () => {
      const inMemoryStore = new Map<string, Record<string, unknown>>();

      ddbMock.on(PutCommand).callsFake((input) => {
        const item = input?.Item as Record<string, unknown> | undefined;
        if (item?.PK && item?.SK) {
          inMemoryStore.set(`${String(item.PK)}|${String(item.SK)}`, item);
        }
        return {};
      });

      ddbMock.on(QueryCommand).callsFake((input) => {
        const pk = input?.ExpressionAttributeValues?.[':pk'];
        const sk = input?.ExpressionAttributeValues?.[':sk'] || 'TELEMETRY';
        const hit = pk ? inMemoryStore.get(`${String(pk)}|${String(sk)}`) : undefined;
        return { Items: hit ? [hit] : [] };
      });

      const mockSkyrimFourStoreDeal: GameDealInfo = {
        gameId: 'steam_489830',
        title: 'The Elder Scrolls V: Skyrim Special Edition',
        imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/489830/header.jpg',
        reviewScore: 94,
        steamAppId: '489830',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        allTimeLowPrice: 9.99,
        expiry: null,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 13.19,
          regularPrice: 39.99,
          cutPercent: 67,
          url: 'https://store.steampowered.com/app/489830/',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        cheaperAlternative: {
          shopName: 'Nuuvem',
          salePrice: 9.99,
          regularPrice: 39.99,
          cutPercent: 75,
          url: 'https://www.nuuvem.com/item/the-elder-scrolls-v-skyrim-special-edition',
          expiry: null,
          currency: 'USD',
          currencySymbol: '$',
        },
        storeBreakdown: {
          Steam: {
            shopName: 'Steam',
            salePrice: 13.19,
            regularPrice: 39.99,
            cutPercent: 67,
            url: 'https://store.steampowered.com/app/489830/',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          Nuuvem: {
            shopName: 'Nuuvem',
            salePrice: 9.99,
            regularPrice: 39.99,
            cutPercent: 75,
            url: 'https://www.nuuvem.com/item/the-elder-scrolls-v-skyrim-special-edition',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          GOG: {
            shopName: 'GOG',
            salePrice: 11.99,
            regularPrice: 39.99,
            cutPercent: 70,
            url: 'https://www.gog.com/game/the_elder_scrolls_v_skyrim_special_edition',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
          'Epic Games Store': {
            shopName: 'Epic Games Store',
            salePrice: 13.19,
            regularPrice: 39.99,
            cutPercent: 67,
            url: 'https://store.epicgames.com/p/skyrim-special-edition',
            expiry: null,
            currency: 'USD',
            currencySymbol: '$',
          },
        },
        alternativeCheckStatus: 'confirmed',
        alternativeCheckDegraded: false,
      };

      vi.mocked(getSteamTrendingGames).mockResolvedValueOnce([
        {
          rank: 1,
          appId: 489830,
          name: 'The Elder Scrolls V: Skyrim Special Edition',
          currentPlayers: 31500,
          priceText: '$ 13.19 (-67%)',
          headerImage: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/489830/header.jpg',
        },
      ]);

      vi.mocked(getGameDealInfo).mockImplementation(async (rawId): Promise<GameDealInfo | null> => {
        if (String(rawId) === '489830') {
          return mockSkyrimFourStoreDeal;
        }
        return null;
      });

      const trendingEvent: HttpApiEvent = {
        routeKey: 'GET /public/market/trending',
        rawPath: '/public/market/trending',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/trending',
          },
        },
      };

      const trendingResponse = await handler(trendingEvent);
      expect(trendingResponse.statusCode).toBe(200);
      const trendingData = JSON.parse(trendingResponse.body);
      expect(trendingData[0].appId).toBe(489830);
      expect(trendingData[0].bestStore).toBe('nuuvem');
      expect(trendingData[0].bestPriceUsd).toBe(9.99);

      // Verify MARKET#v5#489830#USD was cross-hydrated with 86400s TTL and all 4 stores
      const hydratedRecord = inMemoryStore.get('MARKET#v5#489830#USD|TELEMETRY') as
        | (Record<string, unknown> & { ttl?: number; storeBreakdown?: Record<string, unknown> })
        | undefined;
      expect(hydratedRecord).toBeDefined();
      expect(hydratedRecord?.ttl).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 86300);
      expect(Object.keys(hydratedRecord?.storeBreakdown || {})).toEqual(
        expect.arrayContaining(['Steam', 'Nuuvem', 'GOG', 'Epic Games Store']),
      );

      const callsAfterTrending = vi.mocked(getGameDealInfo).mock.calls.length;

      // Immediately inspect /public/market/489830 after clicking the trending card
      const singleGameEvent: HttpApiEvent = {
        routeKey: 'GET /public/market/{appId}',
        rawPath: '/public/market/489830',
        pathParameters: {
          appId: '489830',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/market/489830',
          },
        },
      };

      const detailResponse = await handler(singleGameEvent);
      expect(detailResponse.statusCode).toBe(200);
      const detailData = JSON.parse(detailResponse.body);

      expect(detailData.appId).toBe('489830');
      expect(detailData.title).toBe('The Elder Scrolls V: Skyrim Special Edition');
      expect(detailData.primaryDeal?.shopName).toBe('Steam');
      expect(detailData.primaryDeal?.salePrice).toBe(13.19);
      expect(detailData.cheaperAlternative?.shopName).toBe('Nuuvem');
      expect(detailData.cheaperAlternative?.salePrice).toBe(9.99);
      expect(Object.keys(detailData.storeBreakdown || {})).toEqual(
        expect.arrayContaining(['Steam', 'Nuuvem', 'GOG', 'Epic Games Store']),
      );
      expect(detailData.storeBreakdown.GOG.salePrice).toBe(11.99);
      expect(detailData.storeBreakdown['Epic Games Store'].salePrice).toBe(13.19);
      expect(vi.mocked(getGameDealInfo).mock.calls.length).toBe(callsAfterTrending);
    });

    it('should enforce bounded concurrency during trending resolution and avoid caching degraded or Steam-only titles', async () => {
      const sixteenCandidates: SteamTrendingEntry[] = Array.from({ length: 16 }, (_, idx) => {
        const appId = 880001 + idx;
        return {
          rank: idx + 1,
          appId,
          name: `Trending Title ${appId}`,
          currentPlayers: 50000 - idx * 500,
          priceText: '$ 29.99',
          headerImage: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
        };
      });

      vi.mocked(getSteamTrendingGames).mockResolvedValueOnce(sixteenCandidates);

      let inFlight = 0;
      let maxInFlight = 0;

      vi.mocked(getGameDealInfo).mockImplementation(async (rawId): Promise<GameDealInfo | null> => {
        inFlight += 1;
        if (inFlight > maxInFlight) {
          maxInFlight = inFlight;
        }
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const cleanId = String(rawId);

          if (cleanId === '880001') {
            return {
              gameId: 'steam_880001',
              title: 'Trending Title 880001',
              imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/880001/header.jpg',
              reviewScore: 80,
              steamAppId: '880001',
              dealType: 'CURATED_DEAL',
              isAllTimeLow: false,
              allTimeLowPrice: null,
              expiry: null,
              primaryDeal: {
                shopName: 'Steam',
                salePrice: 29.99,
                regularPrice: 29.99,
                cutPercent: 0,
                url: 'https://store.steampowered.com/app/880001/',
                expiry: null,
                currency: 'USD',
                currencySymbol: '$',
              },
              cheaperAlternative: null,
              storeBreakdown: {
                Steam: {
                  shopName: 'Steam',
                  salePrice: 29.99,
                  regularPrice: 29.99,
                  cutPercent: 0,
                  url: 'https://store.steampowered.com/app/880001/',
                  expiry: null,
                  currency: 'USD',
                  currencySymbol: '$',
                },
              },
              alternativeCheckStatus: 'degraded',
              alternativeCheckDegraded: true,
            };
          }

          if (cleanId === '880003') {
            return {
              gameId: 'steam_880003',
              title: 'Trending Title 880003',
              imageUrl: 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/880003/header.jpg',
              reviewScore: 91,
              steamAppId: '880003',
              dealType: 'CURATED_DEAL',
              isAllTimeLow: false,
              allTimeLowPrice: 14.99,
              expiry: null,
              primaryDeal: {
                shopName: 'Steam',
                salePrice: 19.99,
                regularPrice: 39.99,
                cutPercent: 50,
                url: 'https://store.steampowered.com/app/880003/',
                expiry: null,
                currency: 'USD',
                currencySymbol: '$',
              },
              cheaperAlternative: {
                shopName: 'GOG',
                salePrice: 14.99,
                regularPrice: 39.99,
                cutPercent: 63,
                url: 'https://www.gog.com/game/trending_title_880003',
                expiry: null,
                currency: 'USD',
                currencySymbol: '$',
              },
              storeBreakdown: {
                Steam: {
                  shopName: 'Steam',
                  salePrice: 19.99,
                  regularPrice: 39.99,
                  cutPercent: 50,
                  url: 'https://store.steampowered.com/app/880003/',
                  expiry: null,
                  currency: 'USD',
                  currencySymbol: '$',
                },
                GOG: {
                  shopName: 'GOG',
                  salePrice: 14.99,
                  regularPrice: 39.99,
                  cutPercent: 63,
                  url: 'https://www.gog.com/game/trending_title_880003',
                  expiry: null,
                  currency: 'USD',
                  currencySymbol: '$',
                },
              },
              alternativeCheckStatus: 'confirmed',
              alternativeCheckDegraded: false,
            };
          }

          // Steam-only non-degraded response (0 partner deals) for 880002 and others
          return {
            gameId: `steam_${cleanId}`,
            title: `Trending Title ${cleanId}`,
            imageUrl: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cleanId}/header.jpg`,
            reviewScore: 85,
            steamAppId: cleanId,
            dealType: 'CURATED_DEAL',
            isAllTimeLow: false,
            allTimeLowPrice: 29.99,
            expiry: null,
            primaryDeal: {
              shopName: 'Steam',
              salePrice: 29.99,
              regularPrice: 29.99,
              cutPercent: 0,
              url: `https://store.steampowered.com/app/${cleanId}/`,
              expiry: null,
              currency: 'USD',
              currencySymbol: '$',
            },
            cheaperAlternative: null,
            storeBreakdown: {
              Steam: {
                shopName: 'Steam',
                salePrice: 29.99,
                regularPrice: 29.99,
                cutPercent: 0,
                url: `https://store.steampowered.com/app/${cleanId}/`,
                expiry: null,
                currency: 'USD',
                currencySymbol: '$',
              },
            },
            alternativeCheckStatus: 'confirmed',
            alternativeCheckDegraded: false,
          };
        } finally {
          inFlight -= 1;
        }
      });

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
      expect(data.length).toBe(16);

      // Verify bounded worker concurrency (<= 4 simultaneous ITAD calls)
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(maxInFlight).toBeGreaterThanOrEqual(2);

      // Verify Zero Negative Caching on MARKET#v5 for degraded (880001) & Steam-only (880002),
      // while healthy multi-store (880003) IS persisted
      const putPks = ddbMock.commandCalls(PutCommand).map((call) => String(call.args[0].input.Item?.PK || ''));
      expect(putPks).not.toContain('MARKET#v5#880001#USD');
      expect(putPks).not.toContain('MARKET#v5#880002#USD');
      expect(putPks).toContain('MARKET#v5#880003#USD');
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

    it('should enrich top wishlist items with multi-store deal intelligence when available in cache', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [
          {
            PK: 'MARKET#v5#1086940#USD',
            SK: 'TELEMETRY',
            ...mockDealBaldursGate,
            appId: '1086940',
            ttl: Math.floor(Date.now() / 1000) + 7200,
          },
        ],
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

    it('should return authentic imageUrl from DynamoDB cache for wishlist items when available', async () => {
      const cachedHeader =
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/authentic_sha1_hash/header.jpg';
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {
          [MOCK_TABLE]: [
            {
              PK: 'ASSET#1086940',
              SK: 'METADATA',
              appId: '1086940',
              headerImage: cachedHeader,
              ttl: Math.floor(Date.now() / 1000) + 10000,
            },
          ],
        },
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
      const bg3 = data.items.find((i: { appId: string }) => i.appId === '1086940');
      expect(bg3?.imageUrl).toBe(cachedHeader);
    });

    it('should fall back to canonical Akamai header.jpg when store query has no header and cache is empty', async () => {
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {},
      });
      // Mock batch prices without header image
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [1086940, { initial: 59.99, final: 47.99, isFree: false }],
        ]),
      );
      vi.mocked(getGameDealInfo).mockResolvedValue(null);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Store throttled'));

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
      const bg3 = data.items.find((i: { appId: string }) => i.appId === '1086940');
      expect(bg3?.imageUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
      );
      fetchSpy.mockRestore();
    });

    it('should prioritize dynamic valve header_image from batchFetchSteamAppPrices over generic canonical fallback', async () => {
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {},
      });
      const dynamicHeader =
        'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/2807960/dynamic_sha1_hash/header.jpg';

      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [{ appId: '2807960', priority: 1, dateAdded: 1700000000 }],
      });
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            2807960,
            {
              isUnreleased: true,
              isFree: false,
              salePrice: null,
              regularPrice: null,
              discountPercent: 0,
              headerImage: dynamicHeader,
            },
          ],
        ]),
      );
      vi.mocked(resolveSteamAppTitles).mockResolvedValueOnce(
        new Map([['2807960', 'Battlefield 6']]),
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: {
            store_items: [
              {
                id: 2807960,
                appid: 2807960,
                name: 'Battlefield 6',
                assets: {
                  header: 'dynamic_sha1_hash/header.jpg',
                },
              },
            ],
          },
        }),
      } as Response);

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

      try {
        const response = await handler(event);
        expect(response.statusCode).toBe(200);
        const data = JSON.parse(response.body);
        const bf6 = data.items.find((i: { appId: string }) => i.appId === '2807960');
        expect(bf6?.imageUrl).toBe(dynamicHeader);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('should prioritize cached imageUrl from DynamoDB over dynamic store headerImage', async () => {
      const cachedMarketHeader = 'https://cdn.example.com/cached-market-bg3.jpg';
      ddbMock.on(BatchGetCommand).resolves({ Responses: {} });
      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [
          {
            PK: 'MARKET#v5#1086940#USD',
            SK: 'TELEMETRY',
            appId: '1086940',
            imageUrl: cachedMarketHeader,
            alternativeCheckDegraded: false,
            isPlatformExclusive: true,
            ttl: Math.floor(Date.now() / 1000) + 7200,
          },
        ],
      });
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [{ appId: '1086940', priority: 1, dateAdded: 1700000000 }],
      });
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            1086940,
            {
              initial: 59.99,
              final: 47.99,
              isFree: false,
              headerImage: 'https://cdn.steam.com/1086940/dynamic_header.jpg',
            },
          ],
        ]),
      );

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: { target: '76561198327022168' },
        requestContext: {
          http: { method: 'GET', path: '/public/wishlist/76561198327022168' },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      const bg3 = data.items.find((i: { appId: string }) => i.appId === '1086940');
      expect(bg3?.imageUrl).toBe(cachedMarketHeader);
    });

    it('should hydrate authentic game title in wishlist items when title was missing or generic', async () => {
      ddbMock.on(BatchGetCommand).resolves({ Responses: {} });
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [{ appId: '1163550', priority: 1, dateAdded: 1700000000 }],
      });
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(new Map());
      vi.mocked(resolveSteamAppTitles).mockResolvedValueOnce(
        new Map([['1163550', 'Steam App #1163550']]),
      );

      const mockBrowseResponse = {
        response: {
          store_items: [
            {
              id: 1163550,
              appid: 1163550,
              name: 'Captain Tsubasa: Rise of New Champions',
              assets: {
                header: 'header.jpg',
              },
            },
          ],
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockBrowseResponse,
      } as Response);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: { target: '76561198327022168' },
        requestContext: {
          http: { method: 'GET', path: '/public/wishlist/76561198327022168' },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      const tsubasa = data.items.find((i: { appId: string }) => i.appId === '1163550');
      expect(tsubasa?.title).toBe('Captain Tsubasa: Rise of New Champions');
      fetchSpy.mockRestore();
    });

    it('should sanitize unreleased or unpriced wishlist games to return salePrice: null and isFree: false, never zero or 100% free', async () => {
      vi.mocked(getGameDealInfo).mockResolvedValueOnce(null);
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [
          { appId: '2807960', priority: 5, dateAdded: 1710000000 },
        ],
      });

      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            2807960,
            {
              salePrice: null,
              regularPrice: null,
              discountPercent: 0,
              isFree: false,
              isUnreleased: true,
              headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/header.jpg',
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
      expect(data.items).toHaveLength(1);
      const unreleasedGame = data.items[0];
      expect(unreleasedGame.appId).toBe('2807960');
      expect(unreleasedGame.salePrice).toBeNull();
      expect(unreleasedGame.regularPrice).toBeNull();
      expect(unreleasedGame.discountPercent).toBe(0);
      expect(unreleasedGame.isFree).toBe(false);
      expect(unreleasedGame.isUnreleased).toBe(true);
      expect(unreleasedGame.primaryDeal).toBeNull();
      expect(unreleasedGame.priority).toBe(5);
    });

    it('should enforce deal intelligence precedence over unreleased fallback when cached dealInfo provides valid pricing', async () => {
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [
          { appId: '1086940', priority: 1, dateAdded: 1710000000 },
        ],
      });

      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            1086940,
            {
              salePrice: null,
              regularPrice: null,
              discountPercent: 0,
              isFree: false,
              isUnreleased: true,
              headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
            },
          ],
        ]),
      );

      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [
          {
            PK: 'MARKET#v5#1086940#USD',
            SK: 'TELEMETRY',
            ...mockDealBaldursGate,
            appId: '1086940',
            ttl: Math.floor(Date.now() / 1000) + 7200,
          },
        ],
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
      expect(data.items).toHaveLength(1);
      const bg3 = data.items[0];
      expect(bg3.appId).toBe('1086940');
      expect(bg3.isUnreleased).toBe(false);
      expect(bg3.isFree).toBe(false);
      expect(bg3.salePrice).toBe(47.99);
      expect(bg3.regularPrice).toBe(59.99);
      expect(bg3.discountPercent).toBe(20);
      expect(bg3.primaryDeal).toBeDefined();
      expect(bg3.primaryDeal.shopName).toBe('Steam');
    });

    it('should correctly identify truly free games with isFree: true and salePrice: 0', async () => {
      vi.mocked(getGameDealInfo).mockResolvedValueOnce(null);
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [
          { appId: '570', priority: 0, dateAdded: 1710000000 },
        ],
      });

      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [
            570,
            {
              initial: 0,
              final: 0,
              salePrice: 0,
              regularPrice: 0,
              discountPercent: 0,
              isFree: true,
              isUnreleased: false,
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
      const freeGame = data.items[0];
      expect(freeGame.appId).toBe('570');
      expect(freeGame.isFree).toBe(true);
      expect(freeGame.isUnreleased).toBe(false);
      expect(freeGame.salePrice).toBe(0);
      expect(freeGame.regularPrice).toBe(0);
      expect(freeGame.priority).toBe(0);
    });

    it('should support pagination parameters ?page=2&limit=2 while maintaining authentic totalSteamWishlist count', async () => {
      const wishlistItems = [
        { appId: '101', priority: 1, dateAdded: 500 },
        { appId: '102', priority: 2, dateAdded: 400 },
        { appId: '103', priority: 3, dateAdded: 300 },
        { appId: '104', priority: 4, dateAdded: 200 },
        { appId: '105', priority: 5, dateAdded: 100 },
      ];

      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: wishlistItems,
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        queryStringParameters: {
          page: '2',
          limit: '2',
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
      expect(data.totalSteamWishlist).toBe(5);
      expect(data.page).toBe(2);
      expect(data.limit).toBe(2);
      expect(data.totalPages).toBe(3);
      expect(data.items).toHaveLength(2);
      expect(data.items[0].appId).toBe('103');
      expect(data.items[0].priority).toBe(3);
      expect(data.items[1].appId).toBe('104');
      expect(data.items[1].priority).toBe(4);
    });

    it('should use cached market telemetry from DynamoDB and avoid live getGameDealInfo calls', async () => {
      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: [{ appId: '1086940', priority: 1, dateAdded: 500 }],
      });

      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [
          {
            PK: 'MARKET#v5#1086940#USD',
            SK: 'TELEMETRY',
            appId: '1086940',
            title: "Baldur's Gate 3",
            imageUrl: 'https://cdn.example.com/bg3.jpg',
            dealType: 'CURATED_DEAL',
            alternativeCheckDegraded: false,
            primaryDeal: {
              shopName: 'Steam',
              salePrice: 47.99,
              regularPrice: 59.99,
              cutPercent: 20,
              url: 'https://store.steampowered.com/app/1086940',
              currency: 'USD',
              currencySymbol: '$',
            },
            storeBreakdown: {
              Steam: {
                shopName: 'Steam',
                salePrice: 47.99,
                regularPrice: 59.99,
                cutPercent: 20,
                url: 'https://store.steampowered.com/app/1086940',
                currency: 'USD',
                currencySymbol: '$',
              },
              GOG: {
                shopName: 'GOG',
                salePrice: 47.99,
                regularPrice: 59.99,
                cutPercent: 20,
                url: 'https://gog.com/bg3',
                currency: 'USD',
                currencySymbol: '$',
              },
            },
            ttl: Math.floor(Date.now() / 1000) + 7200,
          },
        ],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: { target: '76561198327022168' },
        requestContext: {
          http: { method: 'GET', path: '/public/wishlist/76561198327022168' },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);

      const data = JSON.parse(response.body);
      expect(data.items).toHaveLength(1);
      expect(data.items[0].appId).toBe('1086940');
      expect(data.items[0].storeBreakdown['GOG']).toBeDefined();
      expect(getGameDealInfo).not.toHaveBeenCalled();
    });

    it('should completely eliminate live getGameDealInfo calls when items miss cache and return authentic Steam prices', async () => {
      const wishlistItems = [
        { appId: '201', priority: 1, dateAdded: 500 },
        { appId: '202', priority: 2, dateAdded: 400 },
        { appId: '203', priority: 3, dateAdded: 300 },
        { appId: '204', priority: 4, dateAdded: 200 },
        { appId: '205', priority: 5, dateAdded: 100 },
      ];

      vi.mocked(fetchSteamWishlist).mockResolvedValueOnce({
        success: true,
        items: wishlistItems,
      });

      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/wishlist/{target}',
        rawPath: '/public/wishlist/76561198327022168',
        pathParameters: { target: '76561198327022168' },
        queryStringParameters: { limit: '5' },
        requestContext: {
          http: { method: 'GET', path: '/public/wishlist/76561198327022168' },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);

      expect(getGameDealInfo).not.toHaveBeenCalled();
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

    it('should return authentic imageUrl from DynamoDB cache for backlog items when available', async () => {
      const cachedHeader =
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/authentic_sha1_hash/header.jpg';
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {
          [MOCK_TABLE]: [
            {
              PK: 'ASSET#1086940',
              SK: 'METADATA',
              appId: '1086940',
              headerImage: cachedHeader,
              ttl: Math.floor(Date.now() / 1000) + 10000,
            },
          ],
        },
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
      const bg3 = data.unplayedItems.find((i: { appId: number }) => i.appId === 1086940);
      expect(bg3?.imageUrl).toBe(cachedHeader);
    });

    it('should fall back to canonical Akamai header.jpg when backlog store query has no header and cache is empty', async () => {
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {},
      });
      // Mock batch prices without header image
      vi.mocked(batchFetchSteamAppPrices).mockResolvedValueOnce(
        new Map([
          [1086940, { initial: 59.99, final: 47.99, isFree: false }],
          [1091500, { initial: 59.99, final: 29.99, isFree: false }],
        ]),
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Store throttled'));

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
      const bg3 = data.unplayedItems.find((i: { appId: number }) => i.appId === 1086940);
      expect(bg3?.imageUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
      );
      fetchSpy.mockRestore();
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

  describe('buildMarketTelemetryPlaceholder', () => {
    it('should return unreleased placeholder with null prices and zero synthetic numbers in USD and BRL', () => {
      const placeholderUsd = buildMarketTelemetryPlaceholder('1857810', 'USD');
      expect(placeholderUsd.appId).toBe('1857810');
      expect(placeholderUsd.isUnreleased).toBe(true);
      expect(placeholderUsd.salePrice).toBeNull();
      expect(placeholderUsd.regularPrice).toBeNull();
      expect(placeholderUsd.allTimeLowPrice).toBeNull();
      expect(placeholderUsd.primaryDeal?.salePrice).toBeNull();
      expect(placeholderUsd.primaryDeal?.regularPrice).toBeNull();
      expect(placeholderUsd.primaryDeal?.currency).toBe('USD');

      const placeholderBrl = buildMarketTelemetryPlaceholder('1857810', 'BRL');
      expect(placeholderBrl.appId).toBe('1857810');
      expect(placeholderBrl.isUnreleased).toBe(true);
      expect(placeholderBrl.salePrice).toBeNull();
      expect(placeholderBrl.regularPrice).toBeNull();
      expect(placeholderBrl.primaryDeal?.currency).toBe('BRL');
      expect(placeholderBrl.primaryDeal?.currencySymbol).toBe('R$');
    });
  });

  describe('Route: GET /public/dossier/{target}', () => {
    it('should return 400 when target parameter is missing on base route', async () => {
      const event: HttpApiEvent = {
        rawPath: '/public/dossier',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 400 when target parameter is empty whitespace', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/   ',
        pathParameters: {
          target: '   ',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/   ',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 404 when Steam profile cannot be resolved', async () => {
      vi.mocked(resolveSteamId).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/nonexistent_user',
        pathParameters: {
          target: 'nonexistent_user',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/nonexistent_user',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
    });

    it('should return 404 when getPlayerSummary returns null', async () => {
      vi.mocked(getPlayerSummary).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
    });

    it('should return 502 when getOwnedGames fails with null', async () => {
      vi.mocked(getOwnedGames).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(502);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UpstreamError');
    });

    it('should return 403 LibraryPrivate when library is marked private', async () => {
      vi.mocked(getOwnedGames).mockResolvedValueOnce({
        isPrivate: true,
        gameCount: 0,
        games: [],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('LibraryPrivate');
    });

    it('should return 403 LibraryPrivate when owned games array is empty', async () => {
      vi.mocked(getOwnedGames).mockResolvedValueOnce({
        isPrivate: false,
        gameCount: 0,
        games: [],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('LibraryPrivate');
    });

    it('should successfully compute and return dossier telemetry for valid Steam ID', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);

      expect(data.steamId).toBe('76561198327022168');
      expect(data.personaName).toBe('zThigs');
      expect(data.totalGames).toBe(3);
      expect(data.playedGames).toBe(2);
      expect(data.unplayedGames).toBe(1);
      expect(data.totalPlaytimeHours).toBe(160); // (6000 + 3600) / 60 = 160.0
      expect(data.accountCreatedYear).toBe(2020);
      expect(data.accountAgeYears).toBe(6); // 2026 - 2020 = 6
      expect(Array.isArray(data.topPlayedGames)).toBe(true);
      expect(data.topPlayedGames).toHaveLength(2);

      const top1 = data.topPlayedGames[0];
      expect(top1.appId).toBe(1086940);
      expect(top1.title).toBe("Baldur's Gate 3");
      expect(top1.hoursPlayed).toBe(100);
      expect(top1.sharePercent).toBe(62.5); // 6000 / 9600 = 62.5%

      expect(Array.isArray(data.timeStream)).toBe(true);
      expect(data.timeStream.length).toBeGreaterThan(0);

      expect(data.archetype).toBeDefined();
      expect(data.archetype.id).toBe('FOCUS_MONK'); // top 3 share 100% >= 55%

      expect(Array.isArray(data.constellationGames)).toBe(true);
      expect(data.constellationGames).toHaveLength(2);
      const cg1 = data.constellationGames[0];
      expect(cg1.appId).toBe(1086940);
      expect(cg1.title).toBe("Baldur's Gate 3");
      expect(cg1.hoursPlayed).toBe(100);
      expect(cg1.sharePercent).toBe(62.5);
      expect(cg1.year).toBe(2025);
      expect(cg1.isEstimatedYear).toBe(false);
      expect(cg1.imageUrl).toBeDefined();

      expect(data.summary).toBeDefined();
      expect(data.summary.totalGames).toBe(3);
    });

    it('should properly structure constellationGames with deterministic year estimation when rtime_last_played is 0', async () => {
      vi.mocked(getOwnedGames).mockResolvedValueOnce({
        isPrivate: false,
        gameCount: 2,
        games: [
          {
            appId: 730,
            appid: 730,
            name: 'Counter-Strike 2',
            playtime_forever: 3000, // 50h
            rtime_last_played: 0, // untracked
            img_icon_url: 'icon_cs2',
          },
          {
            appId: 570,
            appid: 570,
            name: 'Dota 2',
            playtime_forever: 1800, // 30h
            rtime_last_played: 1704067200, // 2024
            img_icon_url: 'icon_dota2',
          },
        ],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);

      expect(Array.isArray(data.constellationGames)).toBe(true);
      expect(data.constellationGames).toHaveLength(2);

      const cs2 = data.constellationGames.find((g: { appId: number }) => g.appId === 730);
      expect(cs2).toBeDefined();
      expect(cs2.isEstimatedYear).toBe(true);
      // accountCreatedYear is 2020. span = 2026 - 2020 + 1 = 7. (730 % 7) + 2020 = 2 + 2020 = 2022
      expect(cs2.year).toBe(2022);
      expect(cs2.hoursPlayed).toBe(50);
      expect(cs2.sharePercent).toBe(62.5); // 50 / 80 = 62.5%

      const dota = data.constellationGames.find((g: { appId: number }) => g.appId === 570);
      expect(dota).toBeDefined();
      expect(dota.isEstimatedYear).toBe(false);
      expect(dota.year).toBe(2024);
      expect(dota.hoursPlayed).toBe(30);
      expect(dota.sharePercent).toBe(37.5); // 30 / 80 = 37.5%
    });

    it('should serve dossier immediately from DynamoDB cache on fresh cache hit without upstream calls', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cachedDossier = {
        PK: 'DOSSIER#v1#76561198327022168',
        SK: 'TELEMETRY',
        steamId: '76561198327022168',
        target: '76561198327022168',
        personaName: 'CachedPlayer',
        avatarUrl: 'https://cdn/cached.jpg',
        profileUrl: 'https://steamcommunity.com/profiles/76561198327022168',
        currency: 'USD',
        totalGames: 42,
        playedGames: 30,
        unplayedGames: 12,
        totalPlaytimeHours: 500,
        accountCreatedYear: 2018,
        accountAgeYears: 8,
        topPlayedGames: [],
        summary: {
          totalGames: 42,
          playedGames: 30,
          unplayedGames: 12,
          totalPlaytimeHours: 500,
          accountCreatedYear: 2018,
          accountAgeYears: 8,
          topPlayedGames: [],
        },
        timeStream: [],
        constellationGames: [],
        archetype: {
          id: 'TACTICAL_EXPLORER',
          label: 'Tactical Explorer',
          tagline: 'Balanced gamer',
          primaryMetricLabel: 'Average Hours',
          primaryMetricValue: '16.7h',
          traits: ['Balanced'],
        },
        updatedAt: new Date().toISOString(),
        ttl: nowSec + 1800,
      };

      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [cachedDossier],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.personaName).toBe('CachedPlayer');
      expect(data.totalGames).toBe(42);

      // Upstream Steam helpers must NOT have been called due to cache hit
      expect(vi.mocked(getPlayerSummary)).not.toHaveBeenCalled();
      expect(vi.mocked(getOwnedGames)).not.toHaveBeenCalled();
    });

    it('should persist fresh dossier to DynamoDB cache with 3600s TTL on cache miss', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [] });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const dossierPutCall = putCalls.find(
        (call) => call.args[0].input.Item?.PK === 'DOSSIER#v1#76561198327022168',
      );
      expect(dossierPutCall).toBeDefined();
      expect(dossierPutCall?.args[0].input.Item?.SK).toBe('TELEMETRY');
      const ttl = dossierPutCall?.args[0].input.Item?.ttl;
      expect(ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should support optional currency parameter (BRL and USD)', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/dossier/{target}',
        rawPath: '/public/dossier/76561198327022168',
        queryStringParameters: {
          currency: 'BRL',
        },
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.currency).toBe('BRL');
    });

    it('should respond with 204 No Content and CORS headers on OPTIONS preflight for dossier', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'OPTIONS',
            path: '/public/dossier/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(204);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(response.headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
      expect(response.body).toBe('');
    });
  });

  describe('computeGamerArchetype', () => {
    it('should classify FOCUS_MONK when top3SharePercent >= 55', () => {
      const archetype = computeGamerArchetype({
        top3SharePercent: 65.0,
        unplayedRatioPercent: 20.0,
        playedOver10hCount: 5,
        averageHoursPerPlayedGame: 30.0,
        totalGames: 20,
        accountAgeYears: 5,
      });

      expect(archetype.id).toBe('FOCUS_MONK');
      expect(archetype.label).toBe('Focus Monk');
      expect(archetype.primaryMetricValue).toBe('65%');
    });

    it('should classify VAULT_COLLECTOR when totalGames >= 80 and unplayedRatioPercent >= 55', () => {
      const archetype = computeGamerArchetype({
        top3SharePercent: 40.0,
        unplayedRatioPercent: 60.0,
        playedOver10hCount: 10,
        averageHoursPerPlayedGame: 15.0,
        totalGames: 120,
        accountAgeYears: 5,
      });

      expect(archetype.id).toBe('VAULT_COLLECTOR');
      expect(archetype.label).toBe('Vault Collector');
      expect(archetype.primaryMetricValue).toBe('60%');
    });

    it('should classify VETERAN_HISTORIAN when accountAgeYears >= 8 and playedOver10hCount >= 25', () => {
      const archetype = computeGamerArchetype({
        top3SharePercent: 35.0,
        unplayedRatioPercent: 30.0,
        playedOver10hCount: 28,
        averageHoursPerPlayedGame: 25.0,
        totalGames: 60,
        accountAgeYears: 10,
      });

      expect(archetype.id).toBe('VETERAN_HISTORIAN');
      expect(archetype.label).toBe('Veteran Historian');
      expect(archetype.primaryMetricValue).toBe('28 titles');
    });

    it('should fallback to TACTICAL_EXPLORER when balanced without dominating ratios', () => {
      const archetype = computeGamerArchetype({
        top3SharePercent: 35.0,
        unplayedRatioPercent: 30.0,
        playedOver10hCount: 10,
        averageHoursPerPlayedGame: 18.5,
        totalGames: 45,
        accountAgeYears: 4,
      });

      expect(archetype.id).toBe('TACTICAL_EXPLORER');
      expect(archetype.label).toBe('Tactical Explorer');
      expect(archetype.primaryMetricValue).toBe('18.5h');
    });
  });

  describe('buildDossierTimeStream', () => {
    it('should build sequential yearly timeline from accountCreatedYear to 2026', () => {
      const games = [
        {
          appId: 1086940,
          appid: 1086940,
          name: "Baldur's Gate 3",
          playtime_forever: 1200,
          rtime_last_played: 1735689600, // 2025
          img_icon_url: null,
        },
      ];

      const stream = buildDossierTimeStream(games, 2023, 2026);
      expect(stream).toHaveLength(4);
      expect(stream.map((s) => s.year)).toEqual([2023, 2024, 2025, 2026]);

      const year2025 = stream.find((s) => s.year === 2025);
      expect(year2025).toBeDefined();
      expect(year2025?.dominantGameTitle).toBe("Baldur's Gate 3");
      expect(year2025?.recordedHours).toBe(20);
    });

    it('should cleanly distribute historical baseline activity without NaN when rtime_last_played is 0', () => {
      const games = [
        {
          appId: 730,
          appid: 730,
          name: 'Counter-Strike 2',
          playtime_forever: 6000, // 100 hours
          rtime_last_played: 0,
          img_icon_url: null,
        },
      ];

      const stream = buildDossierTimeStream(games, 2022, 2026);
      expect(stream).toHaveLength(5);

      for (const entry of stream) {
        expect(isNaN(entry.recordedHours)).toBe(false);
        expect(entry.recordedHours).toBe(20); // 100h / 5 years = 20h/year
        expect(entry.dominantGameTitle).toBe('Counter-Strike 2');
        expect(entry.dominantGameAppId).toBe(730);
        expect(entry.activeTitlesCount).toBe(1);
      }
    });

    it('should return valid zero coordinates without NaN when all games are unplayed', () => {
      const games = [
        {
          appId: 1091500,
          appid: 1091500,
          name: 'Cyberpunk 2077',
          playtime_forever: 0,
          rtime_last_played: 0,
          img_icon_url: null,
        },
      ];

      const stream = buildDossierTimeStream(games, 2024, 2026);
      expect(stream).toHaveLength(3);

      for (const entry of stream) {
        expect(isNaN(entry.recordedHours)).toBe(false);
        expect(entry.recordedHours).toBe(0);
        expect(entry.activeTitlesCount).toBe(0);
        expect(entry.dominantGameTitle).toBeNull();
        expect(entry.dominantGameAppId).toBeNull();
      }
    });
  });

  describe('Route: GET /public/friends/{target}', () => {
    it('should return 400 when target parameter is missing on base route', async () => {
      const event: HttpApiEvent = {
        rawPath: '/public/friends',
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 400 when target parameter is empty whitespace', async () => {
      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/   ',
        pathParameters: {
          target: '   ',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/   ',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('BadRequest');
    });

    it('should return 404 when Steam profile cannot be resolved', async () => {
      vi.mocked(resolveSteamId).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/nonexistent_user',
        pathParameters: {
          target: 'nonexistent_user',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/nonexistent_user',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
    });

    it('should return 404 when getPlayerSummary returns null', async () => {
      vi.mocked(getPlayerSummary).mockResolvedValueOnce(null);

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('NotFound');
    });

    it('should return 403 FriendsListPrivate when the friends list is private', async () => {
      vi.mocked(getSteamFriendList).mockResolvedValueOnce({
        success: false,
        error: 'PRIVATE',
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('FriendsListPrivate');
      expect(data.message).toBe('The Steam friends list for this profile is private.');
      expect(vi.mocked(getPlayerSummaries)).not.toHaveBeenCalled();
    });

    it('should return 403 FriendsListPrivate when player profile summary is marked private', async () => {
      vi.mocked(getPlayerSummary).mockResolvedValueOnce({
        steamId: '76561198327022168',
        personaName: 'PrivateUser',
        profileUrl: 'https://steamcommunity.com/profiles/76561198327022168',
        avatarUrl: null,
        visibilityState: 1,
        isPrivate: true,
        personaState: 0,
        personaStateLabel: 'Offline',
        currentlyPlaying: null,
        currentlyPlayingId: null,
        timeCreated: null,
        countryCode: null,
        realName: null,
      });
      vi.mocked(getSteamFriendList).mockResolvedValueOnce({
        success: true,
        friends: [],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('FriendsListPrivate');
    });

    it('should return 502 UpstreamError when getSteamFriendList fails with FETCH_ERROR', async () => {
      vi.mocked(getSteamFriendList).mockResolvedValueOnce({
        success: false,
        error: 'FETCH_ERROR',
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(502);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UpstreamError');
    });

    it('should fetch friends, batch-resolve profiles in one call, and sort alphabetically case-insensitive', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [] });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/zthigs',
        pathParameters: {
          target: 'zthigs',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/zthigs',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);

      expect(data.steamId).toBe('76561198327022168');
      expect(data.target).toBe('zthigs');
      expect(data.personaName).toBe('zThigs');
      expect(data.totalFriends).toBe(3);
      expect(Array.isArray(data.friends)).toBe(true);
      expect(data.friends).toHaveLength(3);

      // Verify single batch call to getPlayerSummaries
      expect(vi.mocked(getPlayerSummaries)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getPlayerSummaries)).toHaveBeenCalledWith(
        ['76561198000000003', '76561198000000001', '76561198000000002'],
        expect.any(String),
      );

      // Verify alphabetical case-insensitive sorting: alice -> Bob -> Zelda
      expect(data.friends.map((f: { personaName: string }) => f.personaName)).toEqual([
        'alice',
        'Bob',
        'Zelda',
      ]);

      expect(data.friends[0]).toEqual({
        steamId: '76561198000000001',
        personaName: 'alice',
        avatarUrl: 'https://avatars.steamstatic.com/alice_full.jpg',
        profileUrl: 'https://steamcommunity.com/id/alice',
        relationship: 'friend',
        friendSince: 1600000000,
      });

      expect(data.friends[1]).toEqual({
        steamId: '76561198000000002',
        personaName: 'Bob',
        avatarUrl: 'https://avatars.steamstatic.com/bob_medium.jpg',
        profileUrl: 'https://steamcommunity.com/id/bob',
        relationship: 'friend',
        friendSince: 1620000000,
      });

      expect(data.friends[2]).toEqual({
        steamId: '76561198000000003',
        personaName: 'Zelda',
        avatarUrl: 'https://avatars.steamstatic.com/zelda_full.jpg',
        profileUrl: 'https://steamcommunity.com/profiles/76561198000000003',
        relationship: 'friend',
        friendSince: 1650000000,
      });
    });

    it('should cap batch enrichment to 100 friends while preserving totalFriends count', async () => {
      const manyFriends = Array.from({ length: 120 }, (_, idx) => ({
        steamId: (76561198000000100n + BigInt(idx)).toString(),
        relationship: 'friend',
        friendSince: 1700000000 + idx,
      }));
      vi.mocked(getSteamFriendList).mockResolvedValueOnce({
        success: true,
        friends: manyFriends,
      });
      vi.mocked(getPlayerSummaries).mockResolvedValueOnce(
        manyFriends.slice(0, 100).map((f, i) => ({
          steamId: f.steamId,
          personaName: `Friend_${String(100 - i).padStart(3, '0')}`,
          profileUrl: `https://steamcommunity.com/profiles/${f.steamId}`,
          avatarUrl: `https://avatars.steamstatic.com/${i}_full.jpg`,
          visibilityState: 3,
          isPrivate: false,
          personaState: 1,
          personaStateLabel: 'Online',
          currentlyPlaying: null,
          currentlyPlayingId: null,
          timeCreated: null,
          countryCode: null,
          realName: null,
        })),
      );

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.totalFriends).toBe(120);
      expect(data.friends).toHaveLength(100);
      expect(vi.mocked(getPlayerSummaries).mock.calls[0][0]).toHaveLength(100);
      expect(data.friends[0].personaName).toBe('Friend_001');
      expect(data.friends[99].personaName).toBe('Friend_100');
    });

    it('should serve friends list immediately from DynamoDB cache on fresh cache hit without upstream calls', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cachedFriendsPayload = {
        PK: 'FRIENDS#v1#76561198327022168',
        SK: 'TELEMETRY',
        steamId: '76561198327022168',
        target: '76561198327022168',
        personaName: 'zThigs',
        avatarUrl: 'https://cdn/avatar.jpg',
        profileUrl: 'https://steamcommunity.com/profiles/76561198327022168',
        totalFriends: 1,
        friends: [
          {
            steamId: '76561198000000099',
            personaName: 'CachedFriend',
            avatarUrl: 'https://cdn/cached_friend.jpg',
            profileUrl: 'https://steamcommunity.com/profiles/76561198000000099',
            relationship: 'friend',
            friendSince: 1680000000,
          },
        ],
        updatedAt: new Date().toISOString(),
        ttl: nowSec + 1800,
      };

      ddbMock.on(QueryCommand).resolvesOnce({
        Items: [cachedFriendsPayload],
      });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.friends).toHaveLength(1);
      expect(data.friends[0].personaName).toBe('CachedFriend');
      expect(data.PK).toBeUndefined();
      expect(data.SK).toBeUndefined();
      expect(data.ttl).toBeUndefined();

      // Upstream Steam helpers must NOT have been called due to cache hit
      expect(vi.mocked(getPlayerSummary)).not.toHaveBeenCalled();
      expect(vi.mocked(getSteamFriendList)).not.toHaveBeenCalled();
      expect(vi.mocked(getPlayerSummaries)).not.toHaveBeenCalled();
    });

    it('should persist fresh friends list to DynamoDB cache with 3600s TTL on cache miss', async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [] });

      const event: HttpApiEvent = {
        routeKey: 'GET /public/friends/{target}',
        rawPath: '/public/friends/76561198327022168',
        pathParameters: {
          target: '76561198327022168',
        },
        requestContext: {
          http: {
            method: 'GET',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const beforeSec = Math.floor(Date.now() / 1000);
      const response = await handler(event);
      const afterSec = Math.floor(Date.now() / 1000);
      expect(response.statusCode).toBe(200);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const friendsPutCall = putCalls.find(
        (call) => call.args[0].input.Item?.PK === 'FRIENDS#v1#76561198327022168',
      );
      expect(friendsPutCall).toBeDefined();
      expect(friendsPutCall?.args[0].input.Item?.SK).toBe('TELEMETRY');
      const ttl = friendsPutCall?.args[0].input.Item?.ttl as number;
      expect(ttl).toBeGreaterThanOrEqual(beforeSec + 3600);
      expect(ttl).toBeLessThanOrEqual(afterSec + 3600);
    });

    it('should respond with 204 No Content and CORS headers on OPTIONS preflight for friends', async () => {
      const event: HttpApiEvent = {
        requestContext: {
          http: {
            method: 'OPTIONS',
            path: '/public/friends/76561198327022168',
          },
        },
      };

      const response = await handler(event);
      expect(response.statusCode).toBe(204);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(response.headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
      expect(response.body).toBe('');
    });
  });
});
