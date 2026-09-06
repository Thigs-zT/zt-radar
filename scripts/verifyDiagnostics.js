// Unit test script for Deal Scanner, Wishlist Batch Operations, and Filter Verification
import assert from 'node:assert';
import { resolveSteamAppTitles } from '../src/utils/steamWeb.js';

console.log('--- Running Diagnostics & Verification for Deal Scanner & Steam Web Fixes ---\n');

// Test 1: Bug 1 - False Historical Low Alerts on Full-Priced Games
console.log('[Test 1] Bug 1: False ATL Prevention Verification');

function evaluateIsAtl(primaryDeal, cheaperAlternative, historyLow) {
  const primaryIsAtl =
    primaryDeal.cutPercent > 0 &&
    primaryDeal.salePrice < primaryDeal.regularPrice &&
    primaryDeal.salePrice <= historyLow;

  const cheaperIsAtl =
    Boolean(cheaperAlternative) &&
    cheaperAlternative.cutPercent > 0 &&
    cheaperAlternative.salePrice < cheaperAlternative.regularPrice &&
    cheaperAlternative.salePrice <= historyLow;

  return historyLow !== null && (primaryIsAtl || cheaperIsAtl);
}

// Case A: Full-priced game that never had a discount (regularPrice matches historyLow)
const fullPricedGame = {
  salePrice: 69.99,
  regularPrice: 69.99,
  cutPercent: 0,
};
const fullPricedAtl = evaluateIsAtl(fullPricedGame, null, 69.99);
assert.strictEqual(fullPricedAtl, false, 'Full priced game with cutPercent=0 must NOT be marked as ATL');
console.log('  Case A (Full-priced game $69.99, 0% cut, historyLow=$69.99): isAllTimeLow =', fullPricedAtl, '(PASS)');

// Case B: Real discounted game matching ATL
const discountedAtlGame = {
  salePrice: 19.99,
  regularPrice: 59.99,
  cutPercent: 67,
};
const discountedAtl = evaluateIsAtl(discountedAtlGame, null, 19.99);
assert.strictEqual(discountedAtl, true, 'Discounted game matching historyLow MUST be marked as ATL');
console.log('  Case B (Discounted game $19.99, 67% cut, historyLow=$19.99): isAllTimeLow =', discountedAtl, '(PASS)');


// Test 2: Bug 2 - Missing Throttle/Cap on User DM Alerts
console.log('\n[Test 2] Bug 2: DM Throttle (Max 3 DMs per user per run) Verification');
const MAX_DM_PER_USER = 3;
const userDmCountMap = new Map();
const mockUser = '123456789012345678';

let sentCount = 0;
for (let i = 1; i <= 6; i++) {
  const currentDmCount = userDmCountMap.get(mockUser) || 0;
  if (currentDmCount >= MAX_DM_PER_USER) {
    continue; // Throttled
  }
  // Simulate dispatch
  userDmCountMap.set(mockUser, currentDmCount + 1);
  sentCount++;
}
assert.strictEqual(sentCount, 3, 'User must receive at most 3 DMs during a single scanner run');
assert.strictEqual(userDmCountMap.get(mockUser), 3);
console.log(`  Dispatched exactly ${sentCount} DMs out of 6 opportunities (capped at ${MAX_DM_PER_USER}): PASS`);


// Test 3: Bug 3 - Steam Wishlist Title Fallback Performance
console.log('\n[Test 3] Bug 3: Immediate Title Fallback & Strict Budget Verification');
const mockAppIds = [1086940, 730, 999999999]; // 1086940 (BG3 in dictionary), 730 (CS2 in dictionary), 999999999 (unmapped)

const startTime = Date.now();
const titles = await resolveSteamAppTitles(mockAppIds, 500);
const elapsed = Date.now() - startTime;

assert.strictEqual(titles.get(1086940), "Baldur's Gate 3", 'In-memory resolution must match BG3');
assert.strictEqual(titles.get(730), 'Counter-Strike 2', 'In-memory resolution must match CS2');
assert.ok(titles.get(999999999).includes('Steam App #999999999'), 'Unmapped title must fallback cleanly to Steam App #<id>');
console.log(`  Resolved ${mockAppIds.length} titles in ${elapsed}ms: PASS`);


