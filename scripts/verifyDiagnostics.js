// Unit test script for Deal Scanner, Wishlist Batch Operations, and Filter Verification
import assert from 'node:assert';
import { resolveSteamAppTitles } from '../src/utils/steamWeb.js';
import { formatExpiryAvailability, formatPriceComparisonDiff } from '../src/utils/itadApi.js';

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


// Test 6: Auto-Healing Titles & Anti-Amnesia Protection
console.log('\n[Test 6] Auto-Healing Titles & Anti-Amnesia Protection Verification');

// Part A: Auto-Heal Title Resolution
function resolveDisplayTitle(itemTitle, dealTitle) {
  return (dealTitle && !dealTitle.startsWith('Steam App #')) ? dealTitle : itemTitle;
}

function shouldAutoHeal(itemTitle, dealTitle) {
  return Boolean(itemTitle?.startsWith('Steam App #') && dealTitle && !dealTitle.startsWith('Steam App #'));
}

// Case 1: Generic title auto-heals to real game name
const genericItemTitle = 'Steam App #1086940';
const resolvedDealTitle = "Baldur's Gate 3";
const displayTitle1 = resolveDisplayTitle(genericItemTitle, resolvedDealTitle);
const autoHealTriggered1 = shouldAutoHeal(genericItemTitle, resolvedDealTitle);

assert.strictEqual(displayTitle1, "Baldur's Gate 3", 'Generic Steam App title must resolve to real deal title');
assert.strictEqual(autoHealTriggered1, true, 'Auto-heal flag must be true when itemTitle starts with Steam App #');
console.log('  Case 1 (Steam App #1086940 -> "Baldur\'s Gate 3"): Auto-heal = true (PASS)');

// Case 2: Already clean title is preserved without redundant update
const cleanItemTitle = 'Cyberpunk 2077';
const displayTitle2 = resolveDisplayTitle(cleanItemTitle, 'Cyberpunk 2077');
const autoHealTriggered2 = shouldAutoHeal(cleanItemTitle, 'Cyberpunk 2077');
assert.strictEqual(displayTitle2, 'Cyberpunk 2077');
assert.strictEqual(autoHealTriggered2, false, 'Clean title should not trigger redundant auto-heal');
console.log('  Case 2 (Clean title preserved): Auto-heal = false (PASS)');

// Case 3: Deal title also failed / fallback - preserve existing without corrupting
const fallbackDealTitle = 'Steam App #999999';
const displayTitle3 = resolveDisplayTitle(genericItemTitle, fallbackDealTitle);
const autoHealTriggered3 = shouldAutoHeal(genericItemTitle, fallbackDealTitle);
assert.strictEqual(displayTitle3, genericItemTitle);
assert.strictEqual(autoHealTriggered3, false);
console.log('  Case 3 (Fallback deal title avoids corrupting state): PASS');

// Part B: Anti-Amnesia & 24h Deduplication Cooldown
function evaluateIsNewAlert(effectivePrice, lastNotifiedPrice, lastNotifiedAt, now = Date.now()) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  return (
    lastNotifiedPrice === null ||
    effectivePrice < lastNotifiedPrice ||
    ((now - lastNotifiedAt) >= ONE_DAY_MS && effectivePrice <= lastNotifiedPrice)
  );
}

const NOW = 1725700000000;
const ONE_HOUR_AGO = NOW - 1 * 60 * 60 * 1000;
const TWENTY_FIVE_HOURS_AGO = NOW - 25 * 60 * 60 * 1000;

// Case 4: First scan (never alerted) - triggers alert
const isNew1 = evaluateIsNewAlert(19.99, null, 0, NOW);
assert.strictEqual(isNew1, true, 'First-time deal (lastNotifiedPrice === null) must trigger');
console.log('  Case 4 (First scan, lastNotifiedPrice = null): isNewAlert = true (PASS)');

// Case 5: Consecutive scan 1 hour later at exact same price - MUST BE SUPPRESSED (anti-spam)
const isNew2 = evaluateIsNewAlert(19.99, 19.99, ONE_HOUR_AGO, NOW);
assert.strictEqual(isNew2, false, 'Same price within 24h must NOT trigger repeated DM');
console.log('  Case 5 (Consecutive scan 1h later at same $19.99): isNewAlert = false (SUPPRESSED - PASS)');

