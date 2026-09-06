import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getGameDealInfo, getMarketOverviewDeals } from '../utils/itadApi.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const ALERT_PALETTE = {
  FREE_TO_KEEP: 0x57F287,    // Emerald Green
  FREE_PLAY_DAYS: 0x9B59B6,  // Amethyst Purple
  CURATED_DEAL: 0x5865F2,    // Blurple
  ALL_TIME_LOW: 0xFEE75C,    // Gold Amber
};

function createStoreButtons(deal) {
  const buttons = [];

  if (deal.primaryDeal?.url) {
    buttons.push({
      type: 2, // BUTTON
      style: 5, // LINK
      label: `Open in ${deal.primaryDeal.shopName}`,
      url: deal.primaryDeal.url,
    });
  }

  if (deal.cheaperAlternative?.url) {
    buttons.push({
      type: 2,
      style: 5,
      label: `Alternative: ${deal.cheaperAlternative.shopName}`,
      url: deal.cheaperAlternative.url,
    });
  }

  if (deal.steamAppId) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB Entry',
      url: `https://steamdb.info/app/${deal.steamAppId}/`,
    });
  } else if (deal.title) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB Search',
      url: `https://steamdb.info/search/?a=app&q=${encodeURIComponent(deal.title)}`,
    });
  }

  if (buttons.length === 0) return [];

  return [
    {
      type: 1, // ACTION_ROW
      components: buttons.slice(0, 5),
    },
  ];
}

async function sendDiscordDm(userId, embed, components = []) {
  try {
    const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    });

    if (!dmChannelRes.ok) {
      const errorText = await dmChannelRes.text();
      console.warn(`Could not open DM channel for user ${userId}: ${dmChannelRes.status} - ${errorText}`);
      return false;
    }

    const dmChannel = await dmChannelRes.json();

    const messagePayload = { embeds: [embed] };
    if (components.length > 0) {
      messagePayload.components = components;
    }

    const messageRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });

    if (!messageRes.ok) {
      const errorText = await messageRes.text();
      console.warn(`Could not send DM message to user ${userId}: ${messageRes.status} - ${errorText}`);
      return false;
    }

    console.log(`DM successfully sent to user ${userId}`);
    return true;
  } catch (error) {
    console.error(`Error sending DM to user ${userId}:`, error.message || error);
    return false;
  }
}

async function sendGuildChannelAlert(channelId, embed, components = []) {
  try {
    const messagePayload = { embeds: [embed] };
    if (components.length > 0) {
      messagePayload.components = components;
    }

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.warn(`Could not send guild alert to channel ${channelId}: ${res.status} - ${errorText}`);
      return false;
    }

    console.log(`Guild alert successfully sent to channel ${channelId}`);
    return true;
  } catch (error) {
    console.error(`Error sending alert to channel ${channelId}:`, error.message || error);
    return false;
  }
}