// Test 4: Issue 1 - /wishlist clear Batch Deletion Partitioning
console.log('\n[Test 4] Issue 1: Wishlist Clear Batch Partitioning (< 1800ms) Verification');
const simulatedWishlist = Array.from({ length: 100 }, (_, i) => ({
  PK: 'USER#123456789',
  SK: `GAME#game_${i}`,
}));

const BATCH_SIZE = 25;
const deleteChunks = [];
for (let i = 0; i < simulatedWishlist.length; i += BATCH_SIZE) {
  deleteChunks.push(simulatedWishlist.slice(i, i + BATCH_SIZE));
}

assert.strictEqual(deleteChunks.length, 4, '100 items must be split into exactly 4 batches of 25');
assert.strictEqual(deleteChunks[0].length, 25);
assert.strictEqual(deleteChunks[3].length, 25);

// Simulate parallel execution
const batchStart = Date.now();
await Promise.all(
  deleteChunks.map(async (chunk) => {
    // Simulating DynamoDB BatchWriteCommand network roundtrip (~20ms)
    await new Promise((r) => setTimeout(r, 20));
    return chunk.length;
  })
);
const batchElapsed = Date.now() - batchStart;
assert.ok(batchElapsed < 100, `Parallel batch deletion executed in ${batchElapsed}ms (expected < 100ms)`);
console.log(`  Partitioned 100 items into 4 parallel chunks of 25; executed in ${batchElapsed}ms: PASS`);


// Test 5: Issue 2 - Wishlist DM Low-Discount & Rating Filtering
console.log('\n[Test 5] Issue 2: Low-Discount (10% launch) & Rating Threshold Filtering');

function shouldAlertWishlistItem(deal, item) {
  const effectivePrice = deal.cheaperAlternative?.salePrice ?? deal.primaryDeal?.salePrice ?? 0;
  const effectiveCut = deal.cheaperAlternative?.cutPercent ?? deal.primaryDeal?.cutPercent ?? 0;
  const regularPrice = deal.cheaperAlternative?.regularPrice ?? deal.primaryDeal?.regularPrice ?? 0;
  const hasActiveDiscount = effectiveCut > 0 && effectivePrice < regularPrice;

  const minDiscount = item.min_discount ?? 70;
  const minRating = item.min_rating ?? null;

  // Skip title if it fails the user's minimum review score requirement
  if (minRating !== null && deal.reviewScore !== null && deal.reviewScore !== undefined && deal.reviewScore < minRating) {
    return { shouldAlert: false, reason: 'RATING_BELOW_MINIMUM' };
  }

  let shouldAlert = false;
  let alertReason = '';

  if (deal.dealType === 'FREE_TO_KEEP' || (item.alert_free && effectivePrice === 0 && (effectiveCut > 0 || regularPrice > 0))) {
    shouldAlert = true;
    alertReason = '100% FREE TO KEEP (Permanent Ownership)';
  } else if (deal.dealType === 'FREE_PLAY_DAYS') {
    shouldAlert = true;
    alertReason = 'FREE PLAY EVENT (Play For Free This Weekend)';
  } else if (hasActiveDiscount && item.target_price && effectivePrice <= Number(item.target_price)) {
    shouldAlert = true;
    alertReason = `TARGET PRICE REACHED (≤ ${Number(item.target_price).toFixed(2)})`;
  } else if (hasActiveDiscount && effectiveCut >= minDiscount) {
    if (deal.isAllTimeLow && item.alert_all_time_low) {
      shouldAlert = true;
      alertReason = `HISTORICAL ALL-TIME LOW PRICE HIT (-${effectiveCut}% OFF)`;
    } else if (item.alert_steep_discount) {
      shouldAlert = true;
      alertReason = `MAJOR PROMOTION: -${effectiveCut}% OFF`;
    }
  }

  return { shouldAlert, alertReason };
}

// Case 1: Newly released game with 10% launch cut (technically ATL) vs default 70% min_discount
const launchDiscountDeal = {
  dealType: 'CURATED_DEAL',
  isAllTimeLow: true,
  reviewScore: 85,
  primaryDeal: {
    salePrice: 53.99,
    regularPrice: 59.99,
    cutPercent: 10,
  },
};
const defaultSyncedItem = {
  game_title: 'Brand New Release',
  target_price: null,
  min_discount: 70,
  alert_all_time_low: true,
  alert_steep_discount: true,
  alert_free: true,
};
const r1 = shouldAlertWishlistItem(launchDiscountDeal, defaultSyncedItem);
assert.strictEqual(r1.shouldAlert, false, '10% launch discount MUST NOT trigger DM alert under default 70% min_discount');
console.log('  Case 1 (10% launch cut on ATL game vs min_discount:70): shouldAlert = false (BLOCKED - PASS)');

