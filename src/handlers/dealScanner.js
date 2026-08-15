import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getGameDealInfo } from '../utils/itadApi.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

async function sendDiscordDm(userId, embed) {
  try {
    const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    });

    if (!dmChannelRes.ok) {
      const errorText = await dmChannelRes.text();
      throw new Error(`Failed to create DM channel: ${dmChannelRes.status} - ${errorText}`);
    }

    const dmChannel = await dmChannelRes.json();

    const messageRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!messageRes.ok) {
      const errorText = await messageRes.text();
      throw new Error(`Failed to send message: ${messageRes.status} - ${errorText}`);
    }

    console.log(`DM successfully sent to user ${userId}`);
  } catch (error) {
    console.error(`Error sending DM to user ${userId}:`, error);
  }
}

async function sendGuildChannelAlert(channelId, embed) {
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to send guild alert: ${res.status} - ${errorText}`);
    }

    console.log(`Guild alert successfully sent to channel ${channelId}`);
  } catch (error) {
    console.error(`Error sending alert to channel ${channelId}:`, error);
  }
}

export const handler = async () => {
  console.log('Starting zT Radar scheduled deal scanner...');

  try {
    // Scan all wishlist items and guild channel configurations
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

    // Deduplicate game IDs
    const uniqueGameIds = [...new Set(wishlistItems.map((item) => item.external_game_id).filter(Boolean))];
    console.log(`Unique games to fetch deal info: ${uniqueGameIds.length}`);

    const dealsMap = new Map();
    for (const gameId of uniqueGameIds) {
      const dealInfo = await getGameDealInfo(gameId);
      if (dealInfo) {
        dealsMap.set(gameId, dealInfo);
      }
    }

    // Process alerts for wishlisted users
    const publicBroadcastDeals = new Set();

    for (const item of wishlistItems) {
      const deal = dealsMap.get(item.external_game_id);
      if (!deal) continue;

      const effectivePrice = deal.bestDeal?.salePrice ?? deal.primaryDeal?.salePrice ?? 0;
      const effectiveCut = deal.bestDeal?.cutPercent ?? deal.primaryDeal?.cutPercent ?? 0;

      let shouldAlert = false;
      let alertReason = '';

      if (item.alert_free && effectivePrice === 0) {
        shouldAlert = true;
        alertReason = '100% FREE GAME ALERT!';
        publicBroadcastDeals.add(deal);
      } else if (item.target_price && effectivePrice <= Number(item.target_price)) {
        shouldAlert = true;
        alertReason = `Target Price Reached (<= R$ ${Number(item.target_price).toFixed(2)})!`;
      } else if (deal.isAllTimeLow && item.alert_all_time_low) {
        shouldAlert = true;
        alertReason = 'ALL-TIME LOW PRICE HIT!';
      } else if (item.alert_steep_discount && effectiveCut >= 70) {
        shouldAlert = true;
        alertReason = `Massive Discount Alert: ${effectiveCut}% OFF!`;
        publicBroadcastDeals.add(deal);
      }

      if (shouldAlert) {
        console.log(`Alert triggered for user ${item.user_id} on ${item.game_title}: ${alertReason}`);

        const fields = [
          {
            name: `${deal.primaryDeal.shopName} (Primary Offer)`,
            value: `Price: **R$ ${deal.primaryDeal.salePrice.toFixed(2)}** (Regular: R$ ${deal.primaryDeal.regularPrice.toFixed(2)} | -${deal.primaryDeal.cutPercent}%)\n[Store Link](${deal.primaryDeal.url})`,
            inline: false,
          },
        ];

        if (deal.cheaperAlternative) {
          fields.push({
            name: `Cheaper at ${deal.cheaperAlternative.shopName}!`,
            value: `Price: **R$ ${deal.cheaperAlternative.salePrice.toFixed(2)}** (Regular: R$ ${deal.cheaperAlternative.regularPrice.toFixed(2)} | -${deal.cheaperAlternative.cutPercent}%)\n[Alternative Store Link](${deal.cheaperAlternative.url})`,
            inline: false,
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

        await sendDiscordDm(item.user_id, embed);
      }
    }

    // Broadcast massive public deals to configured guild channels
    if (guildConfigs.length > 0 && publicBroadcastDeals.size > 0) {
      console.log(`Broadcasting ${publicBroadcastDeals.size} major deals to ${guildConfigs.length} guild channels.`);

      for (const deal of publicBroadcastDeals) {
        const fields = [
          {
            name: `${deal.primaryDeal.shopName} (Primary Offer)`,
            value: `Price: **R$ ${deal.primaryDeal.salePrice.toFixed(2)}** (Regular: R$ ${deal.primaryDeal.regularPrice.toFixed(2)} | -${deal.primaryDeal.cutPercent}%)\n[Store Link](${deal.primaryDeal.url})`,
            inline: false,
          },
        ];

        if (deal.cheaperAlternative) {
          fields.push({
            name: `Cheaper at ${deal.cheaperAlternative.shopName}!`,
            value: `Price: **R$ ${deal.cheaperAlternative.salePrice.toFixed(2)}** (Regular: R$ ${deal.cheaperAlternative.regularPrice.toFixed(2)} | -${deal.cheaperAlternative.cutPercent}%)\n[Alternative Store Link](${deal.cheaperAlternative.url})`,
            inline: false,
          });
        }

        const embed = {
          title: `Community Deal Alert: ${deal.title}`,
          description: deal.primaryDeal.salePrice === 0 ? 'Grab this game for FREE!' : 'Massive community discount detected!',
          color: 0x2ecc71,
          fields,
          footer: {
            text: 'zT Radar Guild Deals • AWS Serverless',
          },
          timestamp: new Date().toISOString(),
        };

        for (const config of guildConfigs) {
          if (config.alert_channel_id) {
            await sendGuildChannelAlert(config.alert_channel_id, embed);
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