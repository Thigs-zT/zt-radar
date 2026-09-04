import { verifyKey } from 'discord-interactions';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { searchGamesForAutocomplete } from '../utils/itadApi.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

const RESPONSE_TYPES = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

const MESSAGE_FLAGS = {
  EPHEMERAL: 64,
};

export const handler = async (event) => {
  const signature = event.headers['x-signature-ed25519'] || event.headers['X-Signature-Ed25519'];
  const timestamp = event.headers['x-signature-timestamp'] || event.headers['X-Signature-Timestamp'];

  let rawBody = event.body || '';
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(event.body, 'base64').toString('utf-8');
  }

  if (!signature || !timestamp || !rawBody) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing interaction signature headers' }),
    };
  }

  const isValidRequest = await verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
  if (!isValidRequest) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request signature' }),
    };
  }

  const interaction = JSON.parse(rawBody);

  // Handshake PING (Type 1)
  if (interaction.type === 1) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: RESPONSE_TYPES.PONG }),
    };
  }

  // Autocomplete Handling (Type 4)
  if (interaction.type === 4) {
    const { name, options } = interaction.data;
    const userId = interaction.member?.user?.id || interaction.user?.id;

    if (name === 'wishlist') {
      const subCommand = options?.[0];
      const subCommandName = subCommand?.name;
      const focusedOption = subCommand?.options?.find((opt) => opt.focused);

      if (focusedOption && focusedOption.name === 'game') {
        const query = focusedOption.value?.trim() || '';

        if (subCommandName === 'remove') {
          try {
            const queryResult = await docClient.send(
              new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: {
                  ':pk': `USER#${userId}`,
                  ':skPrefix': 'GAME#',
                },
              })
            );

            const userGames = queryResult.Items || [];
            const filteredChoices = userGames
              .filter((item) => item.game_title.toLowerCase().includes(query.toLowerCase()))
              .slice(0, 25)
              .map((item) => ({
                name: item.game_title.length > 100 ? item.game_title.substring(0, 97) + '...' : item.game_title,
                value: `${item.external_game_id || ''}|${item.game_title}`.substring(0, 100),
              }));

            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
                data: { choices: filteredChoices },
              }),
            };
          } catch (error) {
            console.error('Error fetching user games for remove autocomplete:', error);
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
                data: { choices: [] },
              }),
            };
          }
        }

        try {
          const suggestions = await searchGamesForAutocomplete(query);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
              data: { choices: suggestions.slice(0, 25) },
            }),
          };
        } catch (error) {
          console.error('Error handling autocomplete lookup:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
              data: { choices: [] },
            }),
          };
        }
      }
    }
  }

  // Slash Command Interactions (Type 2)
  if (interaction.type === 2) {
    const { name, options } = interaction.data;
    const userId = interaction.member?.user?.id || interaction.user?.id;
    const guildId = interaction.guild_id;

    if (name === 'currency') {
      const choiceOption = options?.find((opt) => opt.name === 'choice');
      const selectedCurrency = choiceOption?.value || 'USD';

      try {
        await docClient.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              PK: `USER#${userId}`,
              SK: 'CONFIG',
              preferred_currency: selectedCurrency,
              updated_at: new Date().toISOString(),
            },
          })
        );

        const sym = selectedCurrency === 'BRL' ? 'R$' : '$';
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: `Your preferred wishlist currency has been set to **${selectedCurrency} (${sym})**! Private deal notifications will be formatted accordingly.`,
            },
          }),
        };
      } catch (error) {
        console.error('Error updating user currency preference:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'Failed to update preferred currency. Please try again.',
            },
          }),
        };
      }
    }

    if (name === 'radar-status') {
      try {
        const scanResult = await docClient.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            Select: 'COUNT',
          })
        );

        let guildConfig = null;
        if (guildId) {
          const guildQueryResult = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'PK = :pk AND SK = :sk',
              ExpressionAttributeValues: {
                ':pk': `GUILD#${guildId}`,
                ':sk': 'CONFIG',
              },
            })
          );
          guildConfig = guildQueryResult.Items?.[0] || null;
        }

        const serverCurrency = guildConfig?.currency || 'USD';
        const serverStatusDesc = guildId
          ? guildConfig
            ? `Configured channel: <#${guildConfig.alert_channel_id}>\nCurrency: **${serverCurrency}** (${serverCurrency === 'BRL' ? 'R$' : '$'})\nFilter: Min Discount ${guildConfig.min_discount}% | Min Rating ${guildConfig.min_rating}/100\nFree Only: ${guildConfig.free_only ? 'Enabled' : 'Disabled'}`
            : 'No alert channel configured for this server yet. Use `/config-channel` to set one up!'
          : 'Direct Message session. Server-wide broadcast settings not applicable.';

        const statusEmbed = {
          title: 'zT Radar — Operational Status',
          description: 'Serverless Game Deal Intelligence Bot hosted on AWS.',
          color: 0x2ecc71,
          fields: [
            {
              name: 'System Engine',
              value: 'AWS Lambda (Node.js 20 ES Modules) • DynamoDB Single-Table',
              inline: false,
            },
            {
              name: 'Pricing Engine',
              value: 'Dual-Currency Engine: Default USD ($) with Official Steam BRL (R$) Regional Lookup.',
              inline: false,
            },
            {
              name: 'Database Records',
              value: `Tracking **${scanResult.Count || 0}** total items across active wishlists and configurations.`,
              inline: false,
            },
            {
              name: guildId ? 'Server Broadcast Status' : 'Session Context',
              value: serverStatusDesc,
              inline: false,
            },
          ],
          footer: {
            text: 'zT Radar Deal Intelligence • Production-Ready',
          },
          timestamp: new Date().toISOString(),
        };

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              embeds: [statusEmbed],
            },
          }),
        };
      } catch (statusError) {
        console.error('Error fetching radar status:', statusError);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'Failed to retrieve bot status. Please try again.',
            },
          }),
        };
      }
    }

    if (name === 'radar-help') {
      const helpEmbed = {
        title: 'zT Radar — Game Intelligence Manual',
        description: 'Serverless game price intelligence bot deployed on AWS.',
        color: 0x5865f2,
        fields: [
          {
            name: '/wishlist add <game> [target_price]',
            value: 'Monitor a game with live autocomplete. Optionally set a target price.',
            inline: false,
          },
          {
            name: '/currency <choice>',
            value: 'Set your preferred currency for private wishlist alerts: USD ($) or BRL (R$).',
            inline: false,
          },
          {
            name: '/wishlist remove <game>',
            value: 'Quickly remove a game directly from your saved list with contextual autocomplete.',
            inline: false,
          },
          {
            name: '/wishlist clear',
            value: 'Remove all games from your monitored wishlist at once.',
            inline: false,
          },
          {
            name: '/wishlist list',
            value: 'List all games currently tracked in your personal wishlist.',
            inline: false,
          },
          {
            name: '/config-channel <channel> [currency] [free_only] [min_discount] [min_rating]',
            value: 'Admin command to configure curated deal broadcasts (Supports USD or BRL currency).',
            inline: false,
          },
          {
            name: '/config-channel-remove',
            value: 'Admin command to disable community deal announcements on this server.',
            inline: false,
          },
          {
            name: '/radar-status',
            value: 'Check system health, database metrics, and active server configuration.',
            inline: false,
          },
        ],
        footer: {
          text: 'zT Radar • AWS Serverless Engine',
        },
      };

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: MESSAGE_FLAGS.EPHEMERAL,
            embeds: [helpEmbed],
          },
        }),
      };
    }

    if (name === 'config-channel') {
      if (!guildId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'This command can only be used inside a Discord server (guild).',
            },
          }),
        };
      }

      const channelOption = options?.find((opt) => opt.name === 'channel');
      const currencyOption = options?.find((opt) => opt.name === 'currency');
      const minDiscountOption = options?.find((opt) => opt.name === 'min_discount');
      const freeOnlyOption = options?.find((opt) => opt.name === 'free_only');
      const minRatingOption = options?.find((opt) => opt.name === 'min_rating');
      const thirdPartyOption = options?.find((opt) => opt.name === 'include_third_party');

      const channelId = channelOption?.value;
      const currency = currencyOption?.value || 'USD';
      const minDiscount = minDiscountOption ? Number(minDiscountOption.value) : 70;
      const freeOnly = freeOnlyOption ? Boolean(freeOnlyOption.value) : false;
      const minRating = minRatingOption ? Number(minRatingOption.value) : 80;
      const includeThirdParty = thirdPartyOption ? Boolean(thirdPartyOption.value) : false;

      if (!channelId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'Please select a valid text channel.',
            },
          }),
        };
      }

      try {
        await docClient.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              PK: `GUILD#${guildId}`,
              SK: 'CONFIG',
              guild_id: guildId,
              alert_channel_id: channelId,
              currency,
              min_discount: minDiscount,
              free_only: freeOnly,
              min_rating: minRating,
              include_third_party: includeThirdParty,
              last_broadcasted_deals: [],
              updated_by: userId,
              updated_at: new Date().toISOString(),
            },
          })
        );

        const storeScope = includeThirdParty ? 'All Authorized Stores' : 'Steam & Epic Games Store Only';
        const filterSummary = freeOnly
          ? `Filter: **100% Free Games Only** (${storeScope} | Currency: **${currency}**)`
          : `Filters: **>= ${minDiscount}% Off** | **Min Rating: ${minRating}/100** | Currency: **${currency}** | **${storeScope}**`;

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: `Server deals broadcast channel successfully configured to <#${channelId}>!\n${filterSummary}`,
            },
          }),
        };
      } catch (error) {
        console.error('Error saving guild channel config:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'Failed to configure alert channel. Please try again.',
            },
          }),
        };
      }
    }

    if (name === 'config-channel-remove') {
      if (!guildId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'This command can only be used inside a Discord server (guild).',
            },
          }),
        };
      }

      try {
        await docClient.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: `GUILD#${guildId}`,
              SK: 'CONFIG',
            },
          })
        );

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'Server deals broadcast channel has been removed and disabled.',
            },
          }),
        };
      } catch (error) {
        console.error('Error removing guild config:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              content: 'Failed to remove alert channel configuration. Please try again.',
            },
          }),
        };
      }
    }

    if (name === 'wishlist') {
      const subCommand = options?.[0];
      const subCommandName = subCommand?.name;

      if (subCommandName === 'clear') {
        try {
          const queryResult = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
              ExpressionAttributeValues: {
                ':pk': `USER#${userId}`,
                ':skPrefix': 'GAME#',
              },
            })
          );

          const items = queryResult.Items || [];
          if (items.length === 0) {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                  flags: MESSAGE_FLAGS.EPHEMERAL,
                  content: 'Your wishlist is already empty.',
                },
              }),
            };
          }

          for (const item of items) {
            await docClient.send(
              new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                  PK: item.PK,
                  SK: item.SK,
                },
              })
            );
          }

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: `Cleared **${items.length}** games from your monitored wishlist.`,
              },
            }),
          };
        } catch (error) {
          console.error('Error clearing wishlist:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: 'Failed to clear wishlist. Please try again.',
              },
            }),
          };
        }
      }

      if (subCommandName === 'add') {
        const gameOption = subCommand.options?.find((opt) => opt.name === 'game');
        const targetPriceOption = subCommand.options?.find((opt) => opt.name === 'target_price');

        const rawGameValue = gameOption?.value;
        const targetPrice = targetPriceOption ? parseFloat(targetPriceOption.value) : null;

        if (!rawGameValue || !rawGameValue.includes('|')) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: 'Please select a valid game from the autocomplete suggestion list.',
              },
            }),
          };
        }

        const [externalGameId, ...titleParts] = rawGameValue.split('|');
        const gameTitle = titleParts.join('|');
        const normalizedTitle = gameTitle.toLowerCase().trim();

        try {
          // Check if user has currency config, otherwise initialize default USD
          const userConfigResult = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'PK = :pk AND SK = :sk',
              ExpressionAttributeValues: {
                ':pk': `USER#${userId}`,
                ':sk': 'CONFIG',
              },
            })
          );

          let userCurrency = userConfigResult.Items?.[0]?.preferred_currency;
          let firstTimeNotice = '';

          if (!userCurrency) {
            userCurrency = 'USD';
            await docClient.send(
              new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                  PK: `USER#${userId}`,
                  SK: 'CONFIG',
                  preferred_currency: 'USD',
                  created_at: new Date().toISOString(),
                },
              })
            );
            firstTimeNotice = '\n*Tip: Currency set to **USD ($)** by default. Use `/currency` anytime to switch to **BRL (R$)**!*';
          }

          await docClient.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: {
                PK: `USER#${userId}`,
                SK: `GAME#${normalizedTitle}`,
                game_title: gameTitle,
                external_game_id: externalGameId,
                target_price: targetPrice,
                alert_all_time_low: true,
                alert_free: true,
                alert_steep_discount: true,
                user_id: userId,
                created_at: new Date().toISOString(),
              },
            })
          );

          const sym = userCurrency === 'BRL' ? 'R$' : '$';
          const priceInfo = targetPrice ? ` Target Price: ${sym} ${targetPrice.toFixed(2)}.` : '';

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: `Added **${gameTitle}** to your monitoring wishlist!${priceInfo}${firstTimeNotice}`,
              },
            }),
          };
        } catch (error) {
          console.error('Error saving wishlist item:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: 'Failed to add game to wishlist. Please try again.',
              },
            }),
          };
        }
      }

      if (subCommandName === 'remove') {
        const gameOption = subCommand.options?.find((opt) => opt.name === 'game');
        const rawGameValue = gameOption?.value;

        let gameTitle = rawGameValue;
        if (rawGameValue && rawGameValue.includes('|')) {
          const [, ...titleParts] = rawGameValue.split('|');
          gameTitle = titleParts.join('|');
        }

        const normalizedTitle = gameTitle.toLowerCase().trim();

        try {
          await docClient.send(
            new DeleteCommand({
              TableName: TABLE_NAME,
              Key: {
                PK: `USER#${userId}`,
                SK: `GAME#${normalizedTitle}`,
              },
            })
          );

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: `Removed **${gameTitle}** from your wishlist.`,
              },
            }),
          };
        } catch (error) {
          console.error('Error removing wishlist item:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: 'Failed to remove game from wishlist. Please try again.',
              },
            }),
          };
        }
      }

      if (subCommandName === 'list') {
        try {
          const [queryResult, userConfigResult] = await Promise.all([
            docClient.send(
              new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: {
                  ':pk': `USER#${userId}`,
                  ':skPrefix': 'GAME#',
                },
              })
            ),
            docClient.send(
              new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: 'PK = :pk AND SK = :sk',
                ExpressionAttributeValues: {
                  ':pk': `USER#${userId}`,
                  ':sk': 'CONFIG',
                },
              })
            ),
          ]);

          const items = queryResult.Items || [];
          if (items.length === 0) {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                  flags: MESSAGE_FLAGS.EPHEMERAL,
                  content: 'Your monitored wishlist is currently empty. Use `/wishlist add` to start tracking games!',
                },
              }),
            };
          }

          const userCurrency = userConfigResult.Items?.[0]?.preferred_currency || 'USD';
          const sym = userCurrency === 'BRL' ? 'R$' : '$';

          const formattedList = items
            .map((item, index) => {
              const target = item.target_price ? ` (Target: ${sym} ${Number(item.target_price).toFixed(2)})` : '';
              return `${index + 1}. **${item.game_title}**${target}`;
            })
            .join('\n');

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: `**Your Monitored Games (${items.length}) [Currency: ${userCurrency} (${sym})]:**\n\n${formattedList}`,
              },
            }),
          };
        } catch (error) {
          console.error('Error querying wishlist items:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                content: 'Failed to retrieve your wishlist. Please try again.',
              },
            }),
          };
        }
      }
    }
  }

  return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Unhandled interaction type' }),
  };
};