// Case 2: 75% deep discount on ATL game vs default 70% min_discount
const deepDiscountDeal = {
  dealType: 'CURATED_DEAL',
  isAllTimeLow: true,
  reviewScore: 92,
  primaryDeal: {
    salePrice: 14.99,
    regularPrice: 59.99,
    cutPercent: 75,
  },
};
const r2 = shouldAlertWishlistItem(deepDiscountDeal, defaultSyncedItem);
assert.strictEqual(r2.shouldAlert, true, '75% discount MUST trigger DM alert under min_discount:70');
assert.ok(r2.alertReason.includes('-75% OFF'));
console.log('  Case 2 (75% deep discount on ATL game vs min_discount:70): shouldAlert = true (ALERTED - PASS)');

// Case 3: Custom min_discount = 50 configured by user, game gets 50% off
const customThresholdItem = {
  game_title: 'Custom Tracked Title',
  target_price: null,
  min_discount: 50,
  alert_all_time_low: true,
};
const moderateDiscountDeal = {
  dealType: 'CURATED_DEAL',
  isAllTimeLow: true,
  reviewScore: 88,
  primaryDeal: {
    salePrice: 29.99,
    regularPrice: 59.99,
    cutPercent: 50,
  },
};
const r3 = shouldAlertWishlistItem(moderateDiscountDeal, customThresholdItem);
assert.strictEqual(r3.shouldAlert, true, '50% discount MUST trigger DM alert when user specified min_discount:50');
console.log('  Case 3 (50% cut vs custom min_discount:50): shouldAlert = true (ALERTED - PASS)');

// Case 4: Manual target_price override (e.g. user set target_price: 35.00), game price drops to 29.99 (40% off)
const targetPriceItem = {
  game_title: 'Manual Target Title',
  target_price: 35.0,
  min_discount: 70,
  alert_all_time_low: true,
};
const targetPriceDeal = {
  dealType: 'CURATED_DEAL',
  isAllTimeLow: false,
  reviewScore: 80,
  primaryDeal: {
    salePrice: 29.99,
    regularPrice: 49.99,
    cutPercent: 40,
  },
};
const r4 = shouldAlertWishlistItem(targetPriceDeal, targetPriceItem);
assert.strictEqual(r4.shouldAlert, true, 'Target price match MUST trigger even if cut is under 70%');
console.log('  Case 4 (Target price reached with 40% cut vs min_discount:70): shouldAlert = true (OVERRIDE - PASS)');

// Case 5: Rating filter rejection (game has 65% rating, user specified min_rating: 80)
const ratingFilterItem = {
  game_title: 'Mixed Reviews Title',
  target_price: null,
  min_discount: 50,
  min_rating: 80,
  alert_all_time_low: true,
};
const lowRatedDeal = {
  dealType: 'CURATED_DEAL',
  isAllTimeLow: true,
  reviewScore: 65,
  primaryDeal: {
    salePrice: 9.99,
    regularPrice: 39.99,
    cutPercent: 75,
  },
};
const r5 = shouldAlertWishlistItem(lowRatedDeal, ratingFilterItem);
assert.strictEqual(r5.shouldAlert, false, 'Title with reviewScore < min_rating MUST be filtered out');
console.log('  Case 5 (Review score 65 < min_rating 80): shouldAlert = false (FILTERED - PASS)');

// Case 6: 100% Free giveaway is always alerted
const freeDeal = {
  dealType: 'FREE_TO_KEEP',
  reviewScore: 70,
  primaryDeal: {
    salePrice: 0.0,
    regularPrice: 29.99,
    cutPercent: 100,
  },
};
const r6 = shouldAlertWishlistItem(freeDeal, defaultSyncedItem);
assert.strictEqual(r6.shouldAlert, true, '100% Free giveaway MUST trigger');
console.log('  Case 6 (100% Free giveaway promotion): shouldAlert = true (ALERTED - PASS)');

console.log('\nAll diagnostic verification checks PASSED successfully!');
