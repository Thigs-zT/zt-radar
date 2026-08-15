import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getGameDealInfo } from '../utils/itadApi.js';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || 'zt-radar-table';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export const handler = async () => {
  console.log('Starting zT Radar scheduled deal scanner...');

  try {
    // 1. Fetch all wishlist entries from DynamoDB
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':skPrefix': 'GAME#',
        },
      })
    );

    const wishlistItems = scanResult.Items || [];
    console.log(`Retrieved ${wishlistItems.length} monitored wishlist items.`);

    if (wishlistItems.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No games to scan.' }) };
    }

    // 2. Deduplicate unique game titles
    const uniqueTitles = [...new Set(wishlistItems.map((item) => item.game_title))];
    console.log(`Deduplicated to ${uniqueTitles.length} unique titles to query.`);

    // 3. Query market deals for unique games
    const dealsCache = {};
    for (const title of uniqueTitles) {
      const deal = await getGameDealInfo(title);
      if (deal) {
        dealsCache[title] = deal;
      }
    }

    // 4. Match deals against user wishlist criteria
    for (const item of wishlistItems) {
      const deal = dealsCache[item.game_title];
      if (!deal) continue;

      let shouldAlert = false;
      let alertReason = '';

      if (item.alert_free && deal.salePrice === 0) {
        shouldAlert = true;
        alertReason = '100% Free Game Alert!';
      } else if (item.target_price && deal.salePrice <= item.target_price) {
        shouldAlert = true;
        alertReason = `Price reached target (R$ ${deal.salePrice.toFixed(2)} <= R$ ${item.target_price.toFixed(2)})`;
      } else if (item.alert_steep_discount && deal.savingsPercent >= 70) {
        shouldAlert = true;
        alertReason = `Massive Discount Alert: ${Math.round(deal.savingsPercent)}% OFF!`;
      }

      if (shouldAlert) {
        console.log(`Alert triggered for User ${item.user_id} on game ${item.game_title}: ${alertReason}`);
        await sendDiscordDirectMessage(item.user_id, deal, alertReason);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Scan and notifications processed successfully.' }),
    };
  } catch (error) {
    console.error('Deal Scanner Execution Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

/**
 * Sends a rich embed DM to a Discord user
 */
async function sendDiscordDirectMessage(userId, deal, reason) {
  if (!BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not configured.');
    return;
  }

  try {
    // 1. Create DM Channel with user
    const createDmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    });

    if (!createDmRes.ok) return;

    const dmChannel = await createDmRes.json();

    // 2. Send formatted message with Embed
    const embedPayload = {
      embeds: [
        {
          title: `🎯 ${deal.title}`,
          description: `**${reason}**\n\n💰 **Current Price:** $${deal.salePrice.toFixed(2)} *(was $${deal.normalPrice.toFixed(2)})*\n📉 **Savings:** ${Math.round(deal.savingsPercent)}% OFF\n⭐ **Metacritic:** ${deal.metacriticScore > 0 ? deal.metacriticScore : 'N/A'}`,
          url: deal.dealUrl,
          color: 0x00ff88,
          thumbnail: { url: deal.thumb },
          footer: { text: 'zT Radar Intelligence | Serverless Deal Monitor' },
        },
      ],
    };

    await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(embedPayload),
    });
  } catch (err) {
    console.error(`Failed to send DM to ${userId}:`, err.message);
  }
}