import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSteamFriendList, getPlayerSummaries } from '../../src/utils/steamWeb.js';

describe('Steam Friends & Batch Summary Utilities (steamWeb.ts)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('getSteamFriendList', () => {
    it('should call Valve GetFriendList endpoint and parse friend records', async () => {
      const capturedUrls: string[] = [];
      globalThis.fetch = vi.fn(async (url) => {
        capturedUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            friendslist: {
              friends: [
                {
                  steamid: '76561198000000001',
                  relationship: 'friend',
                  friend_since: 1700000000,
                },
                {
                  steamid: '76561198000000002',
                  relationship: 'friend',
                },
              ],
            },
          }),
        } as Response;
      });

      const result = await getSteamFriendList('76561198327022168', 'test-api-key');

      expect(capturedUrls).toHaveLength(1);
      expect(capturedUrls[0]).toBe(
        'https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=test-api-key&steamid=76561198327022168&relationship=friend',
      );
      expect(result).toEqual({
        success: true,
        friends: [
          { steamId: '76561198000000001', relationship: 'friend', friendSince: 1700000000 },
          { steamId: '76561198000000002', relationship: 'friend', friendSince: 0 },
        ],
      });
    });

    it('should return PRIVATE error when Steam returns HTTP 401 or 403', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 401,
      }) as Response);

      const res401 = await getSteamFriendList('76561198327022168', 'test-api-key');
      expect(res401).toEqual({ success: false, error: 'PRIVATE' });

      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 403,
      }) as Response);

      const res403 = await getSteamFriendList('76561198327022168', 'test-api-key');
      expect(res403).toEqual({ success: false, error: 'PRIVATE' });
    });

    it('should return NOT_FOUND when Steam returns HTTP 404', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
      }) as Response);

      const result = await getSteamFriendList('76561198327022168', 'test-api-key');
      expect(result).toEqual({ success: false, error: 'NOT_FOUND' });
    });

    it('should validate SteamID64 format and API key before calling upstream', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      expect(await getSteamFriendList('invalid-id', 'test-api-key')).toEqual({
        success: false,
        error: 'INVALID_ID',
      });
      expect(await getSteamFriendList('76561198327022168', '')).toEqual({
        success: false,
        error: 'CONFIG_REQUIRED',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('getPlayerSummaries', () => {
    it('should batch resolve up to 100 SteamIDs in one HTTP call and prefer avatarfull over avatarmedium', async () => {
      const capturedUrls: string[] = [];
      const inputIds = Array.from({ length: 105 }, (_, i) =>
        (76561198000001000n + BigInt(i)).toString(),
      );

      globalThis.fetch = vi.fn(async (url) => {
        capturedUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            response: {
              players: [
                {
                  steamid: '76561198000001000',
                  personaname: 'PlayerOne',
                  profileurl: 'https://steamcommunity.com/id/playerone',
                  avatarfull: 'https://cdn/p1_full.jpg',
                  avatarmedium: 'https://cdn/p1_medium.jpg',
                  communityvisibilitystate: 3,
                  personastate: 1,
                },
                {
                  steamid: '76561198000001001',
                  personaname: 'PlayerTwo',
                  profileurl: 'https://steamcommunity.com/id/playertwo',
                  avatarmedium: 'https://cdn/p2_medium.jpg',
                  communityvisibilitystate: 3,
                  personastate: 0,
                },
              ],
            },
          }),
        } as Response;
      });

      const summaries = await getPlayerSummaries(inputIds, 'test-api-key');

      expect(capturedUrls).toHaveLength(1);
      const urlObj = new URL(capturedUrls[0]);
      expect(urlObj.origin + urlObj.pathname).toBe(
        'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/',
      );
      expect(urlObj.searchParams.get('key')).toBe('test-api-key');
      const sentIds = (urlObj.searchParams.get('steamids') || '').split(',');
      expect(sentIds).toHaveLength(100);

      expect(summaries).toHaveLength(2);
      expect(summaries[0].avatarUrl).toBe('https://cdn/p1_full.jpg');
      expect(summaries[1].avatarUrl).toBe('https://cdn/p2_medium.jpg');
    });
  });
});
