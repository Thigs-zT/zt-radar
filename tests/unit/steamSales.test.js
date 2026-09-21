import { describe, it, expect } from 'vitest';
import {
  STEAM_SALES_SCHEDULE,
  getCurrentOrNextSale,
  getUpcomingSales,
  buildSalesCalendarEmbed,
} from '../../src/utils/steamSales.js';
import { formatHardwareSpecs } from '../../src/utils/steamIntel.js';
import { BRAND_COLORS } from '../../src/utils/theme.js';

describe('Steam Sales Calendar Utility (steamSales.ts)', () => {
  describe('STEAM_SALES_SCHEDULE Dataset Integrity', () => {
    it('should contain curated seasonal sales and major festivals for 2026-2027', () => {
      expect(STEAM_SALES_SCHEDULE.length).toBeGreaterThanOrEqual(10);

      const seasonalSales = STEAM_SALES_SCHEDULE.filter((e) => e.type === 'seasonal');
      const festivals = STEAM_SALES_SCHEDULE.filter((e) => e.type === 'fest');

      expect(seasonalSales.length).toBeGreaterThanOrEqual(4);
      expect(festivals.length).toBeGreaterThanOrEqual(6);

      const saleNames = STEAM_SALES_SCHEDULE.map((s) => s.name);
      expect(saleNames).toContain('Steam Spring Sale 2026');
      expect(saleNames).toContain('Steam Summer Sale 2026');
      expect(saleNames).toContain('Steam Autumn Sale 2026');
      expect(saleNames).toContain('Steam Winter Sale 2026');
    });

    it('should enforce chronological UTC date ranges and non-empty descriptions', () => {
      for (const event of STEAM_SALES_SCHEDULE) {
        expect(event.name).toBeTruthy();
        expect(['seasonal', 'fest']).toContain(event.type);
        expect(event.description).toBeTruthy();

        const startTime = new Date(event.startDate).getTime();
        const endTime = new Date(event.endDate).getTime();

        expect(isNaN(startTime)).toBe(false);
        expect(isNaN(endTime)).toBe(false);
        expect(startTime).toBeLessThan(endTime);
      }
    });
  });

  describe('getCurrentOrNextSale', () => {
    it('should accurately detect an active seasonal sale when within the sale window', () => {
      // 2026-06-28 falls inside Steam Summer Sale (2026-06-25 to 2026-07-09)
      const testDate = new Date('2026-06-28T12:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(true);
      expect(status.sale).not.toBeNull();
      expect(status.sale?.name).toBe('Steam Summer Sale 2026');
      expect(status.sale?.type).toBe('seasonal');
    });

    it('should accurately detect an active major festival when within the festival window', () => {
      // 2026-10-15 falls inside Steam Next Fest: October 2026 (2026-10-12 to 2026-10-19)
      const testDate = new Date('2026-10-15T10:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(true);
      expect(status.sale?.name).toBe('Steam Next Fest: October 2026');
      expect(status.sale?.type).toBe('fest');
    });

    it('should resolve the immediate next upcoming sale when between events', () => {
      // 2026-09-21 is after Space Fest (ended 2026-09-14) and before Next Fest Oct (starts 2026-10-12)
      const testDate = new Date('2026-09-21T14:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(false);
      expect(status.sale).not.toBeNull();
      expect(status.sale?.name).toBe('Steam Next Fest: October 2026');
    });

    it('should return null when all scheduled events have concluded', () => {
      const farFuture = new Date('2028-01-01T00:00:00Z');
      const status = getCurrentOrNextSale(farFuture);

      expect(status.isActive).toBe(false);
      expect(status.sale).toBeNull();
    });
  });

  describe('getUpcomingSales', () => {
    it('should return a chronological list of future events with default limit', () => {
      const testDate = new Date('2026-09-21T12:00:00Z');
      const upcoming = getUpcomingSales(5, testDate);

      expect(upcoming.length).toBeLessThanOrEqual(5);
      expect(upcoming[0].name).toBe('Steam Next Fest: October 2026');
      expect(upcoming[1].name).toBe('Steam Scream Fest (Halloween 2026)');
      expect(upcoming[2].name).toBe('Steam Autumn Sale 2026');
      expect(upcoming[3].name).toBe('Steam Winter Sale 2026');

      for (let i = 0; i < upcoming.length - 1; i++) {
        const curr = new Date(upcoming[i].startDate).getTime();
        const next = new Date(upcoming[i + 1].startDate).getTime();
        expect(curr).toBeLessThanOrEqual(next);
      }
    });

    it('should respect custom limit parameter', () => {
      const testDate = new Date('2026-01-01T00:00:00Z');
      const upcoming = getUpcomingSales(3, testDate);

      expect(upcoming.length).toBe(3);
    });
  });

  describe('buildSalesCalendarEmbed', () => {
    it('should construct a Discord embed with brand color, countdowns, and action button for upcoming sale', () => {
      const testDate = new Date('2026-09-21T12:00:00Z');
      const payload = buildSalesCalendarEmbed(testDate);

      expect(payload.embed).toBeDefined();
      expect(payload.embed.title).toBe('zT Radar ❖ Steam Seasonal Sales & Major Fests Calendar');
      expect(payload.embed.color).toBe(BRAND_COLORS.STEAM);
      expect(payload.embed.footer?.text).toContain('Valve Steam Official Schedule');
      expect(payload.embed.timestamp).toBeDefined();

      // Spotlight description verification
      expect(payload.embed.description).toContain('Next Confirmed Steam Event Spotlight');
      expect(payload.embed.description).toContain('Steam Next Fest: October 2026');
      expect(payload.embed.description).toContain('Countdown: Starts <t:');
      expect(payload.embed.description).toContain(':R>');

      // Upcoming schedule field verification
      expect(payload.embed.fields?.length).toBe(1);
      const scheduleField = payload.embed.fields?.[0];
      expect(scheduleField?.name).toBe('❖ Upcoming Steam Promotions & Major Festivals');
      expect(scheduleField?.value).toContain('Steam Scream Fest (Halloween 2026)');
      expect(scheduleField?.value).toContain('Steam Autumn Sale 2026');
      expect(scheduleField?.value).toContain('Steam Winter Sale 2026');

      // Link button verification
      expect(payload.components).toHaveLength(1);
      const button = payload.components[0].components[0];
      expect(button.type).toBe(2); // BUTTON
      expect(button.style).toBe(5); // LINK
      expect(button.label).toBe('Steam Sales History (SteamDB)');
      expect(button.url).toBe('https://steamdb.info/sales/history/');
    });

    it('should highlight active promotion when current time falls within active sale', () => {
      const testDate = new Date('2026-11-26T12:00:00Z'); // during Autumn Sale
      const payload = buildSalesCalendarEmbed(testDate);

      expect(payload.embed.description).toContain('★ **ACTIVE NOW — Ends <t:');
      expect(payload.embed.description).toContain('Steam Autumn Sale 2026');
      expect(payload.embed.description).toContain('[Seasonal Sale]');

      // Schedule list should not duplicate the active spotlighted sale
      const scheduleField = payload.embed.fields?.[0];
      expect(scheduleField?.value).not.toContain('Steam Autumn Sale 2026');
      expect(scheduleField?.value).toContain('Steam Winter Sale 2026');
    });
  });

  describe('formatHardwareSpecs (steamIntel.ts)', () => {
    it('should format fallback when developer specs are not provided', () => {
      expect(formatHardwareSpecs('')).toBe('▸ *Not specified by developer.*');
      expect(formatHardwareSpecs('Not specified by developer.')).toBe('▸ *Not specified by developer.*');
    });

    it('should structure raw specs into clean, tagged hardware lines', () => {
      const raw = `Minimum:
OS: Windows 10 64-bit
Processor: Intel Core i5-8400 or AMD Ryzen 5 2600
Memory: 16 GB RAM
Graphics: NVIDIA GeForce GTX 1060 (6 GB) or AMD Radeon RX 580 (8 GB)
DirectX: Version 12
Storage: 65 GB available space`;

      const formatted = formatHardwareSpecs(raw);
      expect(formatted).toContain('▸ **OS:** Windows 10 64-bit');
      expect(formatted).toContain('▸ **Processor:** Intel Core i5-8400 or AMD Ryzen 5 2600');
      expect(formatted).toContain('▸ **Memory:** 16 GB RAM');
      expect(formatted).toContain('▸ **Graphics:** NVIDIA GeForce GTX 1060 (6 GB) or AMD Radeon RX 580 (8 GB)');
      expect(formatted).toContain('▸ **DirectX:** Version 12');
      expect(formatted).toContain('▸ **Storage:** 65 GB available space');
      expect(formatted).not.toContain('Minimum:');
    });
  });
});
