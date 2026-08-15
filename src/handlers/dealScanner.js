import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getGameDealInfo } from '../utils/itadApi.js';

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

  // SteamDB Link generated from resolved steamAppId
  if (deal.steamAppId) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB',
      url: `https://steamdb.info/app/${deal.steamAppId}/`,
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
      throw new Error(`Failed to create DM channel: ${dmChannelRes.status} - ${errorText}`);
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
      throw new Error(`Failed to send message: ${messageRes.status} - ${errorText}`);
    }

    console.log(`DM successfully sent to user ${userId}`);
    return true;
  } catch (error) {
    console.error(`Error sending DM to user ${userId}:`, error);
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
      throw new Error(`Failed to send guild alert: ${res.status} - ${errorText}`);
    }

    console.log(`Guild alert successfully sent to channel ${channelId}`);
    return true;
  } catch (error) {
    console.error(`Error sending alert to channel ${channelId}:`, error);
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

    if (wishlistItems.length === 0) {
      console.log('No games to track. Exiting scanner.');
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No wishlist items found.' }),
      };
    }

    const uniqueGameIds = [...new Set(wishlistItems.map((item) => item.external_game_id).filter(Boolean))];
    console.log(`Unique games to fetch deal info: ${uniqueGameIds.length}`);

    const dealsMap = new Map();
    for (const gameId of uniqueGameIds) {
      const dealInfo = await getGameDealInfo(gameId);
      if (dealInfo) {
        dealsMap.set(gameId, dealInfo);
      }
    }

    // 1. Process Individual User Wishlist Alerts
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

      // If price went back up to regular, reset notification state so future discounts trigger alerts
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
        console.log(`Alert triggered for user ${item.user_id} on ${item.game_title}: ${alertReason}`);

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

    // 2. Process Independent Server (Guild) Broadcasts
    if (guildConfigs.length > 0) {
      for (const [, deal] of dealsMap) {
        const isFree = deal.primaryDeal?.salePrice === 0 || deal.cheaperAlternative?.salePrice === 0;
        const effectiveCut = deal.cheaperAlternative?.cutPercent ?? deal.primaryDeal?.cutPercent ?? 0;
        const isSteepDeal = effectiveCut >= 70;

        if (!isFree && !isSteepDeal) continue;

        if (!isFree && deal.reviewScore && deal.reviewScore < 70) {
          console.log(`Skipping public broadcast for ${deal.title} due to review score (${deal.reviewScore}/100).`);
          continue;
        }

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
          title: `Community Deal Alert: ${deal.title}`,
          description: isFree ? 'Grab this game for FREE!' : `Massive discount detected (-${effectiveCut}%)!`,
          color: 0x2ecc71,
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

        for (const config of guildConfigs) {
          if (config.alert_channel_id) {
            await sendGuildChannelAlert(config.alert_channel_id, embed, components);
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