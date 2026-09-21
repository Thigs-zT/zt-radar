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
  describe('STEAM_SALES_SCHEDULE Dataset Integrity (Verified SteamDB 2026)', () => {
    it('should contain verified seasonal sales and major festivals for 2026-2027', () => {
      expect(STEAM_SALES_SCHEDULE.length).toBeGreaterThanOrEqual(8);

      const seasonalSales = STEAM_SALES_SCHEDULE.filter((e) => e.type === 'seasonal');
      const festivals = STEAM_SALES_SCHEDULE.filter((e) => e.type === 'fest');

      expect(seasonalSales.length).toBeGreaterThanOrEqual(4);
      expect(festivals.length).toBeGreaterThanOrEqual(4);

      const saleNames = STEAM_SALES_SCHEDULE.map((s) => s.name);
      expect(saleNames).toContain('Steam Spring Sale 2026');
      expect(saleNames).toContain('Steam Summer Sale 2026');
      expect(saleNames).toContain('Autumn Sale 2026');
      expect(saleNames).toContain('Cooking Fest');
      expect(saleNames).toContain('Steam Next Fest (October 2026)');
      expect(saleNames).toContain('Steam Scream V Fest (Halloween)');
      expect(saleNames).toContain('Auto-Battler RPG Fest');
      expect(saleNames).toContain('Winter Sale 2026');
    });

    it('should enforce verified SteamDB schedule dates and properties', () => {
      const autumn = STEAM_SALES_SCHEDULE.find((e) => e.name === 'Autumn Sale 2026');
      expect(autumn).toBeDefined();
      expect(autumn?.startDate).toBe('2026-10-01T17:00:00Z');
      expect(autumn?.endDate).toBe('2026-10-08T17:00:00Z');
      expect(autumn?.type).toBe('seasonal');
      expect(autumn?.banner).toBe(
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/clusters/sale_autumn2024/0e84c9df4f71a4fdb23e9860/header_english.jpg'
      );

      const cooking = STEAM_SALES_SCHEDULE.find((e) => e.name === 'Cooking Fest');
      expect(cooking?.startDate).toBe('2026-10-12T17:00:00Z');
      expect(cooking?.endDate).toBe('2026-10-19T17:00:00Z');
      expect(cooking?.type).toBe('fest');

      const nextFestOct = STEAM_SALES_SCHEDULE.find((e) => e.name === 'Steam Next Fest (October 2026)');
      expect(nextFestOct?.startDate).toBe('2026-10-19T17:00:00Z');
      expect(nextFestOct?.endDate).toBe('2026-10-26T17:00:00Z');
      expect(nextFestOct?.type).toBe('fest');

      const screamFest = STEAM_SALES_SCHEDULE.find((e) => e.name === 'Steam Scream V Fest (Halloween)');
      expect(screamFest?.startDate).toBe('2026-10-26T17:00:00Z');
      expect(screamFest?.endDate).toBe('2026-11-02T17:00:00Z');
      expect(screamFest?.type).toBe('fest');

      const autoBattler = STEAM_SALES_SCHEDULE.find((e) => e.name === 'Auto-Battler RPG Fest');
      expect(autoBattler?.startDate).toBe('2026-11-16T17:00:00Z');
      expect(autoBattler?.endDate).toBe('2026-11-23T17:00:00Z');
      expect(autoBattler?.type).toBe('fest');

      const winter = STEAM_SALES_SCHEDULE.find((e) => e.name === 'Winter Sale 2026');
      expect(winter?.startDate).toBe('2026-12-17T17:00:00Z');
      expect(winter?.endDate).toBe('2027-01-07T17:00:00Z');
      expect(winter?.type).toBe('seasonal');
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
      const testDate = new Date('2026-06-28T12:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(true);
      expect(status.sale).not.toBeNull();
      expect(status.sale?.name).toBe('Steam Summer Sale 2026');
      expect(status.sale?.type).toBe('seasonal');
    });

    it('should accurately detect active Autumn Sale 2026 during its verified schedule window', () => {
      const testDate = new Date('2026-10-04T12:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(true);
      expect(status.sale?.name).toBe('Autumn Sale 2026');
      expect(status.sale?.type).toBe('seasonal');
    });

    it('should accurately detect active Cooking Fest during its festival window', () => {
      const testDate = new Date('2026-10-15T10:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(true);
      expect(status.sale?.name).toBe('Cooking Fest');
      expect(status.sale?.type).toBe('fest');
    });

    it('should resolve the immediate next upcoming sale when between events', () => {
      // 2026-09-21 is after Space Exploration Fest and before Autumn Sale 2026
      const testDate = new Date('2026-09-21T14:00:00Z');
      const status = getCurrentOrNextSale(testDate);

      expect(status.isActive).toBe(false);
      expect(status.sale).not.toBeNull();
      expect(status.sale?.name).toBe('Autumn Sale 2026');
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

      expect(upcoming.length).toBe(5);
      expect(upcoming[0].name).toBe('Autumn Sale 2026');
      expect(upcoming[1].name).toBe('Cooking Fest');
      expect(upcoming[2].name).toBe('Steam Next Fest (October 2026)');
      expect(upcoming[3].name).toBe('Steam Scream V Fest (Halloween)');
      expect(upcoming[4].name).toBe('Auto-Battler RPG Fest');

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
    it('should construct a Discord embed without codeblocks around timestamps, and with image banner & action button', () => {
      const testDate = new Date('2026-09-21T12:00:00Z');
      const payload = buildSalesCalendarEmbed(testDate);

      expect(payload.embed).toBeDefined();
      expect(payload.embed.title).toContain('Steam Sales & Major Events Calendar');
      expect(payload.embed.color).toBe(BRAND_COLORS.STEAM);
      expect(payload.embed.image?.url).toBe(
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/clusters/sale_autumn2024/0e84c9df4f71a4fdb23e9860/header_english.jpg'
      );
      expect(payload.embed.footer?.text).toContain('Valve Steam Official Schedule');
      expect(payload.embed.timestamp).toBeDefined();

      // Spotlight description verification (pure markdown, NO codeblocks breaking timestamps)
      expect(payload.embed.description).not.toContain('```');
      expect(payload.embed.description).not.toContain('```ansi');
      expect(payload.embed.description).toContain('## ❖ Spotlight: Autumn Sale 2026');
      expect(payload.embed.description).toContain('▸ **Type**: Major Seasonal Sale');
      expect(payload.embed.description).toContain('▸ **Starts**: <t:1790874000:R> (<t:1790874000:D>)');
      expect(payload.embed.description).toContain('▸ **Duration**: 7 Days (Ends <t:1791478800:D>)');
      expect(payload.embed.description).toContain('└─ Massive storewide discounts across thousands of PC games.');

      // Upcoming timeline field verification
      expect(payload.embed.fields?.length).toBe(1);
      const scheduleField = payload.embed.fields?.[0];
      expect(scheduleField?.name).toBe('❖ Upcoming Events Timeline');
      expect(scheduleField?.value).not.toContain('```');
      // Redundancy check: Spotlighted Autumn Sale 2026 must be excluded from timeline
      expect(scheduleField?.value).not.toContain('Autumn Sale 2026');
      expect(scheduleField?.value).toContain('▸ **Cooking Fest** • <t:1791824400:d> (<t:1791824400:R>)');
      expect(scheduleField?.value).toContain('▸ **Steam Next Fest (October)** • <t:1792429200:d> (<t:1792429200:R>)');
      expect(scheduleField?.value).toContain('▸ **Steam Scream V Fest** • <t:1793034000:d> (<t:1793034000:R>)');
      expect(scheduleField?.value).toContain('▸ **Auto-Battler RPG Fest** • <t:1794848400:d> (<t:1794848400:R>)');
      expect(scheduleField?.value).toContain('▸ **Winter Sale 2026** • <t:1797526800:d> (<t:1797526800:R>)');

      // Link button verification
      expect(payload.components).toHaveLength(1);
      const button = payload.components[0].components[0];
      expect(button.type).toBe(2); // BUTTON
      expect(button.style).toBe(5); // LINK
      expect(button.label).toBe('View on SteamDB');
      expect(button.url).toBe('https://steamdb.info/sales/history/');
    });

    it('should highlight active promotion when current time falls within active sale', () => {
      const testDate = new Date('2026-10-04T12:00:00Z'); // during Autumn Sale 2026
      const payload = buildSalesCalendarEmbed(testDate);

      expect(payload.embed.description).not.toContain('```');
      expect(payload.embed.description).toContain('## ❖ Active Now: Autumn Sale 2026');
      expect(payload.embed.description).toContain('▸ **Type**: Major Seasonal Sale');
      expect(payload.embed.description).toContain('▸ **Ends**: <t:1791478800:R> (<t:1791478800:D>)');
      expect(payload.embed.description).toContain('▸ **Duration**: 7 Days (Started <t:1790874000:D>)');

      // Schedule list should not duplicate the active spotlighted sale
      const scheduleField = payload.embed.fields?.[0];
      expect(scheduleField?.value).not.toContain('Autumn Sale 2026');
      expect(scheduleField?.value).toContain('Cooking Fest');
      expect(scheduleField?.value).toContain('Winter Sale 2026');
    });
  });

  describe('formatHardwareSpecs (steamIntel.ts)', () => {
    it('should format fallback when developer specs are not provided', () => {
      expect(formatHardwareSpecs('')).toBe('```yaml\nStatus: Not specified by developer.\n```');
      expect(formatHardwareSpecs('Not specified by developer.')).toBe('```yaml\nStatus: Not specified by developer.\n```');
    });

    it('should structure raw specs into clean, boxed yaml lines', () => {
      const raw = `Minimum:
OS: Windows 10 64-bit
Processor: Intel Core i5-8400 or AMD Ryzen 5 2600
Memory: 16 GB RAM
Graphics: NVIDIA GeForce GTX 1060 (6 GB) or AMD Radeon RX 580 (8 GB)
DirectX: Version 12
Storage: 65 GB available space`;

      const formatted = formatHardwareSpecs(raw);
      expect(formatted).toContain('```yaml');
      expect(formatted).toContain('OS:        Windows 10 64-bit');
      expect(formatted).toContain('Processor: Intel Core i5-8400 or AMD Ryzen 5 2600');
      expect(formatted).toContain('Memory:    16 GB RAM');
      expect(formatted).toContain('Graphics:  NVIDIA GeForce GTX 1060 (6 GB) or AMD Radeon RX 580 (8 GB)');
      expect(formatted).toContain('DirectX:   Version 12');
      expect(formatted).toContain('Storage:   65 GB available space');
      expect(formatted).not.toContain('Minimum:');
    });
  });
});
