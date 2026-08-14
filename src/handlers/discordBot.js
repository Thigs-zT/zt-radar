import { verifyKey } from 'discord-interactions';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { searchGamesForAutocomplete } from '../utils/itadApi.js';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || 'zt-radar-table';

export const handler = async (event) => {
  const CLIENT_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

  const signature = event.headers?.['x-signature-ed25519'] || event.headers?.['X-Signature-Ed25519'];
  const timestamp = event.headers?.['x-signature-timestamp'] || event.headers?.['X-Signature-Timestamp'];

  let rawBody = event.body || '';
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(event.body, 'base64').toString('utf8');
  }

  if (!signature || !timestamp || !rawBody) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Missing signature headers' }),
    };
  }

  const isValidRequest = await verifyKey(rawBody, signature, timestamp, CLIENT_PUBLIC_KEY);

  if (!isValidRequest) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  const message = JSON.parse(rawBody);

  // Type 1: Discord PING verification
  if (message.type === 1) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 1 }),
    };
  }

  // Type 4: APPLICATION_COMMAND_AUTOCOMPLETE
  if (message.type === 4) {
    try {
      // Find focused option in subcommands
      const subCommandOptions = message.data?.options?.[0]?.options || [];
      const focusedOption = subCommandOptions.find((opt) => opt.focused) || 
                            message.data?.options?.find((opt) => opt.focused);

      const queryValue = focusedOption?.value || '';
      console.log('Autocomplete query received for:', queryValue);

      const choices = await searchGamesForAutocomplete(queryValue);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 8, // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
          data: {
            choices: choices || [],
          },
        }),
      };
    } catch (err) {
      console.error('Autocomplete Error:', err);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 8,
          data: { choices: [] },
        }),
      };
    }
  }

  // Type 2: Slash Commands
  if (message.type === 2) {
    const { name, options } = message.data;
    const userId = message.member?.user?.id || message.user?.id;

    if (name === 'wishlist') {
      const subCommand = options?.[0]?.name;

      if (subCommand === 'add') {
        const subOptions = options[0].options || [];
        const gameOption = subOptions.find((opt) => opt.name === 'game');
        const priceOption = subOptions.find((opt) => opt.name === 'target_price');

        const rawValue = gameOption?.value;
        const targetPrice = priceOption?.value ? Number(priceOption.value) : null;

        if (!rawValue) {
          return createEphemeralResponse('Game title is required.');
        }

        // Accepts selected items ("ID|Title") or raw typed text gracefully
        let externalGameId = null;
        let gameTitle = rawValue;

        if (rawValue.includes('|')) {
          const parts = rawValue.split('|');
          externalGameId = parts[0];
          gameTitle = parts[1];
        }

        const normalizedGame = gameTitle.trim().toLowerCase();

        try {
          const item = {
            PK: `USER#${userId}`,
            SK: `GAME#${normalizedGame}`,
            game_title: gameTitle.trim(),
            external_game_id: externalGameId,
            target_price: targetPrice,
            alert_all_time_low: true,
            alert_free: true,
            alert_steep_discount: true,
            user_id: userId,
            created_at: new Date().toISOString(),
          };

          await docClient.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: item,
            })
          );

          const customPriceMsg = targetPrice ? ` or target price R$ ${targetPrice.toFixed(2)}` : '';
          return createEphemeralResponse(
            `Added **"${gameTitle.trim()}"** to your zT Radar wishlist!\n` +
            `🔔 **Active Alerts:** Historical Lows, 100% Free deals, Discounts >= 70%${customPriceMsg}.`
          );
        } catch (dbError) {
          console.error('DynamoDB Put Error:', dbError);
          return createEphemeralResponse('Failed to save game. Please try again.');
        }
      }

      if (subCommand === 'list') {
        try {
          const response = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
              ExpressionAttributeValues: {
                ':pk': `USER#${userId}`,
                ':sk': 'GAME#',
              },
            })
          );

          const items = response.Items || [];

          if (items.length === 0) {
            return createEphemeralResponse('Your zT Radar wishlist is currently empty. Use `/wishlist add` to start tracking.');
          }

          const gameList = items
            .map((i) => `- **${i.game_title}**${i.target_price ? ` (Target: R$ ${i.target_price.toFixed(2)})` : ' (Auto Deals Active)'}`)
            .join('\n');

          return createEphemeralResponse(`**Your Tracked Wishlist:**\n${gameList}`);
        } catch (dbError) {
          console.error('DynamoDB Query Error:', dbError);
          return createEphemeralResponse('Failed to retrieve wishlist. Please try again.');
        }
      }
    }
  }

  return createEphemeralResponse('Command not recognized.');
};

function createEphemeralResponse(content) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 4,
      data: {
        content: content,
        flags: 64,
      },
    }),
  };
}