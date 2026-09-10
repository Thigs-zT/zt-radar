import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Mock getGameDealInfo before importing handler
vi.mock('../../src/utils/itadApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGameDealInfo: vi.fn(),
    getMarketOverviewDeals: vi.fn().mockResolvedValue([]),
  };
});

import { handler } from '../../src/handlers/dealScanner.js';
import { getGameDealInfo } from '../../src/utils/itadApi.js';

describe('Deal Scanner Integration & In-Memory AWS Mocks', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  const MOCK_USER_ID = '123456789012345678';
  const MOCK_TABLE = 'zTRadarTable';

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();

    process.env.TABLE_NAME = MOCK_TABLE;
    process.env.DISCORD_BOT_TOKEN = 'mock_bot_token';

    // Mock Discord HTTP interactions for DM dispatch
    globalThis.fetch = vi.fn(async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/users/@me/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'dm_channel_999' }),
          text: async () => '',
        };
      }
      if (urlStr.includes('/channels/dm_channel_999/messages')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'message_888' }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe('Auto-Healing Title Updates', () => {
    it('should trigger UpdateCommand to auto-heal generic Steam App title when real deal title is resolved', async () => {
      const genericWishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#steam_1086940',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:1086940',
        game_title: 'Steam App #1086940',
        min_discount: 70,
        alert_all_time_low: true,
        last_notified_price: 59.99,
        last_notified_at: new Date().toISOString(),
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [genericWishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: "Baldur's Gate 3",
        steamAppId: 1086940,
        dealType: 'CURATED_DEAL',
        isAllTimeLow: false,
        reviewScore: 96,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 59.99,
          regularPrice: 59.99,
          cutPercent: 0,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      // Auto-heal update should occur even if no deal notification is triggered
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      const autoHealCall = updateCalls.find((call) =>
        call.args[0].input.UpdateExpression?.includes('SET game_title = :title')
      );
      expect(autoHealCall).toBeDefined();
      expect(autoHealCall.args[0].input.Key).toEqual({
        PK: genericWishlistItem.PK,
        SK: genericWishlistItem.SK,
      });
      expect(autoHealCall.args[0].input.ExpressionAttributeValues[':title']).toBe("Baldur's Gate 3");
    });
  });

  describe('Notification Filtering Logic', () => {
    it('should suppress alert for 10% launch discount when min_discount is 70%', async () => {
      const wishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#new_release',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:999',
        game_title: 'New Game Release',
        min_discount: 70,
        alert_all_time_low: true,
        alert_steep_discount: true,
        last_notified_price: null,
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [wishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: 'New Game Release',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        reviewScore: 85,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 53.99,
          regularPrice: 59.99,
          cutPercent: 10,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      // Verify Discord DM was NOT sent
      const discordMessagesCall = globalThis.fetch.mock.calls.find((call) =>
        String(call[0]).includes('/messages')
      );
      expect(discordMessagesCall).toBeUndefined();
    });

    it('should trigger alert when discount meets 75% under 70% threshold', async () => {
      const wishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#deep_discount',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:100',
        game_title: 'Great Discount Game',
        min_discount: 70,
        alert_all_time_low: true,
        alert_steep_discount: true,
        last_notified_price: null,
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [wishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: 'Great Discount Game',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        reviewScore: 90,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 14.99,
          regularPrice: 59.99,
          cutPercent: 75,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      // Verify Discord DM was sent
      const discordMessagesCall = globalThis.fetch.mock.calls.find((call) =>
        String(call[0]).includes('/messages')
      );
      expect(discordMessagesCall).toBeDefined();

      // Verify UpdateCommand recorded notification state
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const notificationUpdate = updateCalls.find((call) =>
        call.args[0].input.UpdateExpression?.includes('SET last_notified_price = :price')
      );
      expect(notificationUpdate).toBeDefined();
      expect(notificationUpdate.args[0].input.ExpressionAttributeValues[':price']).toBe(14.99);
    });

    it('should suppress alert when review score is below min_rating', async () => {
      const wishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#low_rating',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:200',
        game_title: 'Low Rated Game',
        min_discount: 50,
        min_rating: 80,
        alert_all_time_low: true,
        last_notified_price: null,
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [wishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: 'Low Rated Game',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        reviewScore: 65, // Below min_rating 80
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 9.99,
          regularPrice: 39.99,
          cutPercent: 75,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      const discordMessagesCall = globalThis.fetch.mock.calls.find((call) =>
        String(call[0]).includes('/messages')
      );
      expect(discordMessagesCall).toBeUndefined();
    });
  });

  describe('24-Hour Cooldown & Anti-Amnesia Protection', () => {
    const NOW = Date.now();
    const ONE_HOUR_AGO = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();
    const TWENTY_FIVE_HOURS_AGO = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();

    it('should suppress duplicate notification if scanned again at exact same price within 24h', async () => {
      const wishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#cooldown_test',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:300',
        game_title: 'Cooldown Game',
        min_discount: 50,
        alert_all_time_low: true,
        last_notified_price: 19.99,
        last_notified_at: ONE_HOUR_AGO, // Alerted 1 hour ago
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [wishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: 'Cooldown Game',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        reviewScore: 88,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 19.99, // Same price
          regularPrice: 49.99,
          cutPercent: 60,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      const discordMessagesCall = globalThis.fetch.mock.calls.find((call) =>
        String(call[0]).includes('/messages')
      );
      expect(discordMessagesCall).toBeUndefined();
    });

    it('should immediately alert if price drops further within 24h cooldown', async () => {
      const wishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#price_drop_test',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:300',
        game_title: 'Price Drop Game',
        min_discount: 50,
        alert_all_time_low: true,
        last_notified_price: 19.99,
        last_notified_at: ONE_HOUR_AGO,
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [wishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: 'Price Drop Game',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        reviewScore: 88,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 14.99, // Lower price ($14.99 < $19.99)
          regularPrice: 49.99,
          cutPercent: 70,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      const discordMessagesCall = globalThis.fetch.mock.calls.find((call) =>
        String(call[0]).includes('/messages')
      );
      expect(discordMessagesCall).toBeDefined();
    });

    it('should re-alert at same price once 24 hours have elapsed', async () => {
      const wishlistItem = {
        PK: `USER#${MOCK_USER_ID}`,
        SK: 'GAME#reminder_test',
        user_id: MOCK_USER_ID,
        external_game_id: 'steam:300',
        game_title: 'Reminder Game',
        min_discount: 50,
        alert_all_time_low: true,
        last_notified_price: 19.99,
        last_notified_at: TWENTY_FIVE_HOURS_AGO, // 25 hours elapsed
      };

      ddbMock.on(ScanCommand).resolves({
        Items: [wishlistItem],
      });
      ddbMock.on(UpdateCommand).resolves({});

      getGameDealInfo.mockResolvedValue({
        title: 'Reminder Game',
        dealType: 'CURATED_DEAL',
        isAllTimeLow: true,
        reviewScore: 88,
        primaryDeal: {
          shopName: 'Steam',
          salePrice: 19.99,
          regularPrice: 49.99,
          cutPercent: 60,
        },
      });

      const response = await handler();
      expect(response.statusCode).toBe(200);

      const discordMessagesCall = globalThis.fetch.mock.calls.find((call) =>
        String(call[0]).includes('/messages')
      );
      expect(discordMessagesCall).toBeDefined();
    });
  });
});
