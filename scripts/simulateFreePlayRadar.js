import fs from 'node:fs';
import dotenv from 'dotenv';
import { formatExpiryAvailability } from '../src/utils/itadApi.js';

// Load environment variables (.env.dev preferred, then .env)
if (fs.existsSync('.env.dev')) {
  dotenv.config({ path: '.env.dev' });
} else if (fs.existsSync('.env')) {
  dotenv.config({ path: '.env' });
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// 1. Mock payload generator mirroring real-world free giveaways & free weekends
export function generateMockFreePlayPayload() {
  const futureExpiry48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const freeToKeep = [
    {
      gameId: 'mock_ds_dc',
      title: "Death Stranding Director's Cut",
      imageUrl: 'https://cdn1.epicgames.com/offer/6f9038ebe88e404b9015c9ff2e245a44/EGS_DEATHSTRANDINGDIRECTORSCUT_KojimaProductions_S1_2560x1440-a35ee3f4e3c383f9829f27de5a47e45e',
      reviewScore: 93,
      steamAppId: 1850570,
      dealType: 'FREE_TO_KEEP',
      expiry: futureExpiry48h,
      primaryDeal: {
        shopName: 'Epic Games Store',
        salePrice: 0,
        regularPrice: 39.99,
        cutPercent: 100,
        url: 'https://store.epicgames.com/p/death-stranding-directors-cut',
        expiry: futureExpiry48h,
        currency: 'USD',
        currencySymbol: '$',
      },
      cheaperAlternative: null,
    },
    {
      gameId: 'mock_indie_gem',
      title: 'Cave Story+',
      imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/200900/header.jpg',
      reviewScore: 89,
      steamAppId: 200900,
      dealType: 'FREE_TO_KEEP',
      expiry: null, // Fallback availability message test
      primaryDeal: {
        shopName: 'Epic Games Store',
        salePrice: 0,
        regularPrice: 14.99,
        cutPercent: 100,
        url: 'https://store.epicgames.com/p/cave-story-plus',
        expiry: null,
        currency: 'USD',
        currencySymbol: '$',
      },
      cheaperAlternative: null,
    },
  ];

  const freePlayEvents = [
    {
      gameId: 'steam_552500',
      title: 'Warhammer: Vermintide 2',
      imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/552500/header.jpg',
      reviewScore: 84,
      steamAppId: 552500,
      dealType: 'FREE_PLAY_DAYS',
      expiry: null,
      primaryDeal: {
        shopName: 'Steam',
        salePrice: 0,
        regularPrice: 29.99,
        cutPercent: 100,
        url: 'https://store.steampowered.com/app/552500/',
        currency: 'USD',
        currencySymbol: '$',
      },
      cheaperAlternative: null,
    },
  ];

  return { freeToKeep, freePlayEvents };
}

// 2. Build Discord embed and action row components matching /free-play-radar handler
export function buildFreePlayRadarEmbed(freeToKeep, freePlayEvents, userCurrency = 'USD') {
  const sym = userCurrency === 'BRL' ? 'R$' : '$';
  const fields = [];
  const buttons = [];

  if (freeToKeep.length > 0) {
    const keepDescriptions = freeToKeep.map((deal) => {
      const regPrice = deal.primaryDeal?.regularPrice
        ? `${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`
        : 'Paid';
      const expiryText = formatExpiryAvailability(deal.expiry || deal.primaryDeal?.expiry);

      return [
        `❖ **${deal.title}** (${deal.primaryDeal.shopName})`,
        `  └─ Claim for permanent library ownership • Value: ~~${regPrice}~~ ➔ **FREE**`,
        `  ${expiryText}`,
        '```diff',
        `- Regular Price: ${regPrice}`,
        `+ Promotional:   ${sym} 0.00 (-100%)`,
        '```',
      ].join('\n');
    });

    fields.push({
      name: '100% Free to Keep ❖ Permanent Giveaways',
      value: keepDescriptions.join('\n'),
      inline: false,
    });
  }

  if (freePlayEvents.length > 0) {
    const eventDescriptions = freePlayEvents.map((deal) => {
      const regPrice = deal.primaryDeal?.regularPrice
        ? `${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`
        : 'Standard';
      const expiryText = formatExpiryAvailability(deal.expiry || deal.primaryDeal?.expiry);

      return [
        `❖ **${deal.title}** (Steam)`,
        `  └─ Active Free Weekend promotion • Regular Price: ${regPrice}`,
        `  ${expiryText}`,
        '```diff',
        `- Base Price:    ${regPrice}`,
        `+ Weekend Play:  Free Access (Temporary)`,
        '```',
      ].join('\n');
    });

    fields.push({
      name: 'Free Play Events ❖ Play for Free This Weekend',
      value: eventDescriptions.join('\n'),
      inline: false,
    });
  }

  const allFreeDeals = [...freeToKeep, ...freePlayEvents];
  const seenButtonUrls = new Set();

  for (const deal of allFreeDeals) {
    if (buttons.length >= 5) break;

    if (deal.primaryDeal?.url && !seenButtonUrls.has(deal.primaryDeal.url)) {
      seenButtonUrls.add(deal.primaryDeal.url);
      buttons.push({
        type: 2, // BUTTON
        style: 5, // LINK
        label: `Claim on ${deal.primaryDeal.shopName}`,
        url: deal.primaryDeal.url,
      });
    }

    if (buttons.length < 5 && deal.steamAppId) {
      const steamDbUrl = `https://steamdb.info/app/${deal.steamAppId}/`;
      if (!seenButtonUrls.has(steamDbUrl)) {
        seenButtonUrls.add(steamDbUrl);
        buttons.push({
          type: 2,
          style: 5,
          label: `SteamDB (${deal.title.substring(0, 15)})`,
          url: steamDbUrl,
        });
      }
    }
  }

  const components = buttons.length > 0 ? [{ type: 1, components: buttons.slice(0, 5) }] : [];
  const featuredImage = allFreeDeals.find((d) => d.imageUrl)?.imageUrl || null;

  const embed = {
    title: 'zT Radar ❖ Free Play & Giveaway Intelligence',
    description: 'Currently detected 100% free promotions and active Free Weekend events.',
    color: freeToKeep.length > 0 ? 0x57F287 : 0x9B59B6,
    fields,
    footer: {
      text: `Currency: ${userCurrency} • Steam & Epic Games Store`,
    },
    timestamp: new Date().toISOString(),
  };

  if (featuredImage) {
    embed.thumbnail = { url: featuredImage };
  }

  return { embed, components };
}

// 3. Strict Discord Embed Limit Validation
export function validateDiscordLimits(embed) {
  const results = [];

  // Title limit <= 256
  const titleLen = (embed.title || '').length;
  results.push({
    check: 'Embed Title Length',
    actual: titleLen,
    limit: 256,
    pass: titleLen <= 256,
  });

  // Description limit <= 4096
  const descLen = (embed.description || '').length;
  results.push({
    check: 'Embed Description Length',
    actual: descLen,
    limit: 4096,
    pass: descLen <= 4096,
  });

  // Fields count <= 25
  const fieldCount = (embed.fields || []).length;
  results.push({
    check: 'Embed Field Count',
    actual: fieldCount,
    limit: 25,
    pass: fieldCount <= 25,
  });

  // Field limits: name <= 256, value <= 1024
  let totalChars = titleLen + descLen + (embed.footer?.text || '').length;
  (embed.fields || []).forEach((f, idx) => {
    const nameLen = (f.name || '').length;
    const valLen = (f.value || '').length;
    totalChars += nameLen + valLen;

    results.push({
      check: `Field [${idx}] Name (${f.name.substring(0, 20)}...)`,
      actual: nameLen,
      limit: 256,
      pass: nameLen <= 256,
    });

    results.push({
      check: `Field [${idx}] Value (${f.name.substring(0, 20)}...)`,
      actual: valLen,
      limit: 1024,
      pass: valLen <= 1024,
    });
  });

  // Total embed characters <= 6000
  results.push({
    check: 'Total Embed Characters',
    actual: totalChars,
    limit: 6000,
    pass: totalChars <= 6000,
  });

  return { results, allPassed: results.every((r) => r.pass) };
}

// 4. Send test DM via Discord REST API
async function dispatchTestDm(targetUserId, embed, components) {
  if (!BOT_TOKEN) {
    console.error('Error: DISCORD_BOT_TOKEN is not defined in the environment.');
    return false;
  }

  console.log(`\nDispatching simulated /free-play-radar embed to User ID: ${targetUserId}...`);

  try {
    // Step A: Create DM Channel
    const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: targetUserId }),
    });

    if (!dmChannelRes.ok) {
      const errText = await dmChannelRes.text();
      console.error(`Failed to create DM channel (${dmChannelRes.status}):`, errText);
      return false;
    }

    const dmChannel = await dmChannelRes.json();
    const channelId = dmChannel.id;

    // Step B: Send Message with Embed & Components
    const messageRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embeds: [embed],
        components,
      }),
    });

    if (!messageRes.ok) {
      const errText = await messageRes.text();
      console.error(`Failed to send DM message (${messageRes.status}):`, errText);
      return false;
    }

    const msgData = await messageRes.json();
    console.log(`Success! Dispatched test embed message (ID: ${msgData.id}) to User ${targetUserId}.`);
    return true;
  } catch (err) {
    console.error('Network or execution error while sending test DM:', err.message || err);
    return false;
  }
}

