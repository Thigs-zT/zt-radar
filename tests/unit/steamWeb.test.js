import { describe, it, expect } from 'vitest';
import {
  calculateBacklogMsrp,
  compareLibraryData,
  matchLibraryData,
} from '../../src/utils/steamWeb.js';

describe('Steam Web Intelligence Utilities', () => {
  describe('calculateBacklogMsrp', () => {
    const mockBacklogList = [
      { appid: 10, name: 'Game on 50% Sale' },
      { appid: 20, name: 'Full Priced Game' },
      { appid: 30, name: 'Free-to-Play Title' },
      { appid: 40, name: 'Delisted Title' },
      { appid: 50, name: 'Unpriced / Unresolved Title' },
    ];

    const mockPriceMap = new Map([
      [10, { initial: 39.99, final: 19.99, currency: 'USD', finalFormatted: '$ 19.99', isFree: false, isDelisted: false }],
      [20, { initial: 0, final: 59.99, currency: 'USD', finalFormatted: '$ 59.99', isFree: false, isDelisted: false }],
      [30, { initial: 0, final: 0, currency: 'USD', finalFormatted: 'Free', isFree: true, isDelisted: false }],
      [40, { initial: 0, final: 0, currency: 'USD', finalFormatted: 'Delisted', isFree: false, isDelisted: true }],
    ]);

    it('should correctly sum base retail prices and skip free or delisted games in USD', () => {
      const msrpUsd = calculateBacklogMsrp(mockBacklogList, mockPriceMap, 'USD');

      expect(msrpUsd.totalMsrp).toBe(99.98);
      expect(msrpUsd.pricedCount).toBe(2);
      expect(msrpUsd.totalBacklog).toBe(5);
      expect(msrpUsd.currencySymbol).toBe('$');
      expect(msrpUsd.formattedTotalMsrp).toBe('$ 99.98');
      expect(msrpUsd.msrpSummary).toBe('$ 99.98 (2/5 priced)');
    });

    it('should correctly format regional BRL currency', () => {
      const msrpBrl = calculateBacklogMsrp(mockBacklogList, mockPriceMap, 'BRL');

      expect(msrpBrl.totalMsrp).toBe(99.98);
      expect(msrpBrl.currencySymbol).toBe('R$');
      expect(msrpBrl.formattedTotalMsrp).toBe('R$ 99.98');
      expect(msrpBrl.msrpSummary).toBe('R$ 99.98 (2/5 priced)');
    });

    it('should handle empty backlog list and empty price map gracefully', () => {
      const emptyResult = calculateBacklogMsrp([], new Map(), 'USD');

      expect(emptyResult.totalMsrp).toBe(0);
      expect(emptyResult.pricedCount).toBe(0);
      expect(emptyResult.totalBacklog).toBe(0);
      expect(emptyResult.msrpSummary).toBe('$ 0.00 (0/0 priced)');
    });

    it('should accept plain object as priceMap in addition to Map instances', () => {
      const plainObjPriceMap = {
        10: { initial: 19.99, isFree: false, isDelisted: false },
      };
      const result = calculateBacklogMsrp([{ appid: 10 }], plainObjPriceMap, 'USD');

      expect(result.totalMsrp).toBe(19.99);
      expect(result.pricedCount).toBe(1);
    });
  });

  describe('compareLibraryData', () => {
    const sampleGamesA = [
      { appid: 10, name: 'Counter-Strike', playtime_forever: 1200 }, // 20h
      { appid: 20, name: 'Team Fortress Classic', playtime_forever: 60 }, // 1h
      { appid: 30, name: 'Day of Defeat', playtime_forever: 300 }, // 5h
      { appid: 40, name: 'Deathmatch Classic', playtime_forever: 500 }, // Player A only
    ];

    const sampleGamesB = [
      { appid: 10, name: 'Counter-Strike', playtime_forever: 300 }, // 5h
      { appid: 20, name: 'Team Fortress Classic', playtime_forever: 600 }, // 10h
      { appid: 30, name: 'Day of Defeat', playtime_forever: 300 }, // 5h (tie)
      { appid: 50, name: 'Half-Life: Opposing Force', playtime_forever: 100 }, // Player B only
    ];

    it('should calculate dominance scores, win tallies, and overall winner', () => {
      const result = compareLibraryData(sampleGamesA, sampleGamesB);

      expect(result.totalCommon).toBe(3);
      expect(result.winsA).toBe(1); // Counter-Strike (1200 > 300)
      expect(result.winsB).toBe(1); // Team Fortress Classic (600 > 60)
      expect(result.ties).toBe(1);  // Day of Defeat (300 == 300)
      expect(result.overallWinner).toBe('TIE');
      expect(result.totalHoursA).toBe('26.0'); // (1200 + 60 + 300) / 60 = 26.0
      expect(result.totalHoursB).toBe('20.0'); // (300 + 600 + 300) / 60 = 20.0
    });

    it('should sort common games descending by combined total playtime', () => {
      const result = compareLibraryData(sampleGamesA, sampleGamesB);

      // AppID 10: 1200 + 300 = 1500 mins
      // AppID 20: 60 + 600 = 660 mins
      // AppID 30: 300 + 300 = 600 mins
      expect(result.commonGames[0].appid).toBe(10);
      expect(result.commonGames[0].winner).toBe('A');
      expect(result.commonGames[0].totalPlaytime).toBe(1500);

      expect(result.commonGames[1].appid).toBe(20);
      expect(result.commonGames[1].winner).toBe('B');
      expect(result.commonGames[1].totalPlaytime).toBe(660);

      expect(result.commonGames[2].appid).toBe(30);
      expect(result.commonGames[2].winner).toBe('TIE');
      expect(result.commonGames[2].totalPlaytime).toBe(600);
    });

    it('should handle empty or invalid input libraries gracefully', () => {
      const result = compareLibraryData(null, []);

      expect(result.commonCount).toBe(0);
      expect(result.winsA).toBe(0);
      expect(result.winsB).toBe(0);
      expect(result.overallWinner).toBe('TIE');
      expect(result.commonGames).toEqual([]);
    });
  });

  describe('matchLibraryData', () => {
    const mockLibraryA = [
      { appid: 550, name: 'Left 4 Dead 2', playtime_forever: 3000 },
      { appid: 105600, name: 'Terraria', playtime_forever: 1200 },
      { appid: 400, name: 'Portal', playtime_forever: 300 },
      { appid: 730, name: 'Counter-Strike 2', playtime_forever: 5000 },
    ];

    const mockLibraryB = [
      { appid: 550, name: 'Left 4 Dead 2', playtime_forever: 1500 },
      { appid: 105600, name: 'Terraria', playtime_forever: 600 },
      { appid: 400, name: 'Portal', playtime_forever: 400 },
      { appid: 1086940, name: "Baldur's Gate 3", playtime_forever: 8000 },
    ];

    it('should filter co-op titles and intersect common AppIDs in coop mode', () => {
      const coopMatch = matchLibraryData(mockLibraryA, mockLibraryB, 'coop');

      expect(coopMatch.success).toBe(true);
      expect(coopMatch.totalCommon).toBe(3); // L4D2 (550), Terraria (105600), Portal (400)
      expect(coopMatch.matchingGames.length).toBe(2); // L4D2 and Terraria (Portal is SP)

      expect(coopMatch.matchingGames[0].appid).toBe(550);
      expect(coopMatch.matchingGames[0].isCoop).toBe(true);
      expect(coopMatch.matchingGames[0].badges).toContain('Online Co-op');

      expect(coopMatch.matchingGames[1].appid).toBe(105600);
      expect(coopMatch.matchingGames[1].isCoop).toBe(true);
    });

    it('should include all intersected titles when filterMode is all', () => {
      const allMatch = matchLibraryData(mockLibraryA, mockLibraryB, 'all');

      expect(allMatch.totalCommon).toBe(3);
      expect(allMatch.matchingGames.length).toBe(3);
      expect(allMatch.matchingGames.some((g) => g.appid === 400)).toBe(true);
    });

    it('should sort matching games descending by combined playtime', () => {
      const allMatch = matchLibraryData(mockLibraryA, mockLibraryB, 'all');

      // L4D2: 3000 + 1500 = 4500
      // Terraria: 1200 + 600 = 1800
      // Portal: 300 + 400 = 700
      expect(allMatch.matchingGames[0].appid).toBe(550);
      expect(allMatch.matchingGames[1].appid).toBe(105600);
      expect(allMatch.matchingGames[2].appid).toBe(400);
    });

    it('should return safe fallback on invalid inputs', () => {
      const result = matchLibraryData(null, undefined);

      expect(result.totalCommon).toBe(0);
      expect(result.matchedCount).toBe(0);
      expect(result.games).toEqual([]);
    });
  });
});
