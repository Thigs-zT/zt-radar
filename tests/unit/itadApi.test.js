import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  formatPriceComparisonDiff,
  formatExpiryAvailability,
  getMarketOverviewDeals,
  getGameDealInfo,
  sanitizeTitleForItadLookup,
  isStrictEditionMatch,
  fetchSteamStoreAppDetails,
  transformItadPriceHistory,
  fetchItadPriceHistory,
  ITAD_VERIFIED_SHOP_IDS,
  MAX_PRICE_HISTORY_POINTS,
} from '../../src/utils/itadApi.js';

describe('ITAD API Utilities', () => {
  describe('sanitizeTitleForItadLookup', () => {
    it('should strip edition suffixes and trademark symbols', () => {
      expect(sanitizeTitleForItadLookup('The Witcher 3: Wild Hunt — Remastered')).toBe('The Witcher 3: Wild Hunt');
      expect(sanitizeTitleForItadLookup('The Witcher 3: Wild Hunt - Complete Edition')).toBe('The Witcher 3: Wild Hunt');
      expect(sanitizeTitleForItadLookup('Lords of the Fallen™ (2014) Game of the Year Edition')).toBe('Lords of the Fallen (2014)');
      expect(sanitizeTitleForItadLookup('Lords Of The Fallen™ 2014')).toBe('Lords Of The Fallen 2014');
      expect(sanitizeTitleForItadLookup('ARC Raiders - Deluxe Edition')).toBe('ARC Raiders');
      expect(sanitizeTitleForItadLookup('Cyberpunk 2077®')).toBe('Cyberpunk 2077');
      expect(sanitizeTitleForItadLookup('The Walking Dead: The Telltale Definitive Series')).toBe('The Walking Dead');
      expect(sanitizeTitleForItadLookup('The Walking Dead : The Telltale Definitive Series')).toBe('The Walking Dead');
    });
  });

  describe('isStrictEditionMatch', () => {
    it('should accept identical titles regardless of case or whitespace', () => {
      expect(isStrictEditionMatch('Hades', 'hades')).toBe(true);
      expect(isStrictEditionMatch('REMATCH', 'rematch')).toBe(true);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'the witcher 3: wild hunt')).toBe(true);
    });

    it('should accept valid edition suffixes after word/punctuation delimiter', () => {
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt - Complete Edition')).toBe(true);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt: Complete Edition')).toBe(true);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt Complete Edition')).toBe(true);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt - Game of the Year Edition')).toBe(true);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt: GOTY Edition')).toBe(true);
      expect(isStrictEditionMatch('Cyberpunk 2077', 'Cyberpunk 2077: Ultimate Edition')).toBe(true);
      expect(isStrictEditionMatch('Control', 'Control Ultimate Edition')).toBe(true);
      expect(isStrictEditionMatch('Control', 'Control (Complete Edition)')).toBe(true);
      expect(isStrictEditionMatch('The Walking Dead: The Telltale Definitive Series', 'The Walking Dead : The Telltale Definitive Series')).toBe(true);
      expect(isStrictEditionMatch('The Walking Dead', 'The Walking Dead: The Telltale Definitive Series')).toBe(true);
      expect(isStrictEditionMatch('The Walking Dead', 'The Walking Dead : The Telltale Definitive Series')).toBe(true);
    });

    it('should strictly reject numbered sequels and prevent cross-contamination', () => {
      expect(isStrictEditionMatch('Hades', 'Hades II')).toBe(false);
      expect(isStrictEditionMatch('Hades', 'Hades 2')).toBe(false);
      expect(isStrictEditionMatch('Hades', "Hades' Star")).toBe(false);
      expect(isStrictEditionMatch('Hades', 'The Road to Hades')).toBe(false);
    });

    it('should reject unrelated games or non-authorized edition names', () => {
      expect(isStrictEditionMatch('REMATCH', 'REMATCH - Elite Edition')).toBe(false);
      expect(isStrictEditionMatch('REMATCH', 'Shuttlecock-H: Covered Rematch')).toBe(false);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt - Blood and Wine')).toBe(false);
      expect(isStrictEditionMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt — Remastered - Nintendo Switch 2')).toBe(false);
    });
  });
  describe('formatPriceComparisonDiff', () => {
    const steamDeal = {
      shopName: 'Steam',
      regularPrice: 69.99,
      salePrice: 48.99,
      cutPercent: 30,
      currencySymbol: '$',
    };

    const nuuvemDeal = {
      shopName: 'Nuuvem',
      regularPrice: 69.99,
      salePrice: 34.99,
      cutPercent: 50,
      currencySymbol: '$',
    };

    it('should render dual diff block with best value tag when cheaper alternative exists', () => {
      const result = formatPriceComparisonDiff(steamDeal, nuuvemDeal, '$');

      expect(result).toContain('```diff');
      expect(result).toContain('[ Monitored Storefront ❖ Steam ]');
      expect(result).toContain('- Regular: $ 69.99');
      expect(result).toContain('+ Current: $ 48.99 (-30%)');
      expect(result).toContain('[ Best Offer Detected ❖ Nuuvem ]');
      expect(result).toContain('+ Deal:    $ 34.99 (-50%) ★ Best Value');
      expect(result).toContain('```');
    });

    it('should render single diff block when primary storefront is already the best offer', () => {
      const result = formatPriceComparisonDiff(steamDeal, null, '$');

      expect(result).toContain('```diff');
      expect(result).toContain('[ Monitored Storefront ❖ Steam ]');
      expect(result).toContain('- Regular: $ 69.99');
      expect(result).toContain('+ Current: $ 48.99 (-30%)');
      expect(result).not.toContain('[ Best Offer Detected');
      expect(result).toContain('```');
    });

    it('should respect custom currency symbol for regional pricing', () => {
      const brlPrimary = {
        shopName: 'Steam',
        regularPrice: 299.90,
        salePrice: 149.95,
        cutPercent: 50,
        currencySymbol: 'R$',
      };
      const brlAlt = {
        shopName: 'Nuuvem',
        regularPrice: 299.90,
        salePrice: 119.90,
        cutPercent: 60,
        currencySymbol: 'R$',
      };

      const result = formatPriceComparisonDiff(brlPrimary, brlAlt, 'R$');

      expect(result).toContain('- Regular: R$ 299.90');
      expect(result).toContain('+ Current: R$ 149.95 (-50%)');
      expect(result).toContain('+ Deal:    R$ 119.90 (-60%) ★ Best Value');
    });
  });

  describe('formatExpiryAvailability', () => {
    it('should format ISO 8601 strings into dynamic Discord timestamp tags', () => {
      const isoExpiry = '2026-09-18T04:59:59+02:00';
      const expectedEpoch = Math.floor(new Date(isoExpiry).getTime() / 1000);
      const result = formatExpiryAvailability(isoExpiry);

      expect(result).toBe(`└─ Availability: Until <t:${expectedEpoch}:F> (<t:${expectedEpoch}:R>)`);
    });

    it('should format numeric epoch timestamps in milliseconds', () => {
      const epochMs = 1789700399000;
      const expectedEpoch = Math.floor(epochMs / 1000);
      const result = formatExpiryAvailability(epochMs);

      expect(result).toBe(`└─ Availability: Until <t:${expectedEpoch}:F> (<t:${expectedEpoch}:R>)`);
    });

    it('should format numeric epoch timestamps in seconds', () => {
      const epochSeconds = 1789700399;
      const result = formatExpiryAvailability(epochSeconds);

      expect(result).toBe(`└─ Availability: Until <t:${epochSeconds}:F> (<t:${epochSeconds}:R>)`);
    });

    it('should return friendly fallback for null or undefined values', () => {
      const expectedFallback = '└─ Availability: Limited-time promotion (Claim as soon as possible)';

      expect(formatExpiryAvailability(null)).toBe(expectedFallback);
      expect(formatExpiryAvailability(undefined)).toBe(expectedFallback);
      expect(formatExpiryAvailability('')).toBe(expectedFallback);
    });

    it('should return friendly fallback for invalid date strings', () => {
      const expectedFallback = '└─ Availability: Limited-time promotion (Claim as soon as possible)';

      expect(formatExpiryAvailability('invalid-timestamp-value')).toBe(expectedFallback);
    });
  });

  describe('Regional Currency Routing (getMarketOverviewDeals)', () => {
    const originalFetch = globalThis.fetch;
    const originalEnvKey = process.env.ITAD_API_KEY;

    beforeEach(() => {
      process.env.ITAD_API_KEY = 'test_mock_api_key';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      process.env.ITAD_API_KEY = originalEnvKey;
      vi.restoreAllMocks();
    });

    it('should route country=US when preferredCurrency is USD', async () => {
      const capturedUrls = [];
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        capturedUrls.push(urlStr);
        if (urlStr.includes('cheapshark')) {
          return {
            ok: true,
            json: async () => [],
          };
        }
        return {
          ok: true,
          json: async () => ({ list: [] }),
        };
      });

      await getMarketOverviewDeals(false, 'USD');

      const itadCall = capturedUrls.find((u) => u.includes('api.isthereanydeal.com/deals/v2'));
      expect(itadCall).toBeDefined();
      expect(itadCall).toContain('country=US');
      expect(itadCall).not.toContain('country=BR');
    });

    it('should route country=BR when preferredCurrency is BRL', async () => {
      const capturedUrls = [];
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        capturedUrls.push(urlStr);
        if (urlStr.includes('cheapshark')) {
          return {
            ok: true,
            json: async () => [],
          };
        }
        return {
          ok: true,
          json: async () => ({ list: [] }),
        };
      });

      await getMarketOverviewDeals(false, 'BRL');

      const itadCall = capturedUrls.find((u) => u.includes('api.isthereanydeal.com/deals/v2'));
      expect(itadCall).toBeDefined();
      expect(itadCall).toContain('country=BR');
      expect(itadCall).not.toContain('country=US');
    });
  });

  describe('getGameDealInfo Multi-Store Breakdown & Alternative Check', () => {
    const originalFetch = globalThis.fetch;
    const originalEnvKey = process.env.ITAD_API_KEY;

    beforeEach(() => {
      process.env.ITAD_API_KEY = 'test_mock_itad_key';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      process.env.ITAD_API_KEY = originalEnvKey;
      vi.restoreAllMocks();
    });

    it('should retrieve 4-store breakdown with status confirmed and alternativeCheckDegraded false', async () => {
      globalThis.fetch = vi.fn(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1091500': {
                success: true,
                data: {
                  name: 'Cyberpunk 2077',
                  header_image: 'https://example.com/cyberpunk.jpg',
                  metacritic: { score: 86 },
                  price_overview: {
                    initial: 19990,
                    final: 5997,
                    discount_percent: 70,
                  },
                },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return {
            ok: true,
            json: async () => ({
              found: true,
              game: { id: 'uuid-cyberpunk-1091500' },
            }),
          };
        }
        if (urlStr.includes('/games/search/v1')) {
          return {
            ok: true,
            json: async () => [{ id: 'uuid-cyberpunk-1091500', title: 'Cyberpunk 2077', type: 'game' }],
          };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-cyberpunk-1091500',
                deals: [
                  { shop: { name: 'GOG' }, price: { amount: 59.95 }, regular: { amount: 199.90 }, cut: 70, url: 'https://gog.com/deal' },
                  { shop: { name: 'Epic Games Store' }, price: { amount: 199.90 }, regular: { amount: 199.90 }, cut: 0, url: 'https://epic.com/deal' },
                  { shop: { name: 'Nuuvem' }, price: { amount: 249.00 }, regular: { amount: 249.00 }, cut: 0, url: 'https://nuuvem.com/deal' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-cyberpunk-1091500',
                low: { price: { amount: 59.95 } },
              },
            ],
          };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('1091500', 'Cyberpunk 2077', 'BRL');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.storeBreakdown).toBeDefined();

      const storeNames = Object.keys(deal?.storeBreakdown || {});
      expect(storeNames).toContain('Steam');
      expect(storeNames).toContain('GOG');
      expect(storeNames).toContain('Epic Games Store');
      expect(storeNames).toContain('Nuuvem');

      expect(deal?.storeBreakdown['Steam'].salePrice).toBe(59.97);
      expect(deal?.storeBreakdown['GOG'].salePrice).toBe(59.95);
      expect(deal?.storeBreakdown['Epic Games Store'].salePrice).toBe(199.90);
      expect(deal?.storeBreakdown['Nuuvem'].salePrice).toBe(249.00);
    });

    it('should degrade gracefully when ITAD lookup fails, retaining Steam deal', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1091500': {
                success: true,
                data: {
                  name: 'Cyberpunk 2077',
                  price_overview: { initial: 19990, final: 5997, discount_percent: 70 },
                },
              },
            }),
          };
        }
        if (urlStr.includes('isthereanydeal.com')) {
          return { ok: false, status: 500 };
        }
        return { ok: false };
      });

      const deal = await getGameDealInfo('1091500', 'BRL');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckStatus).toBe('degraded');
      expect(deal?.alternativeCheckDegraded).toBe(true);
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['GOG']).toBeUndefined();
    });

    it('should route uppercase country codes to ITAD prices and historylow', async () => {
      const queriedUrls = [];
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        queriedUrls.push(urlStr);
        if (urlStr.includes('store.steampowered.com')) {
          return {
            ok: true,
            json: async () => ({
              '1091500': {
                success: true,
                data: { name: 'Cyberpunk 2077', price_overview: { initial: 5999, final: 1799, discount_percent: 70 } },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return {
            ok: true,
            json: async () => ({ found: true, game: { id: 'uuid-123' } }),
          };
        }
        return {
          ok: true,
          json: async () => [],
        };
      });

      await getGameDealInfo('1091500', 'USD');

      const pricesCall = queriedUrls.find((u) => u.includes('/games/prices/v3'));
      expect(pricesCall).toContain('country=US');
    });

    it('should perform secondary ITAD lookup using sanitized title and merge storefronts when primary returns only Steam', async () => {
      globalThis.fetch = vi.fn(async (url, init) => {
        const urlStr = String(url);
        // Steam app details returns Witcher 3 with Remastered suffix
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '292030': {
                success: true,
                data: {
                  name: 'The Witcher 3: Wild Hunt — Remastered',
                  header_image: 'https://example.com/witcher3.jpg',
                  price_overview: { initial: 4999, final: 4999, discount_percent: 0 },
                },
              },
            }),
          };
        }
        // Primary lookup by appid=292030 returns base game ID
        if (urlStr.includes('/games/lookup/v1') && urlStr.includes('appid=292030')) {
          return {
            ok: true,
            json: async () => ({
              found: true,
              game: { id: 'uuid-witcher3-base' },
            }),
          };
        }
        // Secondary search by sanitized title returns Complete Edition ID
        if (urlStr.includes('/games/search/v1') && urlStr.includes('title=')) {
          return {
            ok: true,
            json: async () => [
              { id: 'uuid-witcher3-complete', title: 'The Witcher 3: Wild Hunt - Complete Edition', type: 'game' },
            ],
          };
        }
        // Secondary lookup by sanitized title
        if (urlStr.includes('/games/lookup/v1') && urlStr.includes('title=')) {
          return {
            ok: true,
            json: async () => ({
              found: true,
              game: { id: 'uuid-witcher3-base' },
            }),
          };
        }
        // Prices query
        if (urlStr.includes('/games/prices/v3')) {
          const body = JSON.parse(init?.body || '[]');
          const results = [];
          if (body.includes('uuid-witcher3-base')) {
            // Base game on ITAD only returns Steam
            results.push({
              id: 'uuid-witcher3-base',
              deals: [
                { shop: { name: 'Steam' }, price: { amount: 49.99 }, regular: { amount: 49.99 }, cut: 0, url: 'https://steam.com/witcher' },
              ],
            });
          }
          if (body.includes('uuid-witcher3-complete')) {
            // Secondary edition returns GOG and Epic Games Store
            results.push({
              id: 'uuid-witcher3-complete',
              deals: [
                { shop: { name: 'GOG' }, price: { amount: 12.49 }, regular: { amount: 49.99 }, cut: 75, url: 'https://gog.com/witcher' },
                { shop: { name: 'Epic Games Store' }, price: { amount: 14.99 }, regular: { amount: 49.99 }, cut: 70, url: 'https://epic.com/witcher' },
              ],
            });
          }
          return {
            ok: true,
            json: async () => results,
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return {
            ok: true,
            json: async () => [{ id: 'uuid-witcher3-base', low: { price: { amount: 9.99 } } }],
          };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('292030', 'USD');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(deal?.alternativeCheckDegraded).toBe(false);

      // Verify storefront merging
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['GOG']).toBeDefined();
      expect(deal?.storeBreakdown['Epic Games Store']).toBeDefined();

      expect(deal?.storeBreakdown['GOG'].salePrice).toBe(12.49);
      expect(deal?.storeBreakdown['Epic Games Store'].salePrice).toBe(14.99);

      // Verify cheaper alternative is selected
      expect(deal?.cheaperAlternative).toBeDefined();
      expect(deal?.cheaperAlternative?.shopName).toBe('GOG');
      expect(deal?.cheaperAlternative?.salePrice).toBe(12.49);
    });

    it('should protect authentic Steam title and price overview from being overwritten by ITAD search or candidate deals', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        // Valve Steam Store official API returns REMATCH at $15.99 (-60% off $39.99)
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '2138720': {
                success: true,
                data: {
                  name: 'REMATCH',
                  price_overview: { initial: 3999, final: 1599, discount_percent: 60 },
                },
              },
            }),
          };
        }
        // ITAD lookup returns primary ID
        if (urlStr.includes('/games/lookup/v1')) {
          return {
            ok: true,
            json: async () => ({
              found: true,
              game: { id: 'uuid-rematch-base', title: 'REMATCH' },
            }),
          };
        }
        // ITAD search returns REMATCH and an unrelated game that should be filtered
        if (urlStr.includes('/games/search/v1')) {
          return {
            ok: true,
            json: async () => [
              { id: 'uuid-rematch-base', title: 'REMATCH', type: 'game' },
              { id: 'uuid-cheap-fake', title: 'Shuttlecock-H: Covered Rematch', type: 'game' },
              { id: 'uuid-hades-ii', title: 'Hades II', type: 'game' },
            ],
          };
        }
        // ITAD prices/v3 returns stale Steam price of $29.99 (0% cut) and an Epic deal
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-rematch-base',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 29.99 }, regular: { amount: 29.99 }, cut: 0, url: 'https://steam.com' },
                  { shop: { name: 'Epic Games Store' }, price: { amount: 29.99 }, regular: { amount: 29.99 }, cut: 0, url: 'https://epic.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return {
            ok: true,
            json: async () => [{ id: 'uuid-rematch-base', low: { price: { amount: 15.99 } } }],
          };
        }
        return { ok: false };
      });

      const deal = await getGameDealInfo('2138720', 'USD');

      expect(deal).toBeDefined();
      // Steam Title must strictly remain official name from Valve
      expect(deal?.title).toBe('REMATCH');

      // Authentic Steam promotional price overview ($15.99, -60%) MUST NOT be overwritten by ITAD's $29.99
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['Steam'].salePrice).toBe(15.99);
      expect(deal?.storeBreakdown['Steam'].regularPrice).toBe(39.99);
      expect(deal?.storeBreakdown['Steam'].cutPercent).toBe(60);

      expect(deal?.primaryDeal.shopName).toBe('Steam');
      expect(deal?.primaryDeal.salePrice).toBe(15.99);
      expect(deal?.primaryDeal.cutPercent).toBe(60);
    });

    it('should strictly reject Hades II and retain authentic Hades title for AppID 1145360', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1145360': {
                success: true,
                data: {
                  name: 'Hades',
                  price_overview: { initial: 2499, final: 2499, discount_percent: 0 },
                },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return {
            ok: true,
            json: async () => ({
              found: true,
              game: { id: 'uuid-hades-1', title: 'Hades' },
            }),
          };
        }
        if (urlStr.includes('/games/search/v1')) {
          return {
            ok: true,
            json: async () => [
              { id: 'uuid-hades-1', title: 'Hades', type: 'game' },
              { id: 'uuid-hades-2', title: 'Hades II', type: 'game' },
              { id: 'uuid-hades-star', title: "Hades' Star", type: 'game' },
            ],
          };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-hades-1',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 24.99 }, regular: { amount: 24.99 }, cut: 0, url: 'https://steam.com' },
                  { shop: { name: 'Epic Games Store' }, price: { amount: 24.99 }, regular: { amount: 24.99 }, cut: 0, url: 'https://epic.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return {
            ok: true,
            json: async () => [{ id: 'uuid-hades-1', low: { price: { amount: 12.49 } } }],
          };
        }
        return { ok: false };
      });

      const deal = await getGameDealInfo('1145360', 'USD');

      expect(deal).toBeDefined();
      // AppID 1145360 must strictly remain Hades, never overwritten with Hades II
      expect(deal?.title).toBe('Hades');
      expect(deal?.storeBreakdown['Steam'].salePrice).toBe(24.99);
      expect(deal?.storeBreakdown['Epic Games Store'].salePrice).toBe(24.99);
    });

    it('should retry transient ITAD HTTP 429 responses so the first cold request returns all stores', async () => {
      let pricesAttempts = 0;
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '2138720': {
                success: true,
                data: { name: 'REMATCH', price_overview: { initial: 3999, final: 1599, discount_percent: 60 } },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return { ok: true, json: async () => ({ found: true, game: { id: 'uuid-rematch', title: 'REMATCH' } }) };
        }
        if (urlStr.includes('/games/search/v1')) {
          return { ok: true, json: async () => [{ id: 'uuid-rematch', title: 'REMATCH', type: 'game' }] };
        }
        if (urlStr.includes('/games/prices/v3')) {
          pricesAttempts += 1;
          if (pricesAttempts === 1) {
            return { ok: false, status: 429, headers: { get: () => null } };
          }
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'uuid-rematch',
                deals: [
                  { shop: { name: 'Epic Games Store' }, price: { amount: 29.99 }, regular: { amount: 29.99 }, cut: 0, url: 'https://epic.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('2138720', 'USD');

      expect(pricesAttempts).toBe(2);
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['Epic Games Store']).toBeDefined();
    });

    it('should report degraded when primary ITAD prices query fails after retries', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '292030': {
                success: true,
                data: { name: 'The Witcher 3: Wild Hunt', price_overview: { initial: 4999, final: 4999, discount_percent: 0 } },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return { ok: true, json: async () => ({ found: true, game: { id: 'uuid-w3', title: 'The Witcher 3: Wild Hunt' } }) };
        }
        if (urlStr.includes('/games/prices/v3')) {
          throw new Error('connect ETIMEDOUT');
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('292030', 'USD');

      expect(deal?.alternativeCheckDegraded).toBe(true);
      expect(deal?.alternativeCheckStatus).toBe('degraded');
    });

    it('should skip secondary search when primary lookup already includes alternative storefronts', async () => {
      let searchCalled = false;
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1145360': {
                success: true,
                data: { name: 'Hades', price_overview: { initial: 2499, final: 2499, discount_percent: 0 } },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return { ok: true, json: async () => ({ found: true, game: { id: 'uuid-hades-primary', title: 'Hades' } }) };
        }
        if (urlStr.includes('/games/search/v1')) {
          searchCalled = true;
          return { ok: true, json: async () => [] };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'uuid-hades-primary',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 24.99 }, regular: { amount: 24.99 }, cut: 0, url: 'https://steam.com' },
                  { shop: { name: 'Epic Games Store' }, price: { amount: 24.99 }, regular: { amount: 24.99 }, cut: 0, url: 'https://epic.com' },
                  { shop: { name: 'GOG' }, price: { amount: 24.99 }, regular: { amount: 24.99 }, cut: 0, url: 'https://gog.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('1145360', 'USD');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(searchCalled).toBe(false);
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['Epic Games Store']).toBeDefined();
      expect(deal?.storeBreakdown['GOG']).toBeDefined();
    });

    it('should NOT trigger secondary search if an alternative store (e.g. GOG) was already found in primary prices', async () => {
      let searchCalled = false;
      let pricesCalls = 0;
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '292030': {
                success: true,
                data: { name: 'The Witcher 3: Wild Hunt', price_overview: { initial: 3999, final: 999, discount_percent: 75 } },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return { ok: true, json: async () => ({ found: true, game: { id: 'uuid-w3-base', title: 'The Witcher 3: Wild Hunt' } }) };
        }
        if (urlStr.includes('/games/search/v1')) {
          searchCalled = true;
          return {
            ok: true,
            json: async () => [
              { id: 'uuid-w3-complete', title: 'The Witcher 3: Wild Hunt - Complete Edition', type: 'game' },
            ],
          };
        }
        if (urlStr.includes('/games/prices/v3')) {
          pricesCalls++;
          if (pricesCalls === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => [
                {
                  id: 'uuid-w3-base',
                  deals: [
                    { shop: { name: 'Steam' }, price: { amount: 9.99 }, regular: { amount: 39.99 }, cut: 75, url: 'https://steam.com' },
                    { shop: { name: 'GOG' }, price: { amount: 9.99 }, regular: { amount: 39.99 }, cut: 75, url: 'https://gog.com' },
                  ],
                },
              ],
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'uuid-w3-complete',
                deals: [
                  { shop: { name: 'Epic Games Store' }, price: { amount: 12.49 }, regular: { amount: 49.99 }, cut: 75, url: 'https://epic.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('292030', 'USD');

      expect(deal).toBeDefined();
      expect(searchCalled).toBe(false);
      expect(pricesCalls).toBe(1);
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['GOG']).toBeDefined();
      expect(deal?.storeBreakdown['Epic Games Store']).toBeUndefined();
    });

    it('should be 100% resilient when Valve appdetails returns 429 and populate Steam from ITAD prices', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          // Valve returns HTTP 429 rate limit during cold burst
          return {
            ok: false,
            status: 429,
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return {
            ok: true,
            json: async () => ({
              found: true,
              game: { id: 'uuid-twd', title: 'The Walking Dead: The Telltale Definitive Series' },
            }),
          };
        }
        if (urlStr.includes('/games/search/v1')) {
          return { ok: true, json: async () => [] };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'uuid-twd',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 19.99 }, regular: { amount: 49.99 }, cut: 60, url: 'https://store.steampowered.com/app/1449690/' },
                  { shop: { name: 'Epic Games Store' }, price: { amount: 12.49 }, regular: { amount: 49.99 }, cut: 75, url: 'https://epic.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return { ok: true, status: 200, json: async () => [{ id: 'uuid-twd', low: { price: { amount: 9.99 } } }] };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('1449690', 'USD', 'The Walking Dead: The Telltale Definitive Series');

      expect(deal).toBeDefined();
      expect(deal?.title).toBe('The Walking Dead: The Telltale Definitive Series');
      expect(deal?.storeBreakdown['Steam']).toBeDefined();
      expect(deal?.storeBreakdown['Steam'].salePrice).toBe(19.99);
      expect(deal?.storeBreakdown['Epic Games Store']).toBeDefined();
      expect(deal?.storeBreakdown['Epic Games Store'].salePrice).toBe(12.49);
      expect(deal?.primaryDeal.shopName).toBe('Steam');
      expect(deal?.primaryDeal.salePrice).toBe(19.99);
      expect(deal?.cheaperAlternative?.shopName).toBe('Epic Games Store');
      expect(deal?.cheaperAlternative?.salePrice).toBe(12.49);
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
    });

    it('should enforce strict 1800ms ITAD timeout and fail fast with graceful Steam-only degraded fallback', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        let itadSignalAborted = false;
        globalThis.fetch = vi.fn(async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('store.steampowered.com/api/appdetails')) {
            return {
              ok: true,
              json: async () => ({
                '1029690': {
                  success: true,
                  data: {
                    name: 'Sniper Elite 5',
                    header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1029690/header.jpg',
                    price_overview: { initial: 4999, final: 4999, discount_percent: 0 },
                  },
                },
              }),
            };
          }
          if (urlStr.includes('isthereanydeal.com')) {
            return new Promise((_resolve, reject) => {
              if (init?.signal) {
                init.signal.addEventListener('abort', () => {
                  itadSignalAborted = true;
                  reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
              }
            });
          }
          return { ok: false, status: 404 };
        });

        const dealPromise = getGameDealInfo('1029690', 'USD', 'Sniper Elite 5');
        await vi.advanceTimersByTimeAsync(1800);
        const deal = await dealPromise;

        expect(itadSignalAborted).toBe(true);
        expect(deal).toBeDefined();
        expect(deal?.title).toBe('Sniper Elite 5');
        expect(deal?.alternativeCheckDegraded).toBe(true);
        expect(deal?.alternativeCheckStatus).toBe('degraded');
        expect(deal?.isPlatformExclusive).toBe(false);
        expect(deal?.primaryDeal.shopName).toBe('Steam');
        expect(deal?.primaryDeal.salePrice).toBe(49.99);
        expect(Object.keys(deal?.storeBreakdown || {})).toEqual(['Steam']);
      } finally {
        vi.useRealTimers();
        warnSpy.mockRestore();
      }
    });

    it('should resolve direct Steam AppID mapping via shop 61 before falling back to fuzzy title search', async () => {
      let fuzzySearchCalled = false;
      let shop61Body = null;

      globalThis.fetch = vi.fn(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1029690': {
                success: true,
                data: {
                  name: 'Sniper Elite 5',
                  price_overview: { initial: 4999, final: 4999, discount_percent: 0 },
                },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return {
            ok: true,
            json: async () => ({ found: false }),
          };
        }
        if (urlStr.includes('/lookup/id/shop/61/v1')) {
          shop61Body = JSON.parse(init?.body || '[]');
          return {
            ok: true,
            json: async () => ({
              'app/1029690': 'uuid-sniper-elite-5',
            }),
          };
        }
        if (urlStr.includes('/games/search/v1')) {
          fuzzySearchCalled = true;
          return { ok: true, json: async () => [] };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-sniper-elite-5',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 49.99 }, regular: { amount: 49.99 }, cut: 0, url: 'https://store.steampowered.com/app/1029690/' },
                  { shop: { name: 'Epic Games Store' }, price: { amount: 9.99 }, regular: { amount: 49.99 }, cut: 80, url: 'https://store.epicgames.com/p/sniper-elite-5' },
                  { shop: { name: 'Nuuvem' }, price: { amount: 12.49 }, regular: { amount: 49.99 }, cut: 75, url: 'https://nuuvem.com/item/sniper-elite-5' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return {
            ok: true,
            json: async () => [{ id: 'uuid-sniper-elite-5', low: { price: { amount: 9.99 } } }],
          };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('1029690', 'USD');

      expect(shop61Body).toEqual(['app/1029690']);
      expect(fuzzySearchCalled).toBe(false);
      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.storeBreakdown['Steam']?.salePrice).toBe(49.99);
      expect(deal?.storeBreakdown['Epic Games Store']?.salePrice).toBe(9.99);
      expect(deal?.storeBreakdown['Nuuvem']?.salePrice).toBe(12.49);
      expect(deal?.cheaperAlternative?.shopName).toBe('Epic Games Store');
    });

    it('should mark alternativeCheckDegraded true and isPlatformExclusive false when secondary search prices fail', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        globalThis.fetch = vi.fn(async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('store.steampowered.com/api/appdetails')) {
            return {
              ok: true,
              json: async () => ({
                '1029690': {
                  success: true,
                  data: {
                    name: 'Sniper Elite 5',
                    price_overview: { initial: 4999, final: 4999, discount_percent: 0 },
                  },
                },
              }),
            };
          }
          if (urlStr.includes('/games/lookup/v1')) {
            return {
              ok: true,
              json: async () => ({ found: true, game: { id: 'uuid-se5-base' } }),
            };
          }
          if (urlStr.includes('/games/prices/v3')) {
            const body = JSON.parse(init?.body || '[]');
            if (body.includes('uuid-se5-base')) {
              return {
                ok: true,
                json: async () => [
                  {
                    id: 'uuid-se5-base',
                    deals: [
                      { shop: { name: 'Steam' }, price: { amount: 49.99 }, regular: { amount: 49.99 }, cut: 0, url: 'https://steam.com' },
                    ],
                  },
                ],
              };
            }
            return { ok: false, status: 500 };
          }
          if (urlStr.includes('/games/search/v1')) {
            return {
              ok: true,
              json: async () => [
                { id: 'uuid-se5-complete', title: 'Sniper Elite 5: Complete Edition', type: 'game' },
              ],
            };
          }
          if (urlStr.includes('/games/historylow/v1')) {
            return { ok: true, json: async () => [] };
          }
          return { ok: false, status: 404 };
        });

        const deal = await getGameDealInfo('1029690', 'USD');

        expect(deal).toBeDefined();
        expect(deal?.alternativeCheckDegraded).toBe(true);
        expect(deal?.alternativeCheckStatus).toBe('degraded');
        expect(deal?.isPlatformExclusive).toBe(false);
        expect(deal?.storeBreakdown['Steam']?.salePrice).toBe(49.99);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should preserve all discovered stores when /games/historylow/v1 fails while /games/prices/v3 succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        globalThis.fetch = vi.fn(async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('store.steampowered.com/api/appdetails')) {
            return {
              ok: true,
              json: async () => ({
                '489830': {
                  success: true,
                  data: {
                    name: 'The Elder Scrolls V: Skyrim Special Edition',
                    price_overview: { initial: 3999, final: 1319, discount_percent: 67 },
                  },
                },
              }),
            };
          }
          if (urlStr.includes('/games/lookup/v1')) {
            return {
              ok: true,
              json: async () => ({ found: true, game: { id: 'uuid-skyrim-se' } }),
            };
          }
          if (urlStr.includes('/games/prices/v3')) {
            return {
              ok: true,
              json: async () => [
                {
                  id: 'uuid-skyrim-se',
                  deals: [
                    { shop: { name: 'Steam' }, price: { amount: 13.19 }, regular: { amount: 39.99 }, cut: 67, url: 'https://store.steampowered.com/app/489830/' },
                    { shop: { name: 'Nuuvem' }, price: { amount: 9.99 }, regular: { amount: 39.99 }, cut: 75, url: 'https://www.nuuvem.com/item/skyrim-se' },
                    { shop: { name: 'GOG' }, price: { amount: 11.99 }, regular: { amount: 39.99 }, cut: 70, url: 'https://www.gog.com/game/skyrim_se' },
                    { shop: { name: 'Epic Game Store' }, price: { amount: 13.19 }, regular: { amount: 39.99 }, cut: 67, url: 'https://store.epicgames.com/p/skyrim-se' },
                  ],
                },
              ],
            };
          }
          if (urlStr.includes('/games/historylow/v1')) {
            throw new Error('historylow timeout');
          }
          return { ok: false, status: 404 };
        });

        const deal = await getGameDealInfo('489830', 'USD', 'The Elder Scrolls V: Skyrim Special Edition');

        expect(deal).toBeDefined();
        expect(deal?.alternativeCheckDegraded).toBe(false);
        expect(deal?.alternativeCheckStatus).toBe('confirmed');
        expect(deal?.primaryDeal?.shopName).toBe('Steam');
        expect(deal?.primaryDeal?.salePrice).toBe(13.19);
        expect(deal?.cheaperAlternative?.shopName).toBe('Nuuvem');
        expect(deal?.cheaperAlternative?.salePrice).toBe(9.99);
        expect(Object.keys(deal?.storeBreakdown || {})).toEqual(
          expect.arrayContaining(['Steam', 'Nuuvem', 'GOG', 'Epic Games Store']),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should ingest chronological priceHistory from /games/history/v2, filter verified stores, and guarantee unbound lifetime ATL', async () => {
      const capturedUrls = [];
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        capturedUrls.push(urlStr);

        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1091500': {
                success: true,
                data: {
                  name: 'Cyberpunk 2077',
                  header_image: 'https://example.com/cyberpunk.jpg',
                  price_overview: { initial: 5999, final: 2999, discount_percent: 50 },
                },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return { ok: true, json: async () => ({ found: true, game: { id: 'uuid-cp-2077' } }) };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-cp-2077',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 29.99 }, regular: { amount: 59.99 }, cut: 50, url: 'https://store.steampowered.com/app/1091500/' },
                  { shop: { name: 'GOG' }, price: { amount: 29.99 }, regular: { amount: 59.99 }, cut: 50, url: 'https://gog.com/cyberpunk' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-cp-2077',
                low: { price: { amount: 19.99 } },
              },
            ],
          };
        }
        if (urlStr.includes('/games/history/v2')) {
          return {
            ok: true,
            json: async () => [
              {
                timestamp: '2025-11-28T10:00:00Z',
                shop: { id: 35, name: 'GOG' },
                deal: { price: { amount: 24.99 }, regular: { amount: 59.99 }, cut: 58 },
              },
              {
                timestamp: '2024-06-27T17:00:00Z',
                shop: { id: 61, name: 'Steam' },
                deal: { price: { amount: 29.99 }, regular: { amount: 59.99 }, cut: 50 },
              },
              {
                timestamp: '2024-12-19T18:00:00Z',
                shop: { id: 16, name: 'Epic Games Store' },
                deal: { price: { amount: 19.99 }, regular: { amount: 59.99 }, cut: 67 },
              },
              {
                timestamp: '2025-03-14T15:00:00Z',
                shop: { id: 50, name: 'Nuuvem' },
                deal: { price: { amount: 22.5 }, regular: { amount: 59.99 }, cut: 62 },
              },
              {
                timestamp: '2024-09-01T12:00:00Z',
                shop: { id: 99, name: 'UnauthorizedKeyShop' },
                deal: { price: { amount: 5.0 }, regular: { amount: 59.99 }, cut: 92 },
              },
            ],
          };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('1091500', 'USD', 'Cyberpunk 2077');

      const historyLowUrl = capturedUrls.find((u) => u.includes('/games/historylow/v1'));
      expect(historyLowUrl).toBeDefined();
      expect(historyLowUrl).not.toContain('since=');

      const historyLogUrl = capturedUrls.find((u) => u.includes('/games/history/v2'));
      expect(historyLogUrl).toBeDefined();
      expect(historyLogUrl).toContain('id=uuid-cp-2077');
      expect(historyLogUrl).toContain('country=US');
      expect(historyLogUrl).toContain(`shops=${ITAD_VERIFIED_SHOP_IDS.join(',')}`);
      expect(historyLogUrl).toContain('since=');
      expect(decodeURIComponent(historyLogUrl)).toMatch(/since=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

      expect(deal).toBeDefined();
      expect(deal?.allTimeLowPrice).toBe(19.99);
      expect(deal?.priceHistory).toBeDefined();
      expect(deal?.priceHistory?.length).toBe(4);

      // Verify strict chronological ascending sorting and unauthorized store exclusion
      expect(deal?.priceHistory?.map((p) => p.shopId)).toEqual(['steam', 'epic', 'nuuvem', 'gog']);
      expect(deal?.priceHistory?.[0].priceUsd).toBe(29.99);
      expect(deal?.priceHistory?.[0].priceBrl).toBeNull();
      expect(deal?.priceHistory?.[0].isAllTimeLow).toBe(false);

      expect(deal?.priceHistory?.[1].priceUsd).toBe(19.99);
      expect(deal?.priceHistory?.[1].isAllTimeLow).toBe(true);

      expect(deal?.priceHistory?.[2].priceUsd).toBe(22.5);
      expect(deal?.priceHistory?.[3].priceUsd).toBe(24.99);
    });

    it('should cap priceHistory to MAX_PRICE_HISTORY_POINTS while preserving start, end, and lifetime ATL inflection point', () => {
      const rawEntries = [];
      for (let i = 0; i < 30; i++) {
        const day = String(i + 1).padStart(2, '0');
        const isAtl = i === 12;
        rawEntries.push({
          timestamp: `2025-01-${day}T12:00:00Z`,
          shop: { id: 61, name: 'Steam' },
          deal: {
            price: { amount: isAtl ? 24.9 : 100 + (i % 5) * 10 },
            regular: { amount: 200 },
            cut: isAtl ? 88 : 50 - (i % 5) * 5,
          },
        });
      }

      const points = transformItadPriceHistory(rawEntries, 'BRL', 24.9, MAX_PRICE_HISTORY_POINTS);

      expect(points.length).toBe(MAX_PRICE_HISTORY_POINTS);
      expect(points[0].timestamp).toBe('2025-01-01T12:00:00.000Z');
      expect(points[points.length - 1].timestamp).toBe('2025-01-30T12:00:00.000Z');
      expect(points.every((p) => p.priceUsd === null && typeof p.priceBrl === 'number')).toBe(true);

      const atlPoints = points.filter((p) => p.isAllTimeLow);
      expect(atlPoints.length).toBeGreaterThanOrEqual(1);
      expect(atlPoints[0].priceBrl).toBe(24.9);

      for (let i = 1; i < points.length; i++) {
        expect(new Date(points[i].timestamp).getTime()).toBeGreaterThanOrEqual(
          new Date(points[i - 1].timestamp).getTime(),
        );
      }
    });

    it('should gracefully keep store deals and confirmed status when /games/history/v2 fails', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('store.steampowered.com/api/appdetails')) {
          return {
            ok: true,
            json: async () => ({
              '1086940': {
                success: true,
                data: {
                  name: "Baldur's Gate 3",
                  price_overview: { initial: 5999, final: 4799, discount_percent: 20 },
                },
              },
            }),
          };
        }
        if (urlStr.includes('/games/lookup/v1')) {
          return { ok: true, json: async () => ({ found: true, game: { id: 'uuid-bg3' } }) };
        }
        if (urlStr.includes('/games/prices/v3')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'uuid-bg3',
                deals: [
                  { shop: { name: 'Steam' }, price: { amount: 47.99 }, regular: { amount: 59.99 }, cut: 20, url: 'https://steam.com' },
                  { shop: { name: 'GOG' }, price: { amount: 44.99 }, regular: { amount: 59.99 }, cut: 25, url: 'https://gog.com' },
                ],
              },
            ],
          };
        }
        if (urlStr.includes('/games/historylow/v1')) {
          return { ok: true, json: async () => [{ id: 'uuid-bg3', low: { price: { amount: 44.99 } } }] };
        }
        if (urlStr.includes('/games/history/v2')) {
          return { ok: false, status: 500 };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('1086940', 'USD');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(deal?.allTimeLowPrice).toBe(44.99);
      expect(Array.isArray(deal?.priceHistory)).toBe(true);
      expect(deal?.priceHistory?.length).toBeGreaterThanOrEqual(2);
      expect(deal?.priceHistory?.some((p) => p.priceUsd === 44.99 && p.isAllTimeLow === true)).toBe(true);

      const directEntries = await fetchItadPriceHistory('uuid-bg3', 'USD', 'test_mock_itad_key', AbortSignal.timeout(500));
      expect(directEntries).toEqual([]);
    });

    it('should extract historyLow from /games/prices/v3 when current discount is 0% and /games/historylow/v1 fails', async () => {
      process.env.ITAD_API_KEY = 'test_mock_itad_key';

      globalThis.fetch = vi.fn(async (url) => {
        const strUrl = String(url);
        if (strUrl.includes('/lookup/id/shop/61/v1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ 'app/2807960': 'uuid-bf6' }),
          };
        }
        if (strUrl.includes('/games/prices/v3')) {
          return {
            ok: true,
            status: 200,
            json: async () => ([
              {
                id: 'uuid-bf6',
                historyLow: {
                  all: { amount: 119.6, currency: 'BRL' },
                  y1: { amount: 119.6, currency: 'BRL' },
                  m3: { amount: 149.5, currency: 'BRL' },
                },
                deals: [
                  {
                    shop: { id: 61, name: 'Steam' },
                    price: { amount: 299.0, currency: 'BRL' },
                    regular: { amount: 299.0, currency: 'BRL' },
                    cut: 0,
                    url: 'https://store.steampowered.com/app/2807960/',
                  },
                  {
                    shop: { id: 16, name: 'Epic Games Store' },
                    price: { amount: 299.0, currency: 'BRL' },
                    regular: { amount: 299.0, currency: 'BRL' },
                    cut: 0,
                    url: 'https://store.epicgames.com/en-US/p/battlefield-6',
                  },
                ],
              },
            ]),
          };
        }
        if (strUrl.includes('/games/historylow/v1') || strUrl.includes('/games/history/v2')) {
          return { ok: false, status: 500 };
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('2807960', 'BRL', 'Battlefield™ 6');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(deal?.primaryDeal.salePrice).toBe(299.0);
      expect(deal?.allTimeLowPrice).toBe(119.6);
      expect(deal?.isAllTimeLow).toBe(false);
      expect(deal?.priceHistory?.length).toBeGreaterThanOrEqual(2);
      expect(deal?.priceHistory?.some((p) => p.priceBrl === 119.6 && p.isAllTimeLow === true)).toBe(true);
    });

    it('should strip trademark symbols in sanitizeTitleForItadLookup, isStrictEditionMatch, and secondary search', async () => {
      process.env.ITAD_API_KEY = 'test_mock_itad_key';

      expect(sanitizeTitleForItadLookup('Battlefield™ 6')).toBe('Battlefield 6');
      expect(sanitizeTitleForItadLookup('Dying Light®: The Beast (TM)')).toBe('Dying Light: The Beast');
      expect(isStrictEditionMatch('Battlefield™ 6', 'Battlefield 6')).toBe(true);

      globalThis.fetch = vi.fn(async (url, options) => {
        const strUrl = String(url);
        if (strUrl.includes('/lookup/id/shop/61/v1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ 'app/2807960': 'uuid-bf6' }),
          };
        }
        if (strUrl.includes('/games/prices/v3')) {
          const reqBody = options?.body ? JSON.parse(String(options.body)) : [];
          if (Array.isArray(reqBody) && reqBody.includes('uuid-bf6-alt')) {
            return {
              ok: true,
              status: 200,
              json: async () => ([
                {
                  id: 'uuid-bf6-alt',
                  deals: [
                    {
                      shop: { id: 16, name: 'Epic Games Store' },
                      price: { amount: 249.0, currency: 'BRL' },
                      regular: { amount: 299.0, currency: 'BRL' },
                      cut: 17,
                      url: 'https://store.epicgames.com/p/battlefield-6',
                    },
                  ],
                },
              ]),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ([
              {
                id: 'uuid-bf6',
                deals: [
                  {
                    shop: { id: 61, name: 'Steam' },
                    price: { amount: 299.0, currency: 'BRL' },
                    regular: { amount: 299.0, currency: 'BRL' },
                    cut: 0,
                    url: 'https://store.steampowered.com/app/2807960/',
                  },
                ],
              },
            ]),
          };
        }
        if (strUrl.includes('/games/search/v1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ([
              { id: 'uuid-bf6-alt', title: 'Battlefield 6' },
            ]),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      });

      const deal = await getGameDealInfo('2807960', 'BRL', 'Battlefield™ 6');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.storeBreakdown?.['Epic Games Store']).toBeDefined();
      expect(deal?.cheaperAlternative?.shopName).toBe('Epic Games Store');
      expect(deal?.cheaperAlternative?.salePrice).toBe(249.0);
    });

    it('should isolate /games/history/v2 aborts so prices/v3 deals never degrade to Steam-only', async () => {
      process.env.ITAD_API_KEY = 'test_mock_itad_key';

      globalThis.fetch = vi.fn(async (url) => {
        const strUrl = String(url);
        if (strUrl.includes('/lookup/id/shop/61/v1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ 'app/3008130': 'uuid-dltb' }),
          };
        }
        if (strUrl.includes('/games/prices/v3')) {
          return {
            ok: true,
            status: 200,
            json: async () => ([
              {
                id: 'uuid-dltb',
                historyLow: { all: { amount: 113.81, currency: 'BRL' } },
                deals: [
                  {
                    shop: { id: 61, name: 'Steam' },
                    price: { amount: 249.0, currency: 'BRL' },
                    regular: { amount: 249.0, currency: 'BRL' },
                    cut: 0,
                    url: 'https://store.steampowered.com/app/3008130/',
                  },
                  {
                    shop: { id: 16, name: 'Epic Games Store' },
                    price: { amount: 249.0, currency: 'BRL' },
                    regular: { amount: 249.0, currency: 'BRL' },
                    cut: 0,
                    url: 'https://store.epicgames.com/p/dying-light-the-beast',
                  },
                ],
              },
            ]),
          };
        }
        if (strUrl.includes('/games/historylow/v1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ([
              { id: 'uuid-dltb', low: { amount: 113.81, currency: 'BRL' } },
            ]),
          };
        }
        if (strUrl.includes('/games/history/v2')) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        return { ok: false, status: 404 };
      });

      const deal = await getGameDealInfo('3008130', 'BRL', 'Dying Light: The Beast');

      expect(deal).toBeDefined();
      expect(deal?.alternativeCheckDegraded).toBe(false);
      expect(deal?.alternativeCheckStatus).toBe('confirmed');
      expect(deal?.storeBreakdown?.Steam).toBeDefined();
      expect(deal?.storeBreakdown?.['Epic Games Store']).toBeDefined();
      expect(deal?.allTimeLowPrice).toBe(113.81);
      expect(deal?.priceHistory?.length).toBeGreaterThanOrEqual(2);
    });
  });
  describe('fetchSteamStoreAppDetails', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('should return app details when Valve API responds within timeout', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          '2138720': {
            success: true,
            data: {
              name: 'REMATCH',
              price_overview: { initial: 3999, final: 1599, discount_percent: 60 },
            },
          },
        }),
      }));

      const details = await fetchSteamStoreAppDetails('2138720', 'us', undefined, 1500);

      expect(details).toBeDefined();
      expect(details?.name).toBe('REMATCH');
      expect(details?.price_overview?.final).toBe(1599);
    });

    it('should abort and return null when Valve API takes longer than timeoutMs', async () => {
      globalThis.fetch = vi.fn(async (_url, options) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({
                '2138720': { success: true, data: { name: 'REMATCH' } },
              }),
            });
          }, 200);

          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
        });
      });

      const details = await fetchSteamStoreAppDetails('2138720', 'us', undefined, 50);

      expect(details).toBeNull();
    });

    it('should return null when appId is empty', async () => {
      const details = await fetchSteamStoreAppDetails('', 'us');
      expect(details).toBeNull();
    });

    it('should return null when Valve responds with empty data array', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          '2999999': {
            success: true,
            data: [],
          },
        }),
      }));

      const details = await fetchSteamStoreAppDetails('2999999', 'us', undefined, 1500);
      expect(details).toBeNull();
    });
  });
});
