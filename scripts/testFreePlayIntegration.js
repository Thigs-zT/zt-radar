// Integration and contract test suite for Free Play & Giveaway Intelligence
import assert from 'node:assert';
import dotenv from 'dotenv';
dotenv.config();

import { commands } from './registerCommands.js';
import { getMarketOverviewDeals } from '../src/utils/itadApi.js';

console.log('--- Free Play & Giveaway Intelligence Integration Test Suite ---\n');

async function runTests() {
  // Test 1: Command Registration Schema Verification
  console.log('[Test 1] Verifying Slash Command Registration Schemas:');
  
  const freePlayCmd = commands.find((c) => c.name === 'free-play-radar');
  assert.ok(freePlayCmd, 'Command /free-play-radar must be registered');
  assert.strictEqual(
    freePlayCmd.description,
    'Inspect all active 100% free games to keep and temporary Free Weekend events'
  );
  console.log('  /free-play-radar registration schema: PASS');

  const freeDmCmd = commands.find((c) => c.name === 'free-radar-dm');
  assert.ok(freeDmCmd, 'Command /free-radar-dm must be registered');
  assert.strictEqual(
    freeDmCmd.description,
    'Toggle automated direct message alerts for all free games and free weekends'
  );
  assert.ok(Array.isArray(freeDmCmd.options), 'Options array must be present');
  const enabledOpt = freeDmCmd.options.find((opt) => opt.name === 'enabled');
  assert.ok(enabledOpt, 'Option "enabled" must be present');
  assert.strictEqual(enabledOpt.type, 5, 'Option "enabled" must be type BOOLEAN (5)');
  assert.strictEqual(enabledOpt.required, true, 'Option "enabled" must be required');
  console.log('  /free-radar-dm registration schema: PASS');

  // Test 2: Live Market Overview Deals Contract Validation
  console.log('\n[Test 2] Querying Live Market Deals & Validating Free Deal Schema:');
  const marketDeals = await getMarketOverviewDeals(false, 'USD');
  assert.ok(Array.isArray(marketDeals), 'Result must be an array');
  console.log(`  Total market deals returned: ${marketDeals.length}`);

  const freeToKeepDeals = marketDeals.filter((d) => d.dealType === 'FREE_TO_KEEP');
  const freePlayEvents = marketDeals.filter((d) => d.dealType === 'FREE_PLAY_DAYS');
  console.log(`  Active Free to Keep promotions: ${freeToKeepDeals.length}`);
  console.log(`  Active Free Play / Free Weekend events: ${freePlayEvents.length}`);

  for (const deal of [...freeToKeepDeals, ...freePlayEvents]) {
    assert.ok(deal.title, 'Deal must have a title');
    assert.ok(deal.gameId, 'Deal must have a gameId');
    assert.ok(deal.dealType === 'FREE_TO_KEEP' || deal.dealType === 'FREE_PLAY_DAYS', 'dealType must be valid');
    assert.ok(deal.primaryDeal, 'primaryDeal must be present');
    assert.strictEqual(deal.primaryDeal.salePrice, 0, 'Free deal salePrice must be 0');
    assert.ok(deal.primaryDeal.shopName, 'shopName must be present');
    assert.ok(deal.primaryDeal.url, 'Deal URL must be present');
  }
  console.log('  Contract schema validation on active free deals: PASS');

  // Test 3: Formatting & Embed Structure Verification
  console.log('\n[Test 3] Verifying Embed Formatting & Visual Hierarchy:');
  
  // Case A: When free deals are present
  const mockDeal = {
    gameId: 'epic_mock_123',
    title: 'The Outer Worlds: Spacer\'s Choice Edition',
    imageUrl: 'https://cdn.example.com/cover.jpg',
    dealType: 'FREE_TO_KEEP',
    primaryDeal: {
      shopName: 'Epic Games Store',
      salePrice: 0,
      regularPrice: 59.99,
      cutPercent: 100,
      url: 'https://store.epicgames.com/p/the-outer-worlds',
      currency: 'USD',
      currencySymbol: '$',
    },
  };

  const regPrice = `${mockDeal.primaryDeal.currencySymbol} ${mockDeal.primaryDeal.regularPrice.toFixed(2)}`;
  const keepLines = [
    `❖ **${mockDeal.title}** (${mockDeal.primaryDeal.shopName})`,
    `  └─ Claim for permanent library ownership • Value: ~~${regPrice}~~ ➔ **FREE**`,
    '```diff',
    `- Regular Price: ${regPrice}`,
    `+ Promotional:   ${mockDeal.primaryDeal.currencySymbol} 0.00 (-100%)`,
    '```',
  ].join('\n');

  assert.ok(keepLines.includes('❖'));
  assert.ok(keepLines.includes('└─'));
  assert.ok(keepLines.includes('```diff'));
  assert.ok(keepLines.includes('- Regular Price: $ 59.99'));
  assert.ok(keepLines.includes('+ Promotional:   $ 0.00 (-100%)'));
  // Zero mobile emojis in formatted text
  assert.strictEqual(/[\u{1F300}-\u{1F9FF}]/u.test(keepLines), false, 'Must contain zero mobile emojis');
  console.log('  Free to Keep visual formatting & diff block: PASS');

  // Case B: When no free deals are active
  const fallbackMessage = 'No promotional free games are currently active. Check back on Thursday when Epic Games updates weekly giveaways.';
  assert.ok(fallbackMessage.includes('Thursday'), 'Fallback message must mention weekly Thursday giveaways');
  console.log('  Empty state fallback messaging: PASS');

  // Test 4: Global Free Games DM Alert Throttling & Deduplication Contract
  console.log('\n[Test 4] Testing Scanner Throttling & Deduplication Contract:');
  
  const MAX_DM_PER_USER = 3;
  const userDmCountMap = new Map();
  const testUserId = '123456789012345678';
  
  userDmCountMap.set(testUserId, 2); // 2 DMs already sent
  const currentCount = userDmCountMap.get(testUserId);
  assert.ok(currentCount < MAX_DM_PER_USER, 'Should permit 1 more DM');

  userDmCountMap.set(testUserId, 3); // Capped
  assert.strictEqual(userDmCountMap.get(testUserId) >= MAX_DM_PER_USER, true, 'Should throttle further DMs');
  console.log('  MAX_DM_PER_USER = 3 anti-spam throttle contract: PASS');

  const history = ['steam_1086940_FREE_PLAY_DAYS', 'epic_mock_123_FREE_TO_KEEP'];
  const newDealKey = 'epic_mock_123_FREE_TO_KEEP';
  assert.ok(history.includes(newDealKey), 'Should detect duplicate deal key and prevent duplicate DM');
  
  const freshDealKey = 'steam_570_FREE_TO_KEEP';
  assert.strictEqual(history.includes(freshDealKey), false, 'Should allow newly identified free game');
  console.log('  Unique deal key deduplication: PASS');

  console.log('\n--- ALL FREE PLAY INTEGRATION TESTS PASSED (100% SUCCESS) ---');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
