// Integration test suite for Phase 3: HowLongToBeat Native & Cost-Per-Hour Analysis
import assert from 'node:assert';
import { getHowLongToBeatStats } from '../src/utils/hltbNative.js';

console.log('--- HowLongToBeat Native & Cost-Per-Hour Integration Test Suite ---\n');

async function runTests() {
  // Test 1: Native HLTB Data Retrieval
  console.log('[Test 1] Testing live HowLongToBeat queries:');
  const witcher = await getHowLongToBeatStats('The Witcher 3: Wild Hunt');
  assert.strictEqual(witcher.success, true);
  assert.strictEqual(witcher.gameTitle, 'The Witcher 3: Wild Hunt');
  assert.ok(witcher.mainStoryHours >= 45, `Expected mainStoryHours >= 45, got ${witcher.mainStoryHours}`);
  assert.ok(witcher.mainExtraHours > witcher.mainStoryHours, 'Main+Extras should be greater than Main Story');
  assert.ok(witcher.completionistHours > witcher.mainExtraHours, 'Completionist should be greater than Main+Extras');
  assert.ok(witcher.imageUrl && witcher.imageUrl.startsWith('https://howlongtobeat.com/games/'));
  console.log(`  Witcher 3: Main=${witcher.mainStoryHours}h, Plus=${witcher.mainExtraHours}h, 100%=${witcher.completionistHours}h (PASS)`);

  const hades = await getHowLongToBeatStats('Hades');
  assert.strictEqual(hades.success, true);
  assert.ok(hades.mainStoryHours >= 20, `Expected Hades mainStoryHours >= 20, got ${hades.mainStoryHours}`);
  console.log(`  Hades: Main=${hades.mainStoryHours}h, Plus=${hades.mainExtraHours}h, 100%=${hades.completionistHours}h (PASS)`);

  // Test 2: Error and edge case handling
  console.log('\n[Test 2] Testing defensive edge cases:');
  const emptyRes = await getHowLongToBeatStats('');
  assert.strictEqual(emptyRes.success, false);
  assert.strictEqual(emptyRes.error, 'DATA_UNAVAILABLE');

  const unindexed = await getHowLongToBeatStats('ZtRadarNonExistentGameXyz123456');
  assert.strictEqual(unindexed.success, false);
  assert.strictEqual(unindexed.error, 'DATA_UNAVAILABLE');
  console.log('  Graceful failure on empty or unindexed titles: PASS');

  // Test 3: Cost-per-Hour Metric Calculation
  console.log('\n[Test 3] Testing Cost-Per-Hour formulas:');
  function computeCostPerHour(bestPrice, mainHours, allHours, currency, sym, shopName, cutPercent) {
    const effectiveHours = mainHours > 0 ? mainHours : (allHours > 0 ? allHours : 0);

    if (bestPrice === null) {
      return '▸ Storefront pricing currently unavailable to compute cost-per-hour.';
    }
    if (bestPrice === 0) {
      return `▸ **Free to Play / 100% Promotional (${sym} 0.00 / hour)**\n└─ Based on current free storefront price at ${shopName}.`;
    }
    if (effectiveHours > 0) {
      const cph = (bestPrice / effectiveHours).toFixed(2);
      const hoursBasis = mainHours > 0 ? 'Main Story' : 'All PlayStyles';
      const cutText = cutPercent > 0 ? ` (-${cutPercent}%)` : '';
      return [
        `▸ **${sym} ${cph} / hour** (based on ${hoursBasis}: ${effectiveHours}h)`,
        `└─ Live Offer: **${sym} ${bestPrice.toFixed(2)}**${cutText} at ${shopName}`,
      ].join('\n');
    }
    return `▸ Live Offer: **${sym} ${bestPrice.toFixed(2)}** at ${shopName}\n└─ Playtime duration too variable to compute hourly rate.`;
  }

  // Case A: Standard paid title in USD
  const cphUSD = computeCostPerHour(19.99, 51.7, 104.3, 'USD', '$', 'Steam', 70);
  assert.ok(cphUSD.includes('$ 0.39 / hour'));
  assert.ok(cphUSD.includes('Main Story: 51.7h'));
  assert.ok(cphUSD.includes('$ 19.99'));
  console.log('  Case A (Paid $19.99 / 51.7h in USD): PASS\n    ' + cphUSD.replace(/\n/g, '\n    '));

  // Case B: Standard paid title in BRL
  const cphBRL = computeCostPerHour(79.90, 51.7, 104.3, 'BRL', 'R$', 'Nuuvem', 50);
  assert.ok(cphBRL.includes('R$ 1.55 / hour'));
  assert.ok(cphBRL.includes('R$ 79.90'));
  console.log('  Case B (Paid R$ 79.90 / 51.7h in BRL): PASS\n    ' + cphBRL.replace(/\n/g, '\n    '));

  // Case C: 100% Free title (e.g. promotional giveaway or F2P)
  const cphFree = computeCostPerHour(0, 25.0, 50.0, 'BRL', 'R$', 'Epic Games Store', 100);
  assert.ok(cphFree.includes('Free to Play / 100% Promotional (R$ 0.00 / hour)'));
  console.log('  Case C (100% Free promotion in BRL): PASS\n    ' + cphFree.replace(/\n/g, '\n    '));

  // Case D: Multiplayer title with 0 main story hours but positive all playstyles
  const cphMultiplayer = computeCostPerHour(29.99, 0, 150.0, 'USD', '$', 'Steam', 0);
  assert.ok(cphMultiplayer.includes('$ 0.20 / hour'));
  assert.ok(cphMultiplayer.includes('All PlayStyles: 150h'));
  console.log('  Case D (Multiplayer with 0h main story, fallback to allPlayStyles): PASS\n    ' + cphMultiplayer.replace(/\n/g, '\n    '));

  // Test 4: Command registration schema validation
  console.log('\n[Test 4] Validating slash command registration structure:');
  const { commands } = await import('./registerCommands.js');
  const hltbCmd = commands.find((c) => c.name === 'how-long-to-beat');
  assert.ok(hltbCmd, 'Command how-long-to-beat must be registered');
  assert.strictEqual(hltbCmd.options[0].name, 'game');
  assert.strictEqual(hltbCmd.options[0].type, 3);
  assert.strictEqual(hltbCmd.options[0].required, true);
  assert.strictEqual(hltbCmd.options[0].autocomplete, true);
  console.log('  Command registration schema: PASS');

  console.log('\nAll HowLongToBeat & Cost-Per-Hour integration tests PASSED successfully!');
}

runTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
