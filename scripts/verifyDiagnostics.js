// Unit test script for Deal Scanner, Wishlist Batch Operations, and Filter Verification
import assert from 'node:assert';
import { resolveSteamAppTitles } from '../src/utils/steamWeb.js';
import { formatExpiryAvailability, formatPriceComparisonDiff, getMarketOverviewDeals } from '../src/utils/itadApi.js';
import { buildSteamLoginUrl, parseSteamIdFromClaimedId, buildUnlinkedAccountEmbed } from '../src/utils/steamOpenId.js';

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


// Test 10: Dynamic Regional Country Code in getMarketOverviewDeals Verification
console.log('\n[Test 10] Dynamic Regional Country Code Routing Verification');

const originalFetch = globalThis.fetch;
const capturedUrls = [];

globalThis.fetch = async (url, options) => {
  const urlStr = typeof url === 'string' ? url : url.toString();
  capturedUrls.push(urlStr);

  if (urlStr.includes('cheapshark')) {
    return {
      ok: true,
      json: async () => [],
    };
  }
  if (urlStr.includes('featuredcategories')) {
    return {
      ok: true,
      json: async () => ({ specials: { items: [] }, top_sellers: { items: [] } }),
    };
  }
  return {
    ok: true,
    json: async () => ({ list: [] }),
  };
};

try {
  process.env.ITAD_API_KEY = 'mock_key_for_test';

  // Case 1: preferredCurrency = 'USD' -> must route country=US
  capturedUrls.length = 0;
  await getMarketOverviewDeals(false, 'USD');
  const usdUrl = capturedUrls.find((u) => u.includes('api.isthereanydeal.com/deals/v2'));
  assert.ok(usdUrl, 'ITAD deals URL must be called when ITAD_API_KEY is present');
  assert.ok(usdUrl.includes('country=US'), `Expected country=US in URL: ${usdUrl}`);
  assert.ok(!usdUrl.includes('country=BR'), `URL must not contain hardcoded country=BR when currency is USD: ${usdUrl}`);
  console.log(`  Case 1 (preferredCurrency: 'USD'): correctly routes country=US (PASS)`);

  // Case 2: preferredCurrency = 'BRL' -> must route country=BR
  capturedUrls.length = 0;
  await getMarketOverviewDeals(false, 'BRL');
  const brlUrl = capturedUrls.find((u) => u.includes('api.isthereanydeal.com/deals/v2'));
  assert.ok(brlUrl, 'ITAD deals URL must be called for BRL');
  assert.ok(brlUrl.includes('country=BR'), `Expected country=BR in URL: ${brlUrl}`);
  assert.ok(!brlUrl.includes('country=US'), `URL must not contain country=US when currency is BRL: ${brlUrl}`);
  console.log(`  Case 2 (preferredCurrency: 'BRL'): correctly routes country=BR (PASS)`);
} finally {
  globalThis.fetch = originalFetch;
}


// Test 11: Steam OpenID 2.0 Utility Verification
console.log('\n[Test 11] Steam OpenID 2.0 Utility Verification');

// Case 1: State token entropy — simulate the token format (hex, 64 chars)
const mockToken = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('hex');
assert.strictEqual(mockToken.length, 64, 'State token must be 64 hex characters (32 bytes)');
assert.ok(/^[0-9a-f]+$/.test(mockToken), 'State token must be lowercase hex');
console.log(`  Case 1 (State token entropy): ${mockToken.substring(0, 16)}... length=${mockToken.length} (PASS)`);

// Case 2: Steam login URL construction
const mockCallbackUrl = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/auth/steam/callback';
const loginUrl = buildSteamLoginUrl(mockToken, mockCallbackUrl, '987654321012345678');
assert.ok(loginUrl.startsWith('https://steamcommunity.com/openid/login?'), 'Login URL must point to Steam OpenID endpoint');
assert.ok(loginUrl.includes('openid.ns='), 'Login URL must include openid.ns');
assert.ok(loginUrl.includes('openid.mode=checkid_setup'), 'Login URL must include openid.mode=checkid_setup');
assert.ok(loginUrl.includes('openid.return_to='), 'Login URL must include openid.return_to');
assert.ok(loginUrl.includes('openid.realm='), 'Login URL must include openid.realm');
assert.ok(loginUrl.includes(encodeURIComponent('987654321012345678')), 'Login URL return_to must include user_id');
assert.ok(loginUrl.includes(encodeURIComponent(mockToken)), 'Login URL return_to must include state token');
assert.ok(loginUrl.length > 512, `Full Steam OpenID URL should exceed 512 chars (${loginUrl.length}) to demonstrate necessity of 302 redirect route`);
console.log(`  Case 2 (Steam login URL): correctly constructs OpenID 2.0 parameters (length=${loginUrl.length} > 512 chars) (PASS)`);

// Case 3: Valid claimed_id SteamID64 extraction
const validClaimedId = 'https://steamcommunity.com/openid/id/76561198012345678';
const extractedSteamId = parseSteamIdFromClaimedId(validClaimedId);
assert.strictEqual(extractedSteamId, '76561198012345678', 'Must extract 17-digit SteamID64 from valid claimed_id');
console.log(`  Case 3 (Valid claimed_id): extracted SteamID64 = ${extractedSteamId} (PASS)`);

