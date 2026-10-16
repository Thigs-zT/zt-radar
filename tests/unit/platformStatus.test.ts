import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSteamTrendingGames } from '../../src/utils/platformStatus.js';

describe('Steam Trending Games Utility (platformStatus.ts)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should query featuredcategories with ?cc=us&l=english when preferredCurrency is USD', async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url);
      capturedUrls.push(urlStr);
      if (urlStr.includes('featuredcategories')) {
        return {
          ok: true,
          json: async () => ({
            top_sellers: {
              items: [
                { id: 1091500, type: 0, name: 'Cyberpunk 2077', final_price: 2999, discounted: true, discount_percent: 50 },
              ],
            },
          }),
        } as Response;
      }
      if (urlStr.includes('GetNumberOfCurrentPlayers')) {
        return {
          ok: true,
          json: async () => ({ response: { player_count: 50000 } }),
        } as Response;
      }
      return { ok: false } as Response;
    });

    const result = await getSteamTrendingGames(10, 'USD');

    expect(result.length).toBe(1);
    expect(result[0].appId).toBe(1091500);
    expect(result[0].priceText).toBe('$ 29.99 (-50%)');

    const featuredCall = capturedUrls.find((u) => u.includes('featuredcategories'));
    expect(featuredCall).toBeDefined();
    expect(featuredCall).toContain('cc=us');
    expect(featuredCall).toContain('l=english');
  });

  it('should query featuredcategories with ?cc=br&l=portuguese and format BRL prices when currency is BRL', async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url);
      capturedUrls.push(urlStr);
      if (urlStr.includes('featuredcategories')) {
        return {
          ok: true,
          json: async () => ({
            top_sellers: {
              items: [
                { id: 1086940, type: 0, name: "Baldur's Gate 3", final_price: 15999, discounted: true, discount_percent: 20 },
              ],
            },
          }),
        } as Response;
      }
      if (urlStr.includes('GetNumberOfCurrentPlayers')) {
        return {
          ok: true,
          json: async () => ({ response: { player_count: 80000 } }),
        } as Response;
      }
      return { ok: false } as Response;
    });

    const result = await getSteamTrendingGames(10, 'BRL');

    expect(result.length).toBe(1);
    expect(result[0].appId).toBe(1086940);
    expect(result[0].priceText).toBe('R$ 159.99 (-20%)');

    const featuredCall = capturedUrls.find((u) => u.includes('featuredcategories'));
    expect(featuredCall).toBeDefined();
    expect(featuredCall).toContain('cc=br');
    expect(featuredCall).toContain('l=portuguese');
  });

  it('should discard high-priced hardware bundles and packages lacking valid standalone appIds', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('featuredcategories')) {
        return {
          ok: true,
          json: async () => ({
            top_sellers: {
              items: [
                // High-priced hardware bundle (> $250.00 / 25000 cents in USD)
                { id: 1059530, type: 0, name: 'Valve Index VR Kit', final_price: 99900 },
                // Package without standalone app type (type: 1)
                { id: 888888, type: 1, name: 'Valve Complete Pack', final_price: 6999 },
                // Hardware by name
                { id: 1675200, type: 0, name: 'Steam Deck 512GB OLED', final_price: 54900 },
                // Invalid / missing id
                { id: 0, type: 0, name: 'Missing App ID', final_price: 1999 },
                // Valid commercial game
                { id: 1245620, type: 0, name: 'ELDEN RING', final_price: 3599, discounted: true, discount_percent: 40 },
              ],
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ response: { player_count: 65000 } }) } as Response;
    });

    const result = await getSteamTrendingGames(10, 'USD');

    expect(result.length).toBe(1);
    expect(result[0].appId).toBe(1245620);
    expect(result[0].name).toBe('ELDEN RING');
    expect(result[0].priceText).toBe('$ 35.99 (-40%)');
  });

  it('should format free to play items correctly', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('featuredcategories')) {
        return {
          ok: true,
          json: async () => ({
            top_sellers: {
              items: [
                { id: 730, type: 0, name: 'Counter-Strike 2', final_price: 0 },
              ],
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ response: { player_count: 1200000 } }) } as Response;
    });

    const result = await getSteamTrendingGames(10, 'USD');

    expect(result.length).toBe(1);
    expect(result[0].priceText).toBe('Free to Play');
  });
});
