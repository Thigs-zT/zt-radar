import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getGameDealInfo, getMarketOverviewDeals } from '../utils/itadApi.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

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
      type: 2, // BUTTON
      style: 5, // LINK
      label: `Alternative: ${deal.cheaperAlternative.shopName}`,
      url: deal.cheaperAlternative.url,
    });
  }

  if (deal.steamAppId) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB',
      url: `https://steamdb.info/app/${deal.steamAppId}/`,
    });
  } else if (deal.title) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB',
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

    console.log(`Retrieved ${wishlistItems.length} wishlist items and ${guildConfigs.length} guild configs.`);

    // 1. Process Individual Wishlists (DMs)
    if (wishlistItems.length > 0) {
      const uniqueGameIds = [...new Set(wishlistItems.map((item) => item.external_game_id).filter(Boolean))];
      console.log(`Unique wishlist games to fetch: ${uniqueGameIds.length}`);

      const dealsMap = new Map();
      for (const gameId of uniqueGameIds) {
        const dealInfo = await getGameDealInfo(gameId);
        if (dealInfo) {
          dealsMap.set(gameId, dealInfo);
        }
      }

      for (const item of wishlistItems) {
        const deal = dealsMap.get(item.external_game_id);
        if (!deal) continue;

        const effectivePrice = deal.cheaperAlternative?.salePrice ?? deal.primaryDeal?.salePrice ?? 0;
        const effectiveCut = deal.cheaperAlternative?.cutPercent ?? deal.primaryDeal?.cutPercent ?? 0;

        let shouldAlert = false;
        let alertReason = '';

        if (item.alert_free && effectivePrice === 0) {
          shouldAlert = true;
          alertReason = '100% FREE GAME ALERT!';
        } else if (item.target_price && effectivePrice <= Number(item.target_price)) {
          shouldAlert = true;
          alertReason = `Target Price Reached (<= R$ ${Number(item.target_price).toFixed(2)})!`;
        } else if (deal.isAllTimeLow && item.alert_all_time_low) {
          shouldAlert = true;
          alertReason = 'ALL-TIME LOW PRICE HIT!';
        } else if (item.alert_steep_discount && effectiveCut >= 70) {
          shouldAlert = true;
          alertReason = `Massive Discount Alert: ${effectiveCut}% OFF!`;
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
          console.log(`DM Alert triggered for user ${item.user_id} on ${item.game_title}: ${alertReason}`);

          const fields = [
            {
              name: `${deal.primaryDeal.shopName} (Primary Offer)`,
              value: `Price: **R$ ${deal.primaryDeal.salePrice.toFixed(2)}** (Regular: R$ ${deal.primaryDeal.regularPrice.toFixed(2)} | -${deal.primaryDeal.cutPercent}%)`,
              inline: false,
            },
          ];

          if (deal.cheaperAlternative) {
            fields.push({
              name: `Cheaper at ${deal.cheaperAlternative.shopName}!`,
              value: `Price: **R$ ${deal.cheaperAlternative.salePrice.toFixed(2)}** (Regular: R$ ${deal.cheaperAlternative.regularPrice.toFixed(2)} | -${deal.cheaperAlternative.cutPercent}%)`,
              inline: false,
            });
          }

          if (deal.reviewScore) {
            fields.push({
              name: 'Review Score',
              value: `Rating: **${deal.reviewScore}/100**`,
              inline: true,
            });
          }

          const embed = {
            title: `zT Radar Alert: ${item.game_title}`,
            description: `**${alertReason}**`,
            color: 0x5865f2,
            fields,
            footer: {
              text: 'zT Radar Deal Intelligence • AWS Serverless',
            },
            timestamp: new Date().toISOString(),
          };

          if (deal.imageUrl) {
            embed.image = { url: deal.imageUrl };
          }

          const components = createStoreButtons(deal);
          const sent = await sendDiscordDm(item.user_id, embed, components);

          if (sent) {
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

    // 2. Process Curated Server Channel Radar (Max 3 announcements per cycle)
    if (guildConfigs.length > 0) {
      for (const config of guildConfigs) {
        if (!config.alert_channel_id) continue;

        const targetMinDiscount = config.min_discount ?? 70;
        const targetFreeOnly = config.free_only ?? false;
        const targetMinRating = config.min_rating ?? 75;
        const includeThirdParty = config.include_third_party ?? false;
        const broadcastedHistory = config.last_broadcasted_deals || [];

        const marketDeals = await getMarketOverviewDeals(includeThirdParty);

        let sentThisRun = 0;
        const newlyBroadcastedKeys = [];

        for (const deal of marketDeals) {
          // Cap at maximum 3 deal announcements per server per scan run
          if (sentThisRun >= 3) break;

          const isFree = deal.primaryDeal?.salePrice === 0;
          const cut = deal.primaryDeal?.cutPercent ?? 0;
          const uniqueDealKey = `${deal.gameId}_${deal.primaryDeal.salePrice}`;

          if (broadcastedHistory.includes(uniqueDealKey) || newlyBroadcastedKeys.includes(uniqueDealKey)) {
            continue;
          }

          if (targetFreeOnly && !isFree) continue;
          if (!targetFreeOnly && !isFree && cut < targetMinDiscount) continue;

          // Quality threshold check
          if (!isFree && deal.reviewScore && deal.reviewScore < targetMinRating) {
            continue;
          }

          const fields = [
            {
              name: `${deal.primaryDeal.shopName} (Primary Offer)`,
              value: `Price: **R$ ${deal.primaryDeal.salePrice.toFixed(2)}** (Regular: R$ ${deal.primaryDeal.regularPrice.toFixed(2)} | -${deal.primaryDeal.cutPercent}%)`,
              inline: false,
            },
          ];

          if (deal.reviewScore) {
            fields.push({
              name: 'Review Score',
              value: `Rating: **${deal.reviewScore}/100**`,
              inline: true,
            });
          }

          const embed = {
            title: `Market Deal Radar: ${deal.title}`,
            description: isFree ? 'Grab this game for **FREE**!' : `Massive discount detected (**-${cut}%**)!`,
            color: isFree ? 0x2ecc71 : 0xf1c40f,
            fields,
            footer: {
              text: 'zT Radar Guild Deals • AWS Serverless',
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