export const handler = async () => {
  console.log('Starting zT Radar scheduled deal scanner...');

  try {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
      })
    );

    const allItems = scanResult.Items || [];
    const wishlistItems = allItems.filter((item) => item.SK?.startsWith('GAME#'));
    const guildConfigs = allItems.filter((item) => item.PK?.startsWith('GUILD#') && item.SK === 'CONFIG');
    const userConfigs = allItems.filter((item) => item.PK?.startsWith('USER#') && item.SK === 'CONFIG');

    const userCurrencyMap = new Map();
    userConfigs.forEach((cfg) => {
      const uid = cfg.PK.replace('USER#', '');
      userCurrencyMap.set(uid, cfg.preferred_currency || 'USD');
    });

    console.log(`Retrieved ${wishlistItems.length} wishlist items and ${guildConfigs.length} guild configs.`);

    // 1. Process Individual Wishlists (DMs)
    if (wishlistItems.length > 0) {
      const userDmCountMap = new Map();
      const MAX_DM_PER_USER = 3;

      for (const item of wishlistItems) {
        const userId = item.user_id || item.PK?.replace('USER#', '');
        const currentDmCount = userDmCountMap.get(userId) || 0;
        if (currentDmCount >= MAX_DM_PER_USER) {
          continue;
        }

        const preferredCurrency = userCurrencyMap.get(userId) || 'USD';
        const deal = await getGameDealInfo(item.external_game_id, preferredCurrency, item.game_title);
        if (!deal) continue;

        const effectivePrice = deal.cheaperAlternative?.salePrice ?? deal.primaryDeal?.salePrice ?? 0;
        const effectiveCut = deal.cheaperAlternative?.cutPercent ?? deal.primaryDeal?.cutPercent ?? 0;
        const regularPrice = deal.cheaperAlternative?.regularPrice ?? deal.primaryDeal?.regularPrice ?? 0;
        const sym = deal.primaryDeal?.currencySymbol || (preferredCurrency === 'BRL' ? 'R$' : '$');

        // Enforce that promotional alerts strictly require an active discount
        const hasActiveDiscount = effectiveCut > 0 && effectivePrice < regularPrice;

        const minDiscount = item.min_discount ?? 70;
        const minRating = item.min_rating ?? null;

        // Skip title if it fails the user's minimum review score requirement
        if (minRating !== null && deal.reviewScore !== null && deal.reviewScore !== undefined && deal.reviewScore < minRating) {
          continue;
        }

        let shouldAlert = false;
        let alertReason = '';
        let embedColor = ALERT_PALETTE.CURATED_DEAL;

        if (deal.dealType === 'FREE_TO_KEEP' || (item.alert_free && effectivePrice === 0 && (effectiveCut > 0 || regularPrice > 0))) {
          shouldAlert = true;
          alertReason = '100% FREE TO KEEP (Permanent Ownership)';
          embedColor = ALERT_PALETTE.FREE_TO_KEEP;
        } else if (deal.dealType === 'FREE_PLAY_DAYS') {
          shouldAlert = true;
          alertReason = 'FREE PLAY EVENT (Play For Free This Weekend)';
          embedColor = ALERT_PALETTE.FREE_PLAY_DAYS;
        } else if (hasActiveDiscount && item.target_price && effectivePrice <= Number(item.target_price)) {
          shouldAlert = true;
          alertReason = `TARGET PRICE REACHED (≤ ${sym} ${Number(item.target_price).toFixed(2)})`;
          embedColor = ALERT_PALETTE.ALL_TIME_LOW;
        } else if (hasActiveDiscount && effectiveCut >= minDiscount) {
          if (deal.isAllTimeLow && item.alert_all_time_low) {
            shouldAlert = true;
            alertReason = `HISTORICAL ALL-TIME LOW PRICE HIT (-${effectiveCut}% OFF)`;
            embedColor = ALERT_PALETTE.ALL_TIME_LOW;
          } else if (item.alert_steep_discount) {
            shouldAlert = true;
            alertReason = `MAJOR PROMOTION: -${effectiveCut}% OFF`;
            embedColor = ALERT_PALETTE.CURATED_DEAL;
          }
        }

        const lastPrice = item.last_notified_price !== undefined ? Number(item.last_notified_price) : null;
        const isNewLowerPrice = lastPrice === null || effectivePrice < lastPrice;

        if (lastPrice !== null && effectiveCut === 0) {
          try {
            await docClient.send(
              new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: item.PK, SK: item.SK },
                UpdateExpression: 'REMOVE last_notified_price, last_notified_at',
              })
            );
          } catch (resetErr) {
            console.error(`Failed to reset notification state for ${item.SK}:`, resetErr);
          }
        }

        if (shouldAlert && isNewLowerPrice) {
          console.log(`DM Alert triggered for user ${userId} on ${item.game_title}: ${alertReason}`);

          const primarySym = deal.primaryDeal.currencySymbol || sym;
          const diffPricing = [
            '```diff',
            `- Regular Price: ${primarySym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
            `+ Promotion:     ${primarySym} ${deal.primaryDeal.salePrice.toFixed(2)} (-${deal.primaryDeal.cutPercent}%)`,
            '```',
          ].join('\n');

          const fields = [
            {
              name: `Storefront Offer ❖ ${deal.primaryDeal.shopName}`,
              value: diffPricing,
              inline: false,
            },
          ];

          if (deal.cheaperAlternative) {
            const altSym = deal.cheaperAlternative.currencySymbol || primarySym;
            fields.push({
              name: `Cheaper at ${deal.cheaperAlternative.shopName}!`,
              value: `▸ Price: **${altSym} ${deal.cheaperAlternative.salePrice.toFixed(2)}** (-${deal.cheaperAlternative.cutPercent}%)`,
              inline: false,
            });
          }

          if (deal.allTimeLowPrice !== null) {
            const atlText = (deal.isAllTimeLow && hasActiveDiscount)
              ? `**${primarySym} ${deal.allTimeLowPrice.toFixed(2)}** (★ Matches ATL)`
              : `**${primarySym} ${deal.allTimeLowPrice.toFixed(2)}**`;
            fields.push({
              name: 'Historical Low',
              value: atlText,
              inline: true,
            });
          }

          if (deal.reviewScore) {
            fields.push({
              name: 'Community Score',
              value: `▸ **${deal.reviewScore}/100** approval`,
              inline: true,
            });
          }

          const embed = {
            title: `zT Radar ❖ Wishlist Alert: ${item.game_title}`,
            description: `**${alertReason}**`,
            color: embedColor,
            fields,
            footer: {
              text: 'zT Radar • Direct Wishlist Dispatch',
            },
            timestamp: new Date().toISOString(),
          };

          if (deal.imageUrl) {
            embed.image = { url: deal.imageUrl };
          }

          const components = createStoreButtons(deal);
          const sent = await sendDiscordDm(userId, embed, components);

          if (sent) {
            userDmCountMap.set(userId, currentDmCount + 1);
            try {
              await docClient.send(
                new UpdateCommand({
                  TableName: TABLE_NAME,
                  Key: { PK: item.PK, SK: item.SK },
                  UpdateExpression: 'SET last_notified_price = :price, last_notified_at = :notifiedAt',
                  ExpressionAttributeValues: {
                    ':price': effectivePrice,
                    ':notifiedAt': new Date().toISOString(),
                  },
                })
              );
            } catch (dbError) {
              console.error(`Failed to update notification state for ${item.SK}:`, dbError);
            }
          }
        }
      }
    }

    // 2. Process Curated Server Channel Radar
    if (guildConfigs.length > 0) {
      for (const config of guildConfigs) {
        if (!config.alert_channel_id) continue;

        const targetCurrency = config.currency || 'USD';
        const targetMinDiscount = config.min_discount ?? 70;
        const targetFreeOnly = config.free_only ?? false;
        const targetMinRating = config.min_rating ?? 80;
        const includeThirdParty = config.include_third_party ?? false;
        const broadcastedHistory = config.last_broadcasted_deals || [];

        const marketDeals = await getMarketOverviewDeals(includeThirdParty, targetCurrency);

        let sentThisRun = 0;
        const newlyBroadcastedKeys = [];

        for (const deal of marketDeals) {
          if (sentThisRun >= 3) break;

          const isFree = deal.primaryDeal?.salePrice === 0;
          const cut = deal.primaryDeal?.cutPercent ?? 0;
          const isFreeWeekend = deal.dealType === 'FREE_PLAY_DAYS';
          const isFreeToKeep = deal.dealType === 'FREE_TO_KEEP';
          const uniqueDealKey = `${deal.gameId}_${deal.primaryDeal.salePrice}_${deal.dealType}`;

          if (broadcastedHistory.includes(uniqueDealKey) || newlyBroadcastedKeys.includes(uniqueDealKey)) {
            continue;
          }

          if (targetFreeOnly && !isFree) continue;
          if (!targetFreeOnly && !isFree && cut < targetMinDiscount) continue;

          if (!isFree && deal.reviewScore && deal.reviewScore < targetMinRating) {
            continue;
          }

          const sym = deal.primaryDeal.currencySymbol || (targetCurrency === 'BRL' ? 'R$' : '$');

          let embedColor = ALERT_PALETTE.CURATED_DEAL;
          let bannerHeadline = `High-value promotion detected (**-${cut}%**)!`;

          let diffPricing = [
            '```diff',
            `- Regular Price: ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
            `+ Sale Price:    ${sym} ${deal.primaryDeal.salePrice.toFixed(2)} (-${deal.primaryDeal.cutPercent}%)`,
            '```',
          ].join('\n');

          if (isFreeToKeep) {
            embedColor = ALERT_PALETTE.FREE_TO_KEEP;
            bannerHeadline = 'Claim this game for **FREE** to keep permanently in your library!';
            diffPricing = [
              '```diff',
              `- Regular Price: ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
              '+ Promotional:   100% FREE TO KEEP (Permanent Ownership)',
              '```',
            ].join('\n');
          } else if (isFreeWeekend) {
            embedColor = ALERT_PALETTE.FREE_PLAY_DAYS;
            bannerHeadline = 'Limited-time **Free Weekend / Play For Free** event active!';
            diffPricing = [
              '```diff',
              `- Regular Price: ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
              '+ Temporary:     FREE PLAY EVENT (Active Weekend Access)',
              '```',
            ].join('\n');
          }

          const fields = [
            {
              name: `Store Offer ❖ ${deal.primaryDeal.shopName}`,
              value: diffPricing,
              inline: false,
            },
          ];

          if (deal.reviewScore) {
            fields.push({
              name: 'Community Evaluation',
              value: `▸ Score: **${deal.reviewScore}/100** approval rating`,
              inline: true,
            });
          }

          const embed = {
            title: `zT Radar ❖ ${deal.title}`,
            description: bannerHeadline,
            color: embedColor,
            fields,
            footer: {
              text: `zT Radar • Curated Deal Broadcast (${targetCurrency})`,
            },
            timestamp: new Date().toISOString(),
          };

          if (deal.imageUrl) {
            embed.image = { url: deal.imageUrl };
          }

          const components = createStoreButtons(deal);
          const sent = await sendGuildChannelAlert(config.alert_channel_id, embed, components);

          if (sent) {
            sentThisRun++;
            newlyBroadcastedKeys.push(uniqueDealKey);
          }
        }

        if (newlyBroadcastedKeys.length > 0) {
          const updatedHistory = [...broadcastedHistory, ...newlyBroadcastedKeys].slice(-50);
          try {
            await docClient.send(
              new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: config.PK, SK: config.SK },
                UpdateExpression: 'SET last_broadcasted_deals = :history, updated_at = :now',
                ExpressionAttributeValues: {
                  ':history': updatedHistory,
                  ':now': new Date().toISOString(),
                },
              })
            );
          } catch (dbError) {
            console.error(`Failed to update broadcast history for guild ${config.guild_id}:`, dbError);
          }
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Scan and notifications processed successfully.' }),
    };
  } catch (error) {
    console.error('Fatal error during scheduled deal scanner execution:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};