// Execution Entrypoint
async function run() {
  console.log('--- zT Radar: Free Play Radar Simulation & Embed Validator ---');

  const { freeToKeep, freePlayEvents } = generateMockFreePlayPayload();
  const { embed, components } = buildFreePlayRadarEmbed(freeToKeep, freePlayEvents, 'USD');

  console.log('\n[Simulated Discord Embed Structure]');
  console.log(`Title:       ${embed.title}`);
  console.log(`Description: ${embed.description}`);
  console.log(`Color:       0x${embed.color.toString(16).toUpperCase()}`);
  console.log(`Footer:      ${embed.footer?.text}`);
  console.log(`Thumbnail:   ${embed.thumbnail?.url || 'None'}`);
  console.log(`Fields:      ${embed.fields.length}`);
  console.log(`Components:  ${components[0]?.components?.length || 0} buttons\n`);

  embed.fields.forEach((field, i) => {
    console.log(`--- [Field ${i + 1}] ${field.name} ---`);
    console.log(field.value);
    console.log('');
  });

  const validation = validateDiscordLimits(embed);

  console.log('--- Discord Embed Constraints Validation ---');
  console.log('Status | Metric / Check                              | Actual | Limit');
  console.log('-------+---------------------------------------------+--------+------');
  for (const r of validation.results) {
    const status = r.pass ? '[PASS]' : '[FAIL]';
    const checkName = r.check.padEnd(43, ' ');
    const actualStr = String(r.actual).padStart(6, ' ');
    const limitStr = String(r.limit).padStart(6, ' ');
    console.log(`${status} | ${checkName} | ${actualStr} | ${limitStr}`);
  }
  console.log('--------------------------------------------------------------------');

  if (!validation.allPassed) {
    console.error('\nValidation FAILED: One or more Discord embed constraints were violated.');
    process.exit(1);
  }

  console.log('\nAll Discord embed constraint checks PASSED cleanly.');

  // Check CLI arguments for --send-dm <userId>
  const args = process.argv.slice(2);
  let targetUserId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--send-dm' && args[i + 1]) {
      targetUserId = args[i + 1];
      break;
    } else if (args[i].startsWith('--send-dm=')) {
      targetUserId = args[i].split('=')[1];
      break;
    }
  }

  if (targetUserId) {
    await dispatchTestDm(targetUserId, embed, components);
  } else {
    console.log('\nTip: To dispatch this embed to a Discord DM, run:');
    console.log('  node scripts/simulateFreePlayRadar.js --send-dm <your_discord_user_id>\n');
  }
}

run().catch((err) => {
  console.error('Fatal simulation error:', err);
  process.exit(1);
});
