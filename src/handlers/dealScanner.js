import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getGameDealInfo } from '../utils/itadApi.js';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || 'zt-radar-table';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Hardcoded store mapping for CheapShark API (MVP)
// We will move this to a separate API call later for ITAD.
const STORE_MAP = {
  "1": "Steam",
  "2": "GamersGate",
  "3": "GreenManGaming",
  "7": "GOG",
  "11": "Humble Store",
  "25": "Epic Games Store"
};

export const handler = async () => {
  console.log('Starting zT Radar scheduled deal scanner...');

  try {
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

    const uniqueTitles = [...new Set(wishlistItems.map((item) => item.game_title))];
    console.log(`Deduplicated to ${uniqueTitles.length} unique titles to query.`);

    const dealsCache = {};
    for (const title of uniqueTitles) {
      const deal = await getGameDealInfo(title);
      if (deal) {
        dealsCache[title] = deal;
      }
    }

    for (const item of wishlistItems) {
      const deal = dealsCache[item.game_title];
      if (!deal) continue;

      let shouldAlert = false;
      let alertReason = '';

      // UPDATED: Clarify comparison is in USD ($)
      if (item.alert_free && deal.salePrice === 0) {
        shouldAlert = true;
        alertReason = '100% Free Game Alert!';
      } else if (item.target_price && deal.salePrice <= item.target_price) {
        shouldAlert = true;
        alertReason = `Price reached target ($${deal.salePrice.toFixed(2)} USD <= $${item.target_price.toFixed(2)} USD)`;
      } else if (item.alert_steep_discount && deal.savingsPercent >= 70) {
        shouldAlert = true;
        alertReason = `Massive Discount Alert: ${Math.round(deal.savingsPercent)}% OFF!`;
      }

      if (shouldAlert) {
        // Find store name from mapping
        const rawStoreId = deal.dealId ? deal.dealId.split('_')[0] : ''; // CheapShark dealIDs sometimes contain store information but not always. Better logic needed in itadApi.js later.
        
        // CheapShark API v1.0 usually returns best deal, and itadApi.js currently 
        // retrieves the 'deals' endpoint but doesn't map storeID back efficiently.
        // We will improve this mapping in the next phase.
        const storeName = STORE_MAP[rawStoreId] || 'Best Store';

        console.log(`Alert triggered for User ${item.user_id} on game ${item.game_title}: ${alertReason}`);
        await sendDiscordDirectMessage(item.user_id, deal, alertReason, storeName);
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
async function sendDiscordDirectMessage(userId, deal, reason, storeName) {
  if (!BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not configured.');
    return;
  }

  try {
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

    const embedPayload = {
      embeds: [
        {
          title: `🎯 ${deal.title}`,
          description: `**${reason}**\n\n💰 **Current Price:** $${deal.salePrice.toFixed(2)} USD *(was $${deal.normalPrice.toFixed(2)})*\n📉 **Savings:** ${Math.round(deal.savingsPercent)}% OFF\n🏪 **Available at:** ${storeName}\n⭐ **Metacritic:** ${deal.metacriticScore > 0 ? deal.metacriticScore : 'N/A'}`,
          url: deal.dealUrl,
          color: 0x00ff88,
          thumbnail: { url: deal.thumb },
          footer: { text: 'zT Radar Intelligence | CheapShark USD MVP' }, // Updated footer
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