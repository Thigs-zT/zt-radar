import { verifyKey } from 'discord-interactions';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { searchGamesForAutocomplete, getGameDealInfo } from '../utils/itadApi.js';
import {
  checkPlatformStatuses,
  getSteamTrendingGames,
  getSteamMostPlayedGames,
} from '../utils/platformStatus.js';

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

const PALETTE = {
  BRAND: 0x5865F2,
  SUCCESS: 0x57F287,
  WARNING: 0xFEE75C,
  DANGER: 0xED4245,
  NEUTRAL: 0x2B2D31,
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

    if (name === 'compare' || name === 'wishlist') {
      const subCommand = options?.[0];
      const subCommandName = subCommand?.name;
      const focusedOption =
        name === 'compare'
          ? options?.find((opt) => opt.focused)
          : subCommand?.options?.find((opt) => opt.focused);

      if (focusedOption && focusedOption.name === 'game') {
        const query = focusedOption.value?.trim() || '';

        // Only search when the user actually begins typing (empty query returns empty choices)
        if (query.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
              data: { choices: [] },
            }),
          };
        }

        if (name === 'wishlist' && subCommandName === 'remove') {
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
              data: { choices: suggestions },
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

    // Command: /radar-status
    if (name === 'radar-status') {
      try {
        const scanResult = await docClient.send(
          new ScanCommand({
            TableName: TABLE_NAME,
          })
        );

        const allItems = scanResult.Items || [];
        const wishlistItems = allItems.filter((i) => i.SK?.startsWith('GAME#'));
        const guildConfig = guildId
          ? allItems.find((i) => i.PK === `GUILD#${guildId}` && i.SK === 'CONFIG')
          : null;

        const titleCounts = new Map();
        for (const item of wishlistItems) {
          const title = item.game_title || 'Unknown Title';
          titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
        }

        const sortedTitles = [...titleCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        let communityTelemetry = 'No titles monitored by the community yet.';
        if (sortedTitles.length > 0) {
          communityTelemetry = sortedTitles
            .map(([title, count], idx) => `▸ **#${idx + 1} ${title}** — \`${count}\` tracker${count > 1 ? 's' : ''}`)
            .join('\n');
        }

        const serverCurrency = guildConfig?.currency || 'USD';
        const thirdPartyStatus = guildConfig?.include_third_party ? 'Enabled (Nuuvem & GOG)' : 'Disabled (Steam & Epic Only)';
        const serverSummary = guildId
          ? guildConfig
            ? `▸ Channel: <#${guildConfig.alert_channel_id}>\n▸ Currency: **${serverCurrency}** (${serverCurrency === 'BRL' ? 'R$' : '$'})\n▸ Store Coverage: **${thirdPartyStatus}**\n▸ Thresholds: **≥ ${guildConfig.min_discount || 70}% off** | **≥ ${guildConfig.min_rating || 80}/100 score**\n▸ Mode: **${guildConfig.free_only ? 'Free Promotions Only' : 'Full Curated Radar'}**`
            : 'No alert channel active for this guild. Use `/config-channel` to configure.'
          : 'Direct Message session. Guild-level configurations do not apply.';

        const statusEmbed = {
          title: 'zT Radar ❖ System Telemetry & Community Intelligence',
          description: 'High-precision game deal tracking engine hosted on AWS Serverless infrastructure.',
          color: PALETTE.BRAND,
          fields: [
            {
              name: 'Compute & Runtime Architecture',
              value: '```yaml\nRuntime: Node.js 22.x LTS\nArchitecture: AWS Graviton (arm64)\nLatency: Sub-second (Cold: ~300ms)\n```',
              inline: false,
            },
            {
              name: 'Database & Registry Metrics',
              value: `▸ Total Database Items: **${allItems.length}**\n▸ Active User Wishlists: **${wishlistItems.length} titles** tracked`,
              inline: true,
            },
            {
              name: 'Guild Context',
              value: `▸ Target Guild: **${guildId || 'Direct Message'}**`,
              inline: true,
            },
            {
              name: 'Community Top 5 Most-Wished Titles (Anonymous)',
              value: communityTelemetry,
              inline: false,
            },
            {
              name: 'Guild Broadcast Scope',
              value: serverSummary,
              inline: false,
            },
          ],
          footer: {
            text: 'zT Radar • Operational & Production-Ready',
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

    // Command: /platform-status
    if (name === 'platform-status') {
      try {
        const statuses = await checkPlatformStatuses();

        const formatLine = (item) => {
          let indicator = '● ONLINE';
          if (item.status === 'DEGRADED') indicator = '▲ DEGRADED';
          if (item.status === 'OUTAGE' || item.status === 'OFFLINE') indicator = '✖ OFFLINE';
          return `▸ **${item.name}**\n  └─ Status: \`${indicator}\` • Latency: \`${item.latencyMs}ms\``;
        };

        const statusLines = Object.values(statuses).map(formatLine).join('\n\n');
        const hasOutage = Object.values(statuses).some((s) => s.status === 'OFFLINE' || s.status === 'OUTAGE');
        const hasDegraded = Object.values(statuses).some((s) => s.status === 'DEGRADED');

        let embedColor = PALETTE.SUCCESS;
        if (hasDegraded) embedColor = PALETTE.WARNING;
        if (hasOutage) embedColor = PALETTE.DANGER;

        const embed = {
          title: 'zT Radar ❖ Gaming Platforms Status Monitor',
          description: statusLines,
          color: embedColor,
          footer: {
            text: 'Live HTTP & Statuspage Probe • Refreshed on Demand',
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
              embeds: [embed],
            },
          }),
        };
      } catch (err) {
        console.error('Error checking platform statuses:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Monitor Error', 'Unable to probe platform statuses at this time.', PALETTE.DANGER)
          ),
        };
      }
    }

    // Command: /steam-most-played
    if (name === 'steam-most-played') {
      try {
        const mostPlayed = await getSteamMostPlayedGames();

        if (mostPlayed.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Charts Error', 'Could not retrieve Steam most played charts.', PALETTE.DANGER)
            ),
          };
        }

        const lines = mostPlayed.map((g) => {
          const playersFormatted = g.currentPlayers.toLocaleString('en-US');
          const peakText = g.peakToday ? ` • 24h Peak: \`${g.peakToday.toLocaleString('en-US')}\`` : '';
          return `❖ **#${g.rank} ${g.name}**\n  └─ **\`${playersFormatted}\`** active players now${peakText}`;
        });

        const embed = {
          title: 'zT Radar ❖ Steam Most Played Games (Top 10 Global)',
          description: `Live official Valve rankings by current online players:\n\n${lines.join('\n\n')}`,
          color: PALETTE.BRAND,
          footer: {
            text: 'Official Valve ISteamChartsService Telemetry • Matches SteamDB',
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
              embeds: [embed],
            },
          }),
        };
      } catch (err) {
        console.error('Error fetching steam most played:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Charts Error', 'Could not retrieve live Steam player rankings.', PALETTE.DANGER)
          ),
        };
      }
    }

    // Command: /steam-trending
    if (name === 'steam-trending') {
      try {
        const trending = await getSteamTrendingGames();

        if (trending.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Steam Telemetry', 'Unable to fetch current Steam charts. Please try again shortly.', PALETTE.WARNING)
            ),
          };
        }

        const lines = trending.map((game) => {
          const playersText = game.currentPlayers
            ? `\`${game.currentPlayers.toLocaleString('en-US')}\` players now`
            : 'Volume calculating...';

          return `❖ **#${game.rank} ${game.name}**\n  └─ ${playersText} • Store: **${game.priceText}**`;
        });

        const embed = {
          title: 'zT Radar ❖ Steam Trending & Surging (Top 10)',
          description: `Titles currently experiencing surging sales & demand on the Steam Store:\n\n${lines.join('\n\n')}`,
          color: PALETTE.BRAND,
          footer: {
            text: 'Steam Storefront Surge Charts • Dynamic Market Velocity',
          },
          timestamp: new Date().toISOString(),
        };

        if (trending[0]?.headerImage) {
          embed.thumbnail = { url: trending[0].headerImage };
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              embeds: [embed],
            },
          }),
        };
      } catch (err) {
        console.error('Error fetching steam trending:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Charts Error', 'Could not retrieve live Steam statistics.', PALETTE.DANGER)
          ),
        };
      }
    }

    // Command: /compare <game>
    if (name === 'compare') {
      const gameOption = options?.find((opt) => opt.name === 'game');
      const rawGameValue = gameOption?.value;

      if (!rawGameValue) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Selection Required',
              'Please type a game name and choose from the live suggestions dropdown.',
              PALETTE.WARNING
            )
          ),
        };
      }

      let externalGameId = rawGameValue;
      let gameTitle = rawGameValue;

      if (rawGameValue.includes('|')) {
        const [id, ...titleParts] = rawGameValue.split('|');
        externalGameId = id;
        gameTitle = titleParts.join('|');
      }

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

        const preferredCurrency = userConfigResult.Items?.[0]?.preferred_currency || 'USD';
        const dealInfo = await getGameDealInfo(externalGameId, preferredCurrency, gameTitle);

        if (!dealInfo || !dealInfo.primaryDeal) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Price Data Unavailable',
                `Could not retrieve active storefront prices for **${gameTitle}**. The title may not be cataloged or is currently unavailable on authorized PC stores.`,
                PALETTE.WARNING
              )
            ),
          };
        }

        const sym = dealInfo.primaryDeal.currencySymbol || (preferredCurrency === 'BRL' ? 'R$' : '$');
        const bestOffer = dealInfo.cheaperAlternative || dealInfo.primaryDeal;

        const diffBlock = [
          '```diff',
          `- Regular Price: ${sym} ${dealInfo.primaryDeal.regularPrice.toFixed(2)}`,
          `+ Current Best:  ${sym} ${bestOffer.salePrice.toFixed(2)} (-${bestOffer.cutPercent}%) at ${bestOffer.shopName}`,
          '```',
        ].join('\n');

        const fields = [
          {
            name: 'Price Overview',
            value: diffBlock,
            inline: false,
          },
        ];

        if (dealInfo.storeBreakdown && Object.keys(dealInfo.storeBreakdown).length > 0) {
          const breakdownList = Object.values(dealInfo.storeBreakdown).map((s) => {
            const cutTxt = s.cutPercent > 0 ? ` (-${s.cutPercent}%)` : '';
            return `▸ **${s.shopName}**: ${sym} ${s.salePrice.toFixed(2)}${cutTxt}`;
          });

          fields.push({
            name: 'Storefront Availability',
            value: breakdownList.join('\n'),
            inline: false,
          });
        }

        if (dealInfo.allTimeLowPrice !== null) {
          const diffFromAtl = bestOffer.salePrice - dealInfo.allTimeLowPrice;
          let atlStatus = '';

          if (dealInfo.isAllTimeLow || diffFromAtl <= 0.05) {
            atlStatus = `🔥 **${sym} ${dealInfo.allTimeLowPrice.toFixed(2)}**\n└─ **MATCHES LOWEST PRICE EVER!**`;
          } else {
            atlStatus = `📊 **${sym} ${dealInfo.allTimeLowPrice.toFixed(2)}**\n└─ Current price is ${sym} ${diffFromAtl.toFixed(2)} above record low.`;
          }

          fields.push({
            name: 'Historical Low (ATL)',
            value: atlStatus,
            inline: true,
          });
        }

        if (dealInfo.reviewScore) {
          fields.push({
            name: 'Community Approval',
            value: `▸ **${dealInfo.reviewScore}/100** score`,
            inline: true,
          });
        }

        // Strictly nominal buttons with our 4 approved stores
        const buttons = [];
        if (bestOffer.url) {
          buttons.push({
            type: 2,
            style: 5,
            label: `Buy on ${bestOffer.shopName}`,
            url: bestOffer.url,
          });
        }

        if (dealInfo.primaryDeal.url && dealInfo.primaryDeal.url !== bestOffer.url) {
          buttons.push({
            type: 2,
            style: 5,
            label: `Buy on ${dealInfo.primaryDeal.shopName}`,
            url: dealInfo.primaryDeal.url,
          });
        }

        if (dealInfo.steamAppId) {
          buttons.push({
            type: 2,
            style: 5,
            label: 'SteamDB',
            url: `https://steamdb.info/app/${dealInfo.steamAppId}/`,
          });
        }

        const components = buttons.length > 0 ? [{ type: 1, components: buttons.slice(0, 5) }] : [];

        const embed = {
          title: `zT Radar ❖ Price Comparison: ${dealInfo.title}`,
          description: `Live price comparison in **${preferredCurrency} (${sym})**.`,
          color: dealInfo.isAllTimeLow ? PALETTE.SUCCESS : PALETTE.BRAND,
          fields,
          footer: {
            text: `Currency: ${preferredCurrency} • Authorized: Steam, Epic, Nuuvem, GOG`,
          },
          timestamp: new Date().toISOString(),
        };

        if (dealInfo.imageUrl) {
          embed.image = { url: dealInfo.imageUrl };
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: MESSAGE_FLAGS.EPHEMERAL,
              embeds: [embed],
              components,
            },
          }),
        };
      } catch (compareError) {
        console.error('Error executing /compare command:', compareError);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Comparison Error', 'An unexpected error occurred while analyzing prices.', PALETTE.DANGER)
          ),
        };
      }
    }

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
              `Your private notification currency is now set to **${selectedCurrency} (${sym})**.\nAll direct wishlist alerts and comparisons will prioritize this regional format.`,
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

    if (name === 'radar-help') {
      const helpEmbed = {
        title: 'zT Radar ❖ Command Directory',
        description: 'Comprehensive guide to monitoring sales, setting price ceilings, and server deal broadcasting.',
        color: PALETTE.BRAND,
        fields: [
          {
            name: 'Instant Market Intelligence',
            value: [
              '▸ `/compare <game>`',
              '  └─ Real-time price check comparing Steam, Epic, Nuuvem and GOG with historical low.',
              '▸ `/steam-most-played`',
              '  └─ Official live top 10 most-played games on Steam by concurrent players.',
              '▸ `/steam-trending`',
              '  └─ Display live top 10 surging games on the Steam Storefront.',
              '▸ `/platform-status`',
              '  └─ Real-time operational availability and latency across Steam, Epic, PSN, and Xbox.',
            ].join('\n'),
            inline: false,
          },
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
              '▸ `/config-channel <channel> [currency] [include_third_party] [free_only]`',
              '  └─ Route curated deals into a designated server channel.',
              '▸ `/config-channel-experimental [min_discount] [min_rating]`',
              '  └─ [Admin] Override default heuristic discount/score thresholds.',
              '▸ `/config-channel-remove`',
              '  └─ Deactivate automatic broadcasts for this server.',
              '▸ `/radar-status`',
              '  └─ Inquire system metrics, community wishlist top 5, and guild parameters.',
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
      const thirdPartyOption = options?.find((opt) => opt.name === 'include_third_party');
      const freeOnlyOption = options?.find((opt) => opt.name === 'free_only');

      const channelId = channelOption?.value;
      const currency = currencyOption?.value || 'USD';
      const includeThirdParty = thirdPartyOption ? Boolean(thirdPartyOption.value) : false;
      const freeOnly = freeOnlyOption ? Boolean(freeOnlyOption.value) : false;

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
        const existingConfig = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk AND SK = :sk',
            ExpressionAttributeValues: {
              ':pk': `GUILD#${guildId}`,
              ':sk': 'CONFIG',
            },
          })
        );

        const current = existingConfig.Items?.[0] || {};
        const minDiscount = current.min_discount || 70;
        const minRating = current.min_rating || 80;

        await docClient.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              PK: `GUILD#${guildId}`,
              SK: 'CONFIG',
              guild_id: guildId,
              alert_channel_id: channelId,
              currency,
              include_third_party: includeThirdParty,
              free_only: freeOnly,
              min_discount: minDiscount,
              min_rating: minRating,
              last_broadcasted_deals: current.last_broadcasted_deals || [],
              updated_by: userId,
              updated_at: new Date().toISOString(),
            },
          })
        );

        const storeScope = includeThirdParty ? 'Steam, Epic, Nuuvem & GOG' : 'Steam & Epic Games Store';
        const fields = [
          { name: 'Target Channel', value: `<#${channelId}>`, inline: true },
          { name: 'Currency', value: `**${currency}** (${currency === 'BRL' ? 'R$' : '$'})`, inline: true },
          { name: 'Store Coverage', value: storeScope, inline: true },
          {
            name: 'Broadcast Mode',
            value: freeOnly
              ? '▸ **100% Free Giveaways Only**'
              : `▸ Standard Quality Radar (≥ ${minDiscount}% off | Score ≥ ${minRating}/100)`,
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
            createEphemeralEmbed('Configuration Error', 'Failed to register alert channel. Please try again.', PALETTE.DANGER)
          ),
        };
      }
    }

    if (name === 'config-channel-experimental') {
      if (!guildId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Scope Restriction', 'This command can only be executed within a Discord server.', PALETTE.WARNING)
          ),
        };
      }

      const minDiscountOption = options?.find((opt) => opt.name === 'min_discount');
      const minRatingOption = options?.find((opt) => opt.name === 'min_rating');

      if (!minDiscountOption && !minRatingOption) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Parameters Required',
              'Please provide at least one threshold parameter (`min_discount` or `min_rating`) to override.',
              PALETTE.WARNING
            )
          ),
        };
      }

      try {
        const existingConfig = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk AND SK = :sk',
            ExpressionAttributeValues: {
              ':pk': `GUILD#${guildId}`,
              ':sk': 'CONFIG',
            },
          })
        );

        if (!existingConfig.Items || existingConfig.Items.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Setup Required First',
                'No alert channel has been configured for this server yet. Run `/config-channel` first before applying overrides.',
                PALETTE.WARNING
              )
            ),
          };
        }

        const newDiscount = minDiscountOption ? Number(minDiscountOption.value) : existingConfig.Items[0].min_discount || 70;
        const newRating = minRatingOption ? Number(minRatingOption.value) : existingConfig.Items[0].min_rating || 80;

        await docClient.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: `GUILD#${guildId}`,
              SK: 'CONFIG',
            },
            UpdateExpression: 'SET min_discount = :disc, min_rating = :rat, updated_at = :now',
            ExpressionAttributeValues: {
              ':disc': newDiscount,
              ':rat': newRating,
              ':now': new Date().toISOString(),
            },
          })
        );

        const fields = [
          { name: 'Custom Min Discount', value: `**≥ ${newDiscount}%**`, inline: true },
          { name: 'Custom Min Rating', value: `**≥ ${newRating}/100**`, inline: true },
        ];

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Experimental Thresholds Applied',
              'Standard quality heuristics have been overridden for this server. Deal frequency may vary significantly based on these settings.',
              PALETTE.WARNING,
              fields
            )
          ),
        };
      } catch (error) {
        console.error('Error applying experimental guild config:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Update Failed', 'Could not apply experimental thresholds. Please try again.', PALETTE.DANGER)
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

        if (!rawGameValue) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Selection Required',
                'Please select a game directly from the live suggestions dropdown.',
                PALETTE.WARNING
              )
            ),
          };
        }

        let externalGameId = rawGameValue;
        let gameTitle = rawGameValue;

        if (rawGameValue.includes('|')) {
          const [id, ...titleParts] = rawGameValue.split('|');
          externalGameId = id;
          gameTitle = titleParts.join('|');
        }

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
            .sort((a, b) => a.game_title.localeCompare(b.game_title))
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