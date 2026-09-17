import { describe, it, expect } from 'vitest';
import {
  calculateBacklogMsrp,
  compareLibraryData,
  matchLibraryData,
  buildDuelEmbedPayload,
  buildAchievementsEmbedPayload,
} from '../../src/utils/steamWeb.js';
import { BRAND_COLORS } from '../../src/utils/theme.js';

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

// ---------------------------------------------------------------------------
// buildDuelEmbedPayload — Symmetrical Dual Embed Architecture
// ---------------------------------------------------------------------------
describe('buildDuelEmbedPayload (symmetrical dual embeds)', () => {
  const mockComparison = {
    commonCount: 3,
    totalCommon: 3,
    winsA: 2,
    winsB: 1,
    ties: 0,
    overallWinner: 'A',
    totalHoursA: '45.0',
    totalHoursB: '30.0',
    countA: 120,
    countB: 85,
    commonGames: [
      { appid: 730, name: 'Counter-Strike 2', playtimeA: 1200, playtimeB: 300, totalPlaytime: 1500, winner: 'A', diffMinutes: 900, hoursA: '20.0', hoursB: '5.0', diffHours: '15.0' },
      { appid: 570, name: 'Dota 2', playtimeA: 60, playtimeB: 600, totalPlaytime: 660, winner: 'B', diffMinutes: 540, hoursA: '1.0', hoursB: '10.0', diffHours: '9.0' },
      { appid: 440, name: 'Team Fortress 2', playtimeA: 300, playtimeB: 300, totalPlaytime: 600, winner: 'TIE', diffMinutes: 0, hoursA: '5.0', hoursB: '5.0', diffHours: '0.0' },
    ],
  };

  const summaryA = {
    personaName: 'AlphaPlayer',
    steamId: '76561198000000001',
    avatarUrl: 'https://example.com/avatarA.jpg',
    timeCreated: '2010-05-15',
  };

  const summaryB = {
    personaName: 'BetaPlayer',
    steamId: '76561198000000002',
    avatarUrl: 'https://example.com/avatarB.jpg',
    timeCreated: '2012-11-20',
  };

  it('should return exactly two synchronized embeds in the embeds array', () => {
    const { embed, embeds } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1);
    expect(embeds).toHaveLength(2);
    expect(embeds[0]).toBe(embed);
    expect(embeds[0].color).toBe(BRAND_COLORS.STEAM);
    expect(embeds[1].color).toBe(BRAND_COLORS.DISCORD_BLURPLE);
  });

  it('should set symmetrical thumbnails on both embeds with no author icon', () => {
    const { embeds } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1);
    expect(embeds[0].thumbnail?.url).toBe(summaryA.avatarUrl);
    expect(embeds[1].thumbnail?.url).toBe(summaryB.avatarUrl);
    expect(embeds[0].author).toBeUndefined();
    expect(embeds[1].author).toBeUndefined();
  });

  it('should include the ANSI scoreboard block in Player B description with player names and win counts', () => {
    const { embeds } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1);
    // Strip ANSI escape codes before asserting plain-text content
    const plain = embeds[1].description.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('Steam Library Duel Scoreboard');
    expect(plain).toContain('AlphaPlayer');
    expect(plain).toContain('BetaPlayer');
    expect(plain).toContain('[ 2 ]');
    expect(plain).toContain('[ 1 ]');
    expect(plain).toContain('DOMINATES');
  });

  it('should include Steam Level and Badge enrichment fields on respective embeds when provided', () => {
    const { embeds } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1, 45, 32, 120, 85);
    const levelFieldA = embeds[0].fields?.find((f) => f.name.includes('Steam Level'));
    const levelFieldB = embeds[1].fields?.find((f) => f.name.includes('Steam Level'));
    const badgeFieldA = embeds[0].fields?.find((f) => f.name.includes('Badges'));
    const badgeFieldB = embeds[1].fields?.find((f) => f.name.includes('Badges'));
    expect(levelFieldA?.value).toContain('Lv. 45');
    expect(levelFieldB?.value).toContain('Lv. 32');
    expect(badgeFieldA?.value).toContain('120 badges');
    expect(badgeFieldB?.value).toContain('85 badges');
  });

  it('should include Account Since field on respective embeds when account ages are provided', () => {
    const { embeds } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1, null, null, null, null, '2010-05-15', '2012-11-20');
    const ageFieldA = embeds[0].fields?.find((f) => f.name.includes('Account Since'));
    const ageFieldB = embeds[1].fields?.find((f) => f.name.includes('Account Since'));
    expect(ageFieldA?.value).toContain('2010-05-15');
    expect(ageFieldB?.value).toContain('2012-11-20');
  });

  it('should include the shared titles diff block as a field in Player B embed', () => {
    const { embeds } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1);
    const sharedField = embeds[1].fields?.find((f) => f.name.includes('Shared Titles'));
    expect(sharedField).toBeDefined();
    expect(sharedField?.value).toContain('Counter-Strike 2');
  });

  it('should encode pagination button custom_id with duel_p: prefix', () => {
    // With 3 games, PAGE_SIZE=4 => 1 page, no pagination buttons
    const { components } = buildDuelEmbedPayload(mockComparison, summaryA, summaryB, 1);
    expect(components).toHaveLength(0);

    // Add more games to trigger pagination
    const bigComparison = {
      ...mockComparison,
      commonGames: [
        ...mockComparison.commonGames,
        { appid: 105600, name: 'Terraria', playtimeA: 500, playtimeB: 200, totalPlaytime: 700, winner: 'A', diffMinutes: 300, hoursA: '8.3', hoursB: '3.3', diffHours: '5.0' },
        { appid: 413150, name: 'Stardew Valley', playtimeA: 100, playtimeB: 100, totalPlaytime: 200, winner: 'TIE', diffMinutes: 0, hoursA: '1.7', hoursB: '1.7', diffHours: '0.0' },
      ],
    };
    const { components: paginatedComponents } = buildDuelEmbedPayload(bigComparison, summaryA, summaryB, 1);
    expect(paginatedComponents).toHaveLength(1);
    const btns = paginatedComponents[0].components;
    expect(btns[0].custom_id).toMatch(/^duel_p:/);
    expect(btns[1].custom_id).toMatch(/^duel_p:/);
    expect(btns[0].custom_id).toContain('76561198000000001');
    expect(btns[0].custom_id).toContain('76561198000000002');
  });
});