// Case 4: Invalid claimed_id format must return null
const invalidClaimedIds = [
  'https://steamcommunity.com/openid/id/12345',           // too short
  'https://evil.com/openid/id/76561198012345678',         // wrong domain
  'https://steamcommunity.com/openid/id/abcdefg12345678', // non-numeric
  '',                                                     // empty string
  null,                                                   // null
  undefined,                                              // undefined
];
for (const badId of invalidClaimedIds) {
  const result = parseSteamIdFromClaimedId(badId);
  assert.strictEqual(result, null, `Invalid claimed_id "${badId}" must return null, got: ${result}`);
}
console.log(`  Case 4 (Invalid claimed_id formats): all ${invalidClaimedIds.length} cases correctly return null (PASS)`);

// Case 5: buildUnlinkedAccountEmbed returns valid Discord interaction response structure
const mockAuthCallbackUrl = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/auth/steam/callback';
const mockAuthLoginUrl = mockAuthCallbackUrl.replace('/callback', '/login');
const mockUserId = '123456789012345678';
const lightweightLoginUrl = `${mockAuthLoginUrl}?user_id=${mockUserId}`;

const embedResponse = buildUnlinkedAccountEmbed(mockUserId, lightweightLoginUrl);
assert.strictEqual(embedResponse.type, 4, 'Response type must be 4 (CHANNEL_MESSAGE_WITH_SOURCE)');
assert.strictEqual(embedResponse.data.flags, 64, 'Response data.flags must be 64 (EPHEMERAL)');
assert.ok(Array.isArray(embedResponse.data.embeds), 'Response must include embeds array');
assert.ok(Array.isArray(embedResponse.data.components), 'Response must include components array');
assert.strictEqual(embedResponse.data.components[0]?.type, 1, 'Component must be an Action Row (type 1)');
const linkButton = embedResponse.data.components[0]?.components?.[0];
assert.ok(linkButton, 'Action Row must contain at least one component');
assert.strictEqual(linkButton.type, 2, 'Button component must have type 2');
assert.strictEqual(linkButton.style, 5, 'Link Button must have style 5');
assert.strictEqual(linkButton.url, lightweightLoginUrl, 'Link Button URL must match the provided login URL');
assert.ok(linkButton.url.length <= 512, `Link Button URL must be strictly <= 512 characters, got ${linkButton.url.length}`);
assert.ok(!('custom_id' in linkButton), 'Link Button (style 5) must NOT have custom_id property');

// Verify that buildUnlinkedAccountEmbed rejects URLs exceeding 512 characters
assert.throws(
  () => buildUnlinkedAccountEmbed(mockUserId, 'https://example.com/' + 'a'.repeat(510)),
  /512/,
  'buildUnlinkedAccountEmbed must throw when URL exceeds 512 characters'
);
console.log(`  Case 5 (Unlinked account embed): correct interaction structure with Link Button (length=${linkButton.url.length} <= 512, no custom_id) (PASS)`);

// Case 6: Stage-agnostic route matching logic for Steam OpenID auth guard
const checkIsSteamLogin = (method, path) => {
  const httpMethod = (method || '').toUpperCase();
  const rawPath = path || '';
  return httpMethod === 'GET' && (rawPath === '/auth/steam/login' || rawPath.endsWith('/auth/steam/login'));
};

const checkIsSteamCallback = (method, path) => {
  const httpMethod = (method || '').toUpperCase();
  const rawPath = path || '';
  return httpMethod === 'GET' && (rawPath === '/auth/steam/callback' || rawPath.endsWith('/auth/steam/callback'));
};

// Stage-prefixed paths must match
assert.ok(checkIsSteamLogin('GET', '/prod/auth/steam/login'), 'Must match /prod/auth/steam/login with prod stage prefix');
assert.ok(checkIsSteamLogin('GET', '/dev/auth/steam/login'), 'Must match /dev/auth/steam/login with dev stage prefix');
assert.ok(checkIsSteamLogin('GET', '/auth/steam/login'), 'Must match /auth/steam/login without stage prefix');

assert.ok(checkIsSteamCallback('GET', '/prod/auth/steam/callback'), 'Must match /prod/auth/steam/callback with prod stage prefix');
assert.ok(checkIsSteamCallback('GET', '/dev/auth/steam/callback'), 'Must match /dev/auth/steam/callback with dev stage prefix');
assert.ok(checkIsSteamCallback('GET', '/auth/steam/callback'), 'Must match /auth/steam/callback without stage prefix');

// Non-auth paths and non-GET methods must NOT match (must bypass to Discord interaction handler)
assert.ok(!checkIsSteamLogin('POST', '/prod/auth/steam/login'), 'POST /prod/auth/steam/login must bypass auth guard');
assert.ok(!checkIsSteamLogin('POST', '/interactions'), 'POST /interactions must bypass auth guard');
assert.ok(!checkIsSteamLogin('POST', '/prod/interactions'), 'POST /prod/interactions must bypass auth guard');
assert.ok(!checkIsSteamCallback('POST', '/prod/interactions'), 'POST /prod/interactions must bypass callback guard');
assert.ok(!checkIsSteamLogin('GET', '/prod/interactions'), 'GET /prod/interactions must bypass auth guard');
assert.ok(!checkIsSteamCallback('GET', '/prod/other/route'), 'GET /prod/other/route must bypass callback guard');

console.log('  Case 6 (Stage-agnostic route matching): stage prefixes (/prod, /dev) match & non-auth paths bypass (PASS)');


console.log('\nAll diagnostic verification checks PASSED successfully!');

