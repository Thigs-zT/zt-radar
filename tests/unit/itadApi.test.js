import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  formatPriceComparisonDiff,
  formatExpiryAvailability,
  getMarketOverviewDeals,
  getGameDealInfo,
} from '../../src/utils/itadApi.js';

describe('ITAD API Utilities', () => {
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
  });
});