// ---------------------------------------------------------------------------
// buildAchievementsEmbedPayload — Achievement Embed Builder
// ---------------------------------------------------------------------------
describe('buildAchievementsEmbedPayload', () => {
  const mockSummary = {
    personaName: 'GamerXP',
    steamId: '76561198000000001',
    avatarUrl: 'https://example.com/avatar.jpg',
  };

  const makeAchievementResult = (percent, unlocked, total) => ({
    total,
    unlocked,
    percent,
    gameName: 'Half-Life 2',
    achievements: [
      ...Array.from({ length: unlocked }, (_, i) => ({
        apiName: `ACH_UNLOCKED_${i}`,
        displayName: `Unlocked Achievement ${i + 1}`,
        description: `Description for unlocked ${i + 1}`,
        achieved: true,
        unlockTime: 1700000000 - i * 1000,
      })),
      ...Array.from({ length: total - unlocked }, (_, i) => ({
        apiName: `ACH_LOCKED_${i}`,
        displayName: `Locked Achievement ${i + 1}`,
        description: `Description for locked ${i + 1}`,
        achieved: false,
        unlockTime: 0,
      })),
    ],
  });

  it('should return SUCCESS green color when percent >= 80', () => {
    const result = makeAchievementResult(85, 17, 20);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    expect(embed.color).toBe(0x2ecc71);
  });

  it('should return ATL_GOLD yellow color when percent is 40-79', () => {
    const result = makeAchievementResult(55, 11, 20);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    expect(embed.color).toBe(0xf1c40f);
  });

  it('should return ALERT_CRIMSON red color when percent < 40', () => {
    const result = makeAchievementResult(25, 5, 20);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    expect(embed.color).toBe(0xe74c3c);
  });

  it('should include ANSI progress bar in the description', () => {
    const result = makeAchievementResult(50, 5, 10);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    expect(embed.description).toContain('```ansi');
    expect(embed.description).toContain('50%');
    expect(embed.description).toContain('5');
    expect(embed.description).toContain('10');
  });

  it('should set author.name with player persona name', () => {
    const result = makeAchievementResult(100, 5, 5);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Any Game');
    expect(embed.author?.name).toContain('GamerXP');
  });

  it('should use gameName from result over gameTitle fallback', () => {
    const result = makeAchievementResult(50, 5, 10);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Raw Autocomplete Value');
    expect(embed.title).toBe('Half-Life 2');
  });

  it('should include Recently Unlocked and Next Targets fields when achievements exist', () => {
    const result = makeAchievementResult(50, 5, 10);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    const unlockedField = embed.fields?.find((f) => f.name.includes('Recently Unlocked'));
    const lockedField = embed.fields?.find((f) => f.name.includes('Next Targets'));
    expect(unlockedField).toBeDefined();
    expect(lockedField).toBeDefined();
  });

  it('should return a single embed and empty components array', () => {
    const result = makeAchievementResult(50, 5, 10);
    const { embeds, components } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    expect(embeds).toHaveLength(1);
    expect(components).toHaveLength(0);
  });

  it('should cap unlocked and locked achievement displays at 5 entries each', () => {
    const result = makeAchievementResult(50, 10, 20);
    const { embed } = buildAchievementsEmbedPayload(result, mockSummary, 'Half-Life 2');
    const unlockedField = embed.fields?.find((f) => f.name.includes('Recently Unlocked'));
    const lockedField = embed.fields?.find((f) => f.name.includes('Next Targets'));
    // 5 entries max displayed (each entry has a display name)
    const unlockedCount = (unlockedField?.value?.match(/Unlocked Achievement/g) || []).length;
    const lockedCount = (lockedField?.value?.match(/Locked Achievement/g) || []).length;
    expect(unlockedCount).toBe(5);
    expect(lockedCount).toBe(5);
  });
});
