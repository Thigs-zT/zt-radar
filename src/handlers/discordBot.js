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

// 24-bit Decimal Color Codes (Hex equivalent)
const PALETTE = {
  BRAND: 0x5865F2,   // Blurple
  SUCCESS: 0x57F287, // Emerald
  WARNING: 0xFEE75C, // Amber
  DANGER: 0xED4245,  // Crimson
  NEUTRAL: 0x2B2D31, // Slate Dark
};

function createEphemeralEmbed(title, description, color = PALETTE.BRAND, fields = []) {
  return {
    type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: MESSAGE_FLAGS.EPHEMERAL,
      embeds: [
        {
          title,
          description,
          color,
          fields,
          footer: {
            text: 'zT Radar • Deal Intelligence Engine',
          },
          timestamp: new Date().toISOString(),
        },
      ],
    },
  };
}

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
          body: JSON.stringify(
            createEphemeralEmbed(
              'Preferred Currency Updated',
              `Your private notification currency is now set to **${selectedCurrency} (${sym})**.\nAll direct wishlist alerts will prioritize this regional format.`,
              PALETTE.SUCCESS
            )
          ),
        };
      } catch (error) {
        console.error('Error updating user currency preference:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Operation Failed', 'Unable to update currency settings. Please try again.', PALETTE.DANGER)
          ),
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
        const serverSummary = guildId
          ? guildConfig
            ? `▸ Channel: <#${guildConfig.alert_channel_id}>\n▸ Currency: **${serverCurrency}** (${serverCurrency === 'BRL' ? 'R$' : '$'})\n▸ Thresholds: **≥ ${guildConfig.min_discount}% off** | **≥ ${guildConfig.min_rating}/100 score**\n▸ Mode: **${guildConfig.free_only ? 'Free Promotions Only' : 'Full Curated Radar'}**`
            : 'No alert channel active for this guild. Use `/config-channel` to configure.'
          : 'Direct Message session. Guild-level configurations do not apply.';

        const statusEmbed = {
          title: 'zT Radar ❖ System Telemetry',
          description: 'High-precision game deal tracking engine hosted on AWS Serverless infrastructure.',
          color: PALETTE.BRAND,
          fields: [
            {
              name: 'Compute & Runtime',
              value: '```yaml\nRuntime: Node.js 22.x LTS\nArchitecture: AWS Graviton (arm64)\nLatency: Sub-second (Cold: ~300ms)\n```',
              inline: false,
            },
            {
              name: 'Storage & Pricing Engines',
              value: '```yaml\nDatabase: Amazon DynamoDB (Single-Table)\nRegional Lookup: IsThereAnyDeal (BRL) & CheapShark (USD)\nCurated Barrier: Metacritic/Steam Quality Filter Active\n```',
              inline: false,
            },
            {
              name: 'Telemetric Data',
              value: `▸ Active Database Records: **${scanResult.Count || 0}**\n▸ Target Guild Context: **${guildId || 'Direct Message'}**`,
              inline: false,
            },
            {
              name: 'Guild Broadcast Scope',
              value: serverSummary,
              inline: false,
            },
          ],
          footer: {
            text: 'zT Radar • Operational & Healthy',
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
          body: JSON.stringify(
            createEphemeralEmbed('Telemetry Error', 'Could not query runtime telemetry metrics.', PALETTE.DANGER)
          ),
        };
      }
    }

    if (name === 'radar-help') {
      const helpEmbed = {
        title: 'zT Radar ❖ Command Directory',
        description: 'Comprehensive guide to monitoring sales, setting price ceilings, and server deal broadcasting.',
        color: PALETTE.BRAND,
        fields: [
          {
            name: 'Personal Wishlist Management',
            value: [
              '▸ `/wishlist add <game> [target_price]`',
              '  └─ Register a game to monitor. Live search suggestions included.',
              '▸ `/wishlist remove <game>`',
              '  └─ Delete a game directly from your personal tracked list.',
              '▸ `/wishlist list`',
              '  └─ Display all tracked games with targets and currency settings.',
              '▸ `/wishlist clear`',
              '  └─ Wipe your entire personal monitoring list at once.',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Currency & Preferences',
            value: [
              '▸ `/currency <choice>`',
              '  └─ Set alert formatting between **USD ($)** and **BRL (R$)**.',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Server Broadcast Administration',
            value: [
              '▸ `/config-channel <channel> [currency] [free_only] [min_discount] [min_rating]`',
              '  └─ Route curated deals into a designated server channel.',
              '▸ `/config-channel-remove`',
              '  └─ Deactivate automatic broadcasts for this server.',
              '▸ `/radar-status`',
              '  └─ Inquire system metrics, engine version, and active guild parameters.',
            ].join('\n'),
            inline: false,
          },
        ],
        footer: {
          text: 'zT Radar • Production Architecture',
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
          body: JSON.stringify(
            createEphemeralEmbed('Scope Restriction', 'This command can only be executed within a Discord server.', PALETTE.WARNING)
          ),
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
          body: JSON.stringify(
            createEphemeralEmbed('Missing Parameter', 'Please designate a valid text channel for announcements.', PALETTE.WARNING)
          ),
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

        const storeScope = includeThirdParty ? 'All Authorized Stores' : 'Steam & Epic Games Store';
        const fields = [
          { name: 'Target Channel', value: `<#${channelId}>`, inline: true },
          { name: 'Currency', value: `**${currency}** (${currency === 'BRL' ? 'R$' : '$'})`, inline: true },
          { name: 'Store Coverage', value: storeScope, inline: true },
          {
            name: 'Filtering Criteria',
            value: freeOnly
              ? '▸ Mode: **100% Free Games Only**'
              : `▸ Minimum Discount: **≥ ${minDiscount}%**\n▸ Minimum Review Rating: **≥ ${minRating}/100**`,
            inline: false,
          },
        ];

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Broadcast Channel Configured',
              'Curated deals scanning is now active for this server.',
              PALETTE.SUCCESS,
              fields
            )
          ),
        };
      } catch (error) {
        console.error('Error saving guild channel config:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Configuration Error', 'Failed to register the alert channel. Please try again.', PALETTE.DANGER)
          ),
        };
      }
    }

    if (name === 'config-channel-remove') {
      if (!guildId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Scope Restriction', 'This command can only be executed within a Discord server.', PALETTE.WARNING)
          ),
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
          body: JSON.stringify(
            createEphemeralEmbed(
              'Broadcast Channel Deactivated',
              'Automated deals publication has been disabled for this server.',
              PALETTE.WARNING
            )
          ),
        };
      } catch (error) {
        console.error('Error removing guild config:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Removal Error', 'Failed to remove server configuration.', PALETTE.DANGER)
          ),
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
              body: JSON.stringify(
                createEphemeralEmbed('Wishlist Empty', 'Your tracking list contains no items to clear.', PALETTE.NEUTRAL)
              ),
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
            body: JSON.stringify(
              createEphemeralEmbed(
                'Wishlist Cleared',
                `Successfully removed **${items.length}** titles from your personal tracking registry.`,
                PALETTE.WARNING
              )
            ),
          };
        } catch (error) {
          console.error('Error clearing wishlist:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Registry Error', 'Unable to clear your wishlist entries.', PALETTE.DANGER)
            ),
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
            body: JSON.stringify(
              createEphemeralEmbed(
                'Selection Required',
                'Please select a game directly from the live autocomplete suggestions dropdown.',
                PALETTE.WARNING
              )
            ),
          };
        }

        const [externalGameId, ...titleParts] = rawGameValue.split('|');
        const gameTitle = titleParts.join('|');
        const normalizedTitle = gameTitle.toLowerCase().trim();

        try {
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
            firstTimeNotice = '\n*Currency set to **USD ($)** by default. Run `/currency` anytime to switch to **BRL (R$)**.*';
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
          const fields = [
            { name: 'Monitored Title', value: `**${gameTitle}**`, inline: true },
            {
              name: 'Price Ceiling',
              value: targetPrice ? `**${sym} ${targetPrice.toFixed(2)}**` : 'Any major promotion',
              inline: true,
            },
          ];

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Title Added to Radar',
                `You will receive private alerts whenever this game meets your pricing conditions.${firstTimeNotice}`,
                PALETTE.SUCCESS,
                fields
              )
            ),
          };
        } catch (error) {
          console.error('Error saving wishlist item:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Storage Error', 'Could not persist title to your tracking registry.', PALETTE.DANGER)
            ),
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
            body: JSON.stringify(
              createEphemeralEmbed(
                'Title Removed',
                `**${gameTitle}** has been removed from your radar wishlist.`,
                PALETTE.WARNING
              )
            ),
          };
        } catch (error) {
          console.error('Error removing wishlist item:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Removal Error', 'Failed to remove game from registry.', PALETTE.DANGER)
            ),
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
              body: JSON.stringify(
                createEphemeralEmbed(
                  'Wishlist Empty',
                  'You have no monitored titles. Use `/wishlist add` to initiate tracking.',
                  PALETTE.NEUTRAL
                )
              ),
            };
          }

          const userCurrency = userConfigResult.Items?.[0]?.preferred_currency || 'USD';
          const sym = userCurrency === 'BRL' ? 'R$' : '$';

          const formattedList = items
            .map((item, index) => {
              const target = item.target_price
                ? `\n  └─ Target Price: **${sym} ${Number(item.target_price).toFixed(2)}**`
                : '\n  └─ Target Price: **Any promotional drop**';
              return `❖ **${item.game_title}**${target}`;
            })
            .join('\n\n');

          const listEmbed = {
            title: `Personal Radar Registry ❖ ${items.length} Active`,
            description: formattedList,
            color: PALETTE.BRAND,
            footer: {
              text: `Display Currency: ${userCurrency} (${sym}) • Use /currency to toggle`,
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
                embeds: [listEmbed],
              },
            }),
          };
        } catch (error) {
          console.error('Error querying wishlist items:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Query Error', 'Unable to retrieve your monitored titles.', PALETTE.DANGER)
            ),
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