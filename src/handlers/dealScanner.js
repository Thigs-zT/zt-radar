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

    const uniqueGames = [];
    const seen = new Set();

    for (const item of wishlistItems) {
      const key = item.external_game_id || item.game_title;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueGames.push({ id: item.external_game_id, title: item.game_title });
      }
    }

    console.log(`Deduplicated to ${uniqueGames.length} unique titles to query.`);

    const dealsCache = {};
    for (const game of uniqueGames) {
      const deal = await getGameDealInfo(game.id, game.title);
      if (deal) {
        dealsCache[game.title] = deal;
      }
    }

    for (const item of wishlistItems) {
      const deal = dealsCache[item.game_title];
      if (!deal || !deal.primaryDeal) continue;

      const mainDeal = deal.primaryDeal;
      const bestPrice = deal.secondaryDeal ? Math.min(mainDeal.salePrice, deal.secondaryDeal.salePrice) : mainDeal.salePrice;
      const bestSavings = deal.secondaryDeal ? Math.max(mainDeal.savingsPercent, deal.secondaryDeal.savingsPercent) : mainDeal.savingsPercent;

      let shouldAlert = false;
      let alertReason = '';

      if (item.alert_free && bestPrice === 0) {
        shouldAlert = true;
        alertReason = '100% Free Game Alert!';
      } else if (deal.isAllTimeLow && item.alert_all_time_low) {
        shouldAlert = true;
        alertReason = 'Historical Low Price Alert (Menor Preço Histórico)!';
      } else if (item.target_price && bestPrice <= item.target_price) {
        shouldAlert = true;
        alertReason = `Price reached target (${deal.currencySymbol} ${bestPrice.toFixed(2)} <= ${deal.currencySymbol} ${item.target_price.toFixed(2)})`;
      } else if (item.alert_steep_discount && bestSavings >= 70) {
        shouldAlert = true;
        alertReason = `Massive Discount Alert: ${Math.round(bestSavings)}% OFF!`;
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
 * Sends a rich embed DM to a Discord user with multi-store comparison
 */
async function sendDiscordDirectMessage(userId, deal, reason) {
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

    const main = deal.primaryDeal;
    let descriptionText = `**${reason}**\n\n`;

    // Main Store Block (Steam Priority)
    descriptionText += `🎮 **${main.storeName}:** [${deal.currencySymbol} ${main.salePrice.toFixed(2)}](${main.dealUrl}) *(was ${deal.currencySymbol} ${main.normalPrice.toFixed(2)} | -${Math.round(main.savingsPercent)}%)*\n`;

    // Secondary / Cheaper Store Block (if applicable)
    if (deal.secondaryDeal) {
      const alt = deal.secondaryDeal;
      descriptionText += `🔥 **Melhor Preço Alternativo (${alt.storeName}):** [${deal.currencySymbol} ${alt.salePrice.toFixed(2)}](${alt.dealUrl}) *(-${Math.round(alt.savingsPercent)}%)*\n`;
    }

    const embedPayload = {
      embeds: [
        {
          title: `🎯 ${deal.title}`,
          description: descriptionText,
          url: main.dealUrl,
          color: 0x00ff88,
          thumbnail: deal.thumb ? { url: deal.thumb } : undefined,
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