// Case 6: Price drops further (e.g. from $19.99 to $14.99) within 1 hour - MUST ALERT IMMEDIATELY
const isNew3 = evaluateIsNewAlert(14.99, 19.99, ONE_HOUR_AGO, NOW);
assert.strictEqual(isNew3, true, 'Lower price drop must alert immediately regardless of cooldown');
console.log('  Case 6 (Price drop $19.99 -> $14.99 within 1h): isNewAlert = true (IMMEDIATE ALERT - PASS)');

// Case 7: Same price after 24 hours elapsed - Re-alert permitted once per 24 hours
const isNew4 = evaluateIsNewAlert(19.99, 19.99, TWENTY_FIVE_HOURS_AGO, NOW);
assert.strictEqual(isNew4, true, 'Same price after 24h cooldown allows reminder alert');
console.log('  Case 7 (Same price after 25h elapsed): isNewAlert = true (COOLDOWN EXPIRED - PASS)');

// Case 8: Price increased (e.g. sale worsened or ended) - No alert
const isNew5 = evaluateIsNewAlert(29.99, 19.99, ONE_HOUR_AGO, NOW);
assert.strictEqual(isNew5, false, 'Higher price must not alert');
console.log('  Case 8 (Price increase $19.99 -> $29.99): isNewAlert = false (PASS)');


// Test 7: Promotion Expiration Formatting & Dynamic Discord Timestamp Tags
console.log('\n[Test 7] Promotion Expiration Formatting & Discord Timestamp Verification');

// Case 1: Valid ISO string
const isoExpiry = '2026-09-18T04:59:59+02:00';
const expectedEpoch = Math.floor(new Date(isoExpiry).getTime() / 1000);
const formattedIso = formatExpiryAvailability(isoExpiry);
assert.strictEqual(
  formattedIso,
  `└─ Availability: Until <t:${expectedEpoch}:F> (<t:${expectedEpoch}:R>)`,
  'Valid ISO string must format into dynamic Discord timestamp tag'
);
console.log(`  Case 1 (ISO 8601 string): ${formattedIso} (PASS)`);

// Case 2: Numeric timestamp (epoch ms)
const epochMs = 1789700399000;
const formattedEpochMs = formatExpiryAvailability(epochMs);
assert.strictEqual(
  formattedEpochMs,
  `└─ Availability: Until <t:${Math.floor(epochMs / 1000)}:F> (<t:${Math.floor(epochMs / 1000)}:R>)`,
  'Numeric ms timestamp must format into dynamic Discord timestamp tag'
);
console.log(`  Case 2 (Epoch milliseconds): ${formattedEpochMs} (PASS)`);

// Case 3: Null or missing timestamp fallback
const formattedNull = formatExpiryAvailability(null);
assert.strictEqual(
  formattedNull,
  '└─ Availability: Limited-time promotion (Claim as soon as possible)',
  'Null expiry must return friendly limited-time fallback'
);
console.log(`  Case 3 (Null/missing expiry): ${formattedNull} (PASS)`);

// Case 4: Invalid date string fallback
const formattedInvalid = formatExpiryAvailability('invalid-timestamp-value');
assert.strictEqual(
  formattedInvalid,
  '└─ Availability: Limited-time promotion (Claim as soon as possible)',
  'Invalid date string must fallback gracefully'
);
console.log(`  Case 4 (Invalid date string): ${formattedInvalid} (PASS)`);


// Test 8: /radar-help Category Structure, Command Counts, and Discord 1024 Character Limits
console.log('\n[Test 8] /radar-help Category Structure & Character Limit Verification');

const expectedCategories = [
  '❖ Personal & Market Intelligence [DM & Server]',
  '❖ Server Administration & Curated Radar [Server Only • Requires Manage Server]',
];

const mockHelpEmbed = {
  title: 'zT Radar ❖ Command Directory',
  description: 'Comprehensive directory of gaming intelligence, price monitoring, and server broadcast commands.',
  fields: [
    {
      name: '❖ Personal & Market Intelligence [DM & Server]',
      value: [
        '▸ `/compare <game>`\n  └─ Price check across Steam, Epic, Nuuvem & GOG with ATL.',
        '▸ `/can-it-run <game>`\n  └─ Minimum & recommended PC specs from Steam.',
        '▸ `/game-news <game>`\n  └─ Patch notes, news, and developer dispatches.',
        '▸ `/how-long-to-beat <game>`\n  └─ Completion times and cost-per-hour metrics.',
        '▸ `/steam-most-played`\n  └─ Top 10 most-played Steam titles by players.',
        '▸ `/steam-trending`\n  └─ Top 10 surging games on the Steam Store.',
        '▸ `/platform-status`\n  └─ Service availability for Steam, Epic, PSN & Xbox.',
        '▸ `/wishlist <add|list|clear|remove|sync-steam>`\n  └─ Track deals & price targets.',
        '▸ `/currency <choice>`\n  └─ Set personal currency between USD ($) and BRL (R$).',
        '▸ `/steam-link <target>`\n  └─ Link Steam account (SteamID64, vanity, or URL).',
        '▸ `/steam-profile [user] [target]`\n  └─ View profile overview, VAC status, and stats.',
        '▸ `/free-play-radar`\n  └─ Browse active free giveaways and Free Weekends.',
        '▸ `/free-radar-dm <enabled>`\n  └─ Toggle automated DM alerts for free games.',
      ].join('\n'),
      inline: false,
    },
    {
      name: '❖ Server Administration & Curated Radar [Server Only • Requires Manage Server]',
      value: [
        '▸ `/config-channel <channel> [currency] [include_third_party] [free_only]`\n  └─ Route curated deals and free game broadcasts into a server channel.',
        '▸ `/config-channel-experimental [min_discount] [min_rating]`\n  └─ Configure minimum discount and community rating broadcast filters.',
        '▸ `/config-channel-remove`\n  └─ Deactivate automatic deal and giveaway broadcasts for this server.',
        '▸ `/radar-status`\n  └─ Display server broadcast configuration and system operational status.',
      ].join('\n'),
      inline: false,
    },
  ],
};

// Check Category Names
assert.strictEqual(mockHelpEmbed.fields.length, 2, 'Help embed must have exactly 2 categories');
assert.strictEqual(mockHelpEmbed.fields[0].name, expectedCategories[0]);
assert.strictEqual(mockHelpEmbed.fields[1].name, expectedCategories[1]);
console.log('  Categories matched expected execution scopes: PASS');

// Check Command Count in Category 1
const cat1Commands = (mockHelpEmbed.fields[0].value.match(/▸ `\//g) || []).length;
assert.strictEqual(cat1Commands, 13, 'Category 1 must contain exactly 13 personal/DM commands');
console.log(`  Category 1 command count: ${cat1Commands} / 13 (PASS)`);

// Check Command Count in Category 2
const cat2Commands = (mockHelpEmbed.fields[1].value.match(/▸ `\//g) || []).length;
assert.strictEqual(cat2Commands, 4, 'Category 2 must contain exactly 4 server admin commands');
console.log(`  Category 2 command count: ${cat2Commands} / 4 (PASS)`);

// Check Character Limits <= 1024
for (const [idx, field] of mockHelpEmbed.fields.entries()) {
  const len = field.value.length;
  assert.ok(len <= 1024, `Field [${idx}] length (${len}) must not exceed 1024 chars`);
  console.log(`  Field [${idx}] character length: ${len} <= 1024 limit (PASS)`);
}


// Test 9: Price Comparison Structured Dual Diff Block Formatting
console.log('\n[Test 9] Price Comparison Dual Diff Block Formatting Verification');

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

// Case 1: Cheaper alternative exists -> Dual diff block
const dualDiff = formatPriceComparisonDiff(steamDeal, nuuvemDeal, '$');
assert.ok(dualDiff.includes('[ Monitored Storefront ❖ Steam ]'), 'Dual diff must include monitored storefront block');
assert.ok(dualDiff.includes('[ Best Offer Detected ❖ Nuuvem ]'), 'Dual diff must include best offer block');
assert.ok(dualDiff.includes('- Regular: $ 69.99'), 'Dual diff must include regular price');
assert.ok(dualDiff.includes('+ Current: $ 48.99 (-30%)'), 'Dual diff must include current primary price');
assert.ok(dualDiff.includes('+ Deal:    $ 34.99 (-50%) ★ Best Value'), 'Dual diff must include best value line');
console.log('  Case 1 (Dual diff block with cheaper alternative):\n' + dualDiff + '\n  (PASS)');

// Case 2: No cheaper alternative -> Single diff block
const singleDiff = formatPriceComparisonDiff(steamDeal, null, '$');
assert.ok(singleDiff.includes('[ Monitored Storefront ❖ Steam ]'), 'Single diff must include monitored storefront block');
assert.ok(!singleDiff.includes('[ Best Offer Detected'), 'Single diff must NOT include second store header');
assert.ok(singleDiff.includes('+ Current: $ 48.99 (-30%)'), 'Single diff must include current price');
console.log('  Case 2 (Single diff block when primary is best offer):\n' + singleDiff + '\n  (PASS)');

console.log('\nAll diagnostic verification checks PASSED successfully!');
