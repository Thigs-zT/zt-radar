import { verifyKey } from 'discord-interactions';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { searchGamesForAutocomplete, getGameDealInfo } from '../utils/itadApi.js';
import {
  checkPlatformStatuses,
  getSteamTrendingGames,
  getSteamMostPlayedGames,
} from '../utils/platformStatus.js';
import { fetchGameNews, fetchSystemRequirements } from '../utils/steamIntel.js';
import {
  resolveSteamId,
  getPlayerSummary,
  getCompletePlayerProfile,
  fetchSteamWishlist,
  resolveSteamAppTitles,
} from '../utils/steamWeb.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const STEAM_API_KEY = process.env.STEAM_API_KEY;

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
  STEAM: 0x1B2838,
  STEAM_ACCENT: 0x66C0F4,
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

    const autocompleteCommands = ['compare', 'can-it-run', 'game-news', 'wishlist'];

    if (autocompleteCommands.includes(name)) {
      const subCommand = options?.[0];
      const subCommandName = subCommand?.name;
      const focusedOption =
        name === 'wishlist'
          ? subCommand?.options?.find((opt) => opt.focused)
          : options?.find((opt) => opt.focused);

      if (focusedOption && focusedOption.name === 'game') {
        const query = focusedOption.value?.trim() || '';

        // Strict: only show choices when user starts typing
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

    // Command: /can-it-run <game>
    if (name === 'can-it-run') {
      const gameOption = options?.find((opt) => opt.name === 'game');
      const rawVal = gameOption?.value;

      if (!rawVal) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Selection Required', 'Please type and select a game from the autocomplete suggestions dropdown.', PALETTE.WARNING)
          ),
        };
      }

      let steamAppId = null;
      let gameTitle = rawVal;

      if (rawVal.includes('|')) {
        const [idPart, ...titleParts] = rawVal.split('|');
        gameTitle = titleParts.join('|');
        if (idPart.startsWith('steam:')) {
          steamAppId = idPart.replace('steam:', '').trim();
        } else if (/^\d+$/.test(idPart)) {
          steamAppId = idPart;
        }
      }

      if (!steamAppId) {
        const deal = await getGameDealInfo(rawVal, 'USD', gameTitle);
        steamAppId = deal?.steamAppId || null;
      }

      if (!steamAppId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Hardware Specs Unavailable',
              `Could not identify the official Steam catalog entry for **${gameTitle}**. Specifications are only available for indexed Steam PC releases.`,
              PALETTE.WARNING
            )
          ),
        };
      }

      try {
        const specs = await fetchSystemRequirements(steamAppId);

        if (!specs) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Specs Error', `Unable to query official hardware requirements for **${gameTitle}**.`, PALETTE.DANGER)
            ),
          };
        }

        const fields = [
          {
            name: 'Minimum Specifications',
            value: `\`\`\`yaml\n${specs.minimum}\n\`\`\``,
            inline: false,
          },
          {
            name: 'Recommended Specifications',
            value: `\`\`\`yaml\n${specs.recommended}\n\`\`\``,
            inline: false,
          },
        ];

        const embed = {
          title: `zT Radar ❖ Hardware Benchmarks: ${specs.title}`,
          description: 'Official developer-specified PC system requirements from Steam.',
          color: PALETTE.BRAND,
          fields,
          footer: {
            text: 'zT Radar • Steam Store Hardware Database',
          },
          timestamp: new Date().toISOString(),
        };

        if (specs.headerImage) {
          embed.thumbnail = { url: specs.headerImage };
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
      } catch (specErr) {
        console.error('Error fetching hardware specs:', specErr);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Query Error', 'An unexpected error occurred while querying system requirements.', PALETTE.DANGER)
          ),
        };
      }
    }

    // Command: /game-news <game>
    if (name === 'game-news') {
      const gameOption = options?.find((opt) => opt.name === 'game');
      const rawVal = gameOption?.value;

      if (!rawVal) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Selection Required', 'Please type and select a game from the autocomplete suggestions dropdown.', PALETTE.WARNING)
          ),
        };
      }

      let steamAppId = null;
      let gameTitle = rawVal;

      if (rawVal.includes('|')) {
        const [idPart, ...titleParts] = rawVal.split('|');
        gameTitle = titleParts.join('|');
        if (idPart.startsWith('steam:')) {
          steamAppId = idPart.replace('steam:', '').trim();
        } else if (/^\d+$/.test(idPart)) {
          steamAppId = idPart;
        }
      }

      if (!steamAppId) {
        const deal = await getGameDealInfo(rawVal, 'USD', gameTitle);
        steamAppId = deal?.steamAppId || null;
      }

      if (!steamAppId) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Official News Unavailable',
              `Could not identify the official Steam catalog entry for **${gameTitle}**. News broadcasts are only accessible for indexed Steam releases.`,
              PALETTE.WARNING
            )
          ),
        };
      }

      try {
        const newsList = await fetchGameNews(steamAppId);

        if (newsList.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('News Dispatches', `No recent official announcements found for **${gameTitle}**.`, PALETTE.NEUTRAL)
            ),
          };
        }

        const fields = newsList.map((n) => ({
          name: `❖ ${n.title} (${n.date})`,
          value: `${n.snippet}\n[Read Full Announcement on Steam](${n.url})`,
          inline: false,
        }));

        const embed = {
          title: `zT Radar ❖ Patch Notes & News: ${gameTitle}`,
          description: 'Latest official developer dispatches published on Valve Steam Community.',
          color: PALETTE.BRAND,
          fields,
          footer: {
            text: 'Valve ISteamNews Web API • Verified Developer Announcements',
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
      } catch (newsErr) {
        console.error('Error fetching game news:', newsErr);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Dispatch Error', 'Failed to retrieve official patch notes and news.', PALETTE.DANGER)
          ),
        };
      }
    }

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
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: `USER#${userId}`,
              SK: 'CONFIG',
            },
            UpdateExpression: 'SET preferred_currency = :curr, updated_at = :now',
            ExpressionAttributeValues: {
              ':curr': selectedCurrency,
              ':now': new Date().toISOString(),
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
        description: 'Comprehensive guide to monitoring sales, setting price ceilings, and game intelligence.',
        color: PALETTE.BRAND,
        fields: [
          {
            name: 'Game Intelligence & Hardware Suite',
            value: [
              '▸ `/compare <game>`',
              '  └─ Real-time price check comparing Steam, Epic, Nuuvem and GOG with historical low.',
              '▸ `/can-it-run <game>`',
              '  └─ Official minimum & recommended PC system specifications from Steam.',
              '▸ `/game-news <game>`',
              '  └─ Official developer dispatches, patch notes, and news updates.',
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
              '▸ `/wishlist sync-steam [target]`',
              '  └─ Bulk-import your public Steam wishlist into zT Radar tracking.',
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
            name: 'Steam Intelligence & Account Linking',
            value: [
              '▸ `/steam-link <target>`',
              '  └─ Link your Steam profile (by SteamID64, profile link, or custom vanity URL).',
              '▸ `/steam-profile [user] [target]`',
              '  └─ Comprehensive profile intelligence, VAC/ban records, and library statistics.',
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

    // Command: /steam-link <target>
    if (name === 'steam-link') {
      const targetOption = options?.find((opt) => opt.name === 'target');
      const rawTarget = targetOption?.value?.trim();

      if (!STEAM_API_KEY) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Steam Integration Offline',
              'The Valve Steam Web API Key is not configured on this instance. Please contact the bot administrator.',
              PALETTE.WARNING
            )
          ),
        };
      }

      if (!rawTarget) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Input Required',
              'Please provide your SteamID64, full profile URL, or custom vanity URL.',
              PALETTE.WARNING
            )
          ),
        };
      }

      try {
        const steamId = await resolveSteamId(rawTarget, STEAM_API_KEY);

        if (!steamId) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Steam Resolution Failed',
                `Could not resolve Steam profile for: \`${rawTarget}\`.\n\nPlease verify your input:\n▸ 17-digit numeric **SteamID64** (e.g. \`76561198000000000\`)\n▸ Profile URL (\`https://steamcommunity.com/profiles/...\` or \`/id/...\`)\n▸ Custom vanity URL or alias`,
                PALETTE.WARNING
              )
            ),
          };
        }

        const summary = await getPlayerSummary(steamId, STEAM_API_KEY);
        if (!summary) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Steam Profile Inaccessible',
                `Resolved SteamID64 \`${steamId}\`, but could not retrieve profile data from Steam. The profile may be non-existent or temporarily inaccessible.`,
                PALETTE.WARNING
              )
            ),
          };
        }

        await docClient.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: `USER#${userId}`,
              SK: 'CONFIG',
            },
            UpdateExpression: 'SET steam_id = :sid, steam_persona_name = :sname, steam_avatar_url = :savatar, updated_at = :now',
            ExpressionAttributeValues: {
              ':sid': steamId,
              ':sname': summary.personaName,
              ':savatar': summary.avatarUrl || '',
              ':now': new Date().toISOString(),
            },
          })
        );

        const linkEmbed = {
          title: 'Steam Account Linked ❖ Verification Successful',
          description: `Successfully linked your Discord account to Steam profile **${summary.personaName}**.`,
          color: PALETTE.SUCCESS,
          thumbnail: summary.avatarUrl ? { url: summary.avatarUrl } : undefined,
          fields: [
            {
              name: 'Profile Identity',
              value: [
                `▸ Persona: **${summary.personaName}**`,
                `▸ SteamID64: \`${steamId}\``,
                `▸ Status: **${summary.personaStateLabel}**${summary.currentlyPlaying ? ` (Playing: *${summary.currentlyPlaying}*)` : ''}`,
                `▸ Profile Link: [View on Steam](${summary.profileUrl})`,
              ].join('\n'),
              inline: false,
            },
          ],
          footer: {
            text: 'zT Radar • Steam Ecosystem Intelligence',
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
              embeds: [linkEmbed],
            },
          }),
        };
      } catch (error) {
        console.error('Error linking Steam account:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Operation Failed', 'Unable to link Steam profile. Please try again.', PALETTE.DANGER)
          ),
        };
      }
    }

    // Command: /steam-profile [user] [target]
    if (name === 'steam-profile') {
      const userOption = options?.find((opt) => opt.name === 'user');
      const targetOption = options?.find((opt) => opt.name === 'target');

      if (!STEAM_API_KEY) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Steam Integration Offline',
              'The Valve Steam Web API Key is not configured on this instance. Please contact the bot administrator.',
              PALETTE.WARNING
            )
          ),
        };
      }

      let targetSteamIdentifier = null;
      let targetDiscordUserId = null;

      if (targetOption?.value) {
        targetSteamIdentifier = targetOption.value.trim();
      } else if (userOption?.value) {
        targetDiscordUserId = userOption.value;
      } else {
        targetDiscordUserId = userId;
      }

      try {
        if (targetDiscordUserId) {
          const userConfigResult = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'PK = :pk AND SK = :sk',
              ExpressionAttributeValues: {
                ':pk': `USER#${targetDiscordUserId}`,
                ':sk': 'CONFIG',
              },
            })
          );

          const linkedSteamId = userConfigResult.Items?.[0]?.steam_id;

          if (!linkedSteamId) {
            const isSelf = targetDiscordUserId === userId;
            const msg = isSelf
              ? 'You have not linked your Steam account yet.\n\nUse `/steam-link <target>` to link your profile, or supply a target directly via `/steam-profile target:<id/url>`.'
              : `<@${targetDiscordUserId}> has not linked their Steam account to zT Radar yet.`;

            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                createEphemeralEmbed('Steam Account Not Linked', msg, PALETTE.NEUTRAL)
              ),
            };
          }

          targetSteamIdentifier = linkedSteamId;
        }

        const profileData = await getCompletePlayerProfile(targetSteamIdentifier, STEAM_API_KEY);

        if (!profileData.success) {
          if (profileData.error === 'RESOLVE_FAILED') {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                createEphemeralEmbed(
                  'Steam Resolution Failed',
                  `Could not resolve Steam profile for: \`${targetSteamIdentifier}\`.\n\nPlease verify your input:\n▸ 17-digit numeric **SteamID64**\n▸ Profile URL (\`https://steamcommunity.com/id/...\`)\n▸ Custom vanity URL or alias`,
                  PALETTE.WARNING
                )
              ),
            };
          }

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Steam Profile Not Found',
                `Unable to retrieve Steam data for \`${targetSteamIdentifier}\`. Profile may be non-existent or inaccessible.`,
                PALETTE.WARNING
              )
            ),
          };
        }

        const { summary, bans, games, steamId } = profileData;

        // Build Fields
        const statusDetails = summary.currentlyPlaying
          ? `${summary.personaStateLabel}\n  └─ Playing: **${summary.currentlyPlaying}**`
          : summary.personaStateLabel;

        const profileFields = [
          {
            name: 'Profile Identity & Status',
            value: [
              `▸ Persona: **${summary.personaName}**`,
              `▸ Status: **${statusDetails}**`,
              `▸ SteamID64: \`${steamId}\``,
              `▸ Created: **${summary.timeCreated || 'Private'}**`,
              `▸ Country: **${summary.countryCode ? summary.countryCode.toUpperCase() : 'Undisclosed'}**`,
            ].join('\n'),
            inline: false,
          },
        ];

        // Bans & Security Record
        if (bans) {
          const vacStatus = bans.vacBanned
            ? `Banned (${bans.vacBansCount} VAC bans recorded)`
            : 'In Good Standing';
          const communityStatus = bans.communityBanned ? 'Banned' : 'In Good Standing';
          const gameBansStatus = bans.gameBansCount > 0 ? `${bans.gameBansCount} Recorded` : 'None';
          const economyStatus = bans.economyBan === 'none' ? 'Normal' : bans.economyBan;

          profileFields.push({
            name: 'Security & Platform Standing',
            value: [
              `▸ VAC Ban Status: **${vacStatus}**`,
              `▸ Community Standing: **${communityStatus}**`,
              `▸ Game Bans: **${gameBansStatus}**`,
              `▸ Economy Standing: **${economyStatus}**`,
            ].join('\n'),
            inline: false,
          });
        }

        // Library & Playtime Metrics
        if (games) {
          if (games.isPrivate) {
            profileFields.push({
              name: 'Library & Playtime Metrics',
              value: '▸ Library Details: **Private**\n  └─ Game inventory and playtimes are hidden by user privacy settings.',
              inline: false,
            });
          } else {
            const gamesLines = [
              `▸ Total Games Owned: **${games.gameCount}**`,
              `▸ Total Playtime Recorded: **${games.totalPlaytimeHours} hrs**`,
            ];

            if (games.topGames && games.topGames.length > 0) {
              gamesLines.push('▸ Most Played Titles:');
              games.topGames.forEach((g) => {
                gamesLines.push(`  └─ **${g.name}**: ${g.playtimeHours} hrs`);
              });
            }

            profileFields.push({
              name: 'Library & Playtime Metrics',
              value: gamesLines.join('\n'),
              inline: false,
            });
          }
        }

        const profileEmbed = {
          title: `Steam Profile Intelligence ❖ ${summary.personaName}`,
          description: `Direct Steam platform dossier for [${summary.personaName}](${summary.profileUrl}).`,
          color: PALETTE.STEAM_ACCENT,
          thumbnail: summary.avatarUrl ? { url: summary.avatarUrl } : undefined,
          fields: profileFields,
          footer: {
            text: 'zT Radar • Steam Intelligence Engine',
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
              embeds: [profileEmbed],
            },
          }),
        };
      } catch (error) {
        console.error('Error fetching Steam profile:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Operation Failed', 'Unable to retrieve Steam profile intelligence.', PALETTE.DANGER)
          ),
        };
      }
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

      if (subCommandName === 'sync-steam') {
        const targetOption = subCommand?.options?.find((opt) => opt.name === 'target');
        const rawTarget = targetOption?.value?.trim() || null;

        try {
          let steamId = null;

          if (rawTarget) {
            // Direct target provided — resolve immediately (no Steam API key required for URL/ID parsing)
            steamId = await resolveSteamId(rawTarget, STEAM_API_KEY);

            if (!steamId) {
              return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                  createEphemeralEmbed(
                    'Steam Resolution Failed',
                    `Could not resolve Steam profile for: \`${rawTarget}\`.\n\nAccepted formats:\n▸ 17-digit numeric **SteamID64**\n▸ Full profile URL (\`https://steamcommunity.com/profiles/...\` or \`/id/...\`)\n▸ Custom vanity alias`,
                    PALETTE.WARNING
                  )
                ),
              };
            }
          } else {
            // No target — attempt to use the caller's linked Steam account
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

            steamId = userConfigResult.Items?.[0]?.steam_id || null;

            if (!steamId) {
              return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                  createEphemeralEmbed(
                    'Steam Account Not Linked',
                    'You have not linked your Steam account yet.\n\nUse `/steam-link <target>` to link your profile, or provide a Steam ID directly:\n▸ `/wishlist sync-steam target:<SteamID64 or vanity URL>`',
                    PALETTE.NEUTRAL
                  )
                ),
              };
            }
          }

          // Fetch wishlist using official Valve Steam Web API
          const wishlistResult = await fetchSteamWishlist(steamId, STEAM_API_KEY);

          if (!wishlistResult.success) {
            if (wishlistResult.error === 'CONFIG_REQUIRED') {
              return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                  createEphemeralEmbed(
                    'Configuration Required',
                    'A valid Valve `STEAM_API_KEY` is required on the server to execute Steam Wishlist synchronization.',
                    PALETTE.WARNING
                  )
                ),
              };
            }

            const isPrivate = wishlistResult.error === 'PRIVATE_OR_NOT_FOUND';
            const msg = isPrivate
              ? [
                  'The Steam wishlist for this profile is **private or inaccessible**.',
                  '',
                  'To enable wishlist synchronization:',
                  '▸ Open **Steam** and navigate to your **Profile**.',
                  '▸ Go to **Edit Profile** ❖ **Privacy Settings**.',
                  '▸ Set **Game Details** to **Public** and **Wishlist** to **Public**.',
                  '▸ Re-run `/wishlist sync-steam` after saving.',
                ].join('\n')
              : 'Failed to retrieve Steam wishlist data. The Steam Web API may be temporarily unavailable. Please try again shortly.';

            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                createEphemeralEmbed(
                  isPrivate ? 'Wishlist Access Denied' : 'Wishlist Retrieval Failed',
                  msg,
                  PALETTE.WARNING
                )
              ),
            };
          }

          const wishlistItems = wishlistResult.items || [];

          if (wishlistItems.length === 0) {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                createEphemeralEmbed(
                  'Steam Wishlist Empty',
                  `The Steam wishlist for this profile (SteamID64: \`${steamId}\`) contains no items to import.`,
                  PALETTE.NEUTRAL
                )
              ),
            };
          }

          // Safeguard against massive wishlists: cap to top 100 most recently added titles
          const totalWishlistCount = wishlistItems.length;
          const wasCapped = totalWishlistCount > 100;
          const targetItems = wishlistItems.slice(0, 100);

          // Query existing tracked items to preserve custom target_price values
          const existingResult = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
              ExpressionAttributeValues: {
                ':pk': `USER#${userId}`,
                ':skPrefix': 'GAME#',
              },
            })
          );

          const existingKeys = new Set(
            (existingResult.Items || []).map((item) => item.SK)
          );
          const existingExternalIds = new Set(
            (existingResult.Items || []).map((item) => item.external_game_id).filter(Boolean)
          );

          // Identify entries not already tracked by external_game_id
          const untrackedItems = [];
          let preservedCount = 0;

          for (const entry of targetItems) {
            if (existingExternalIds.has(`steam:${entry.appId}`)) {
              preservedCount++;
            } else {
              untrackedItems.push(entry);
            }
          }

          // Resolve game titles for untracked items via Steam Store appdetails API
          const untrackedAppIds = untrackedItems.map((entry) => entry.appId);
          const titleMap = await resolveSteamAppTitles(untrackedAppIds, 2000);

          const now = new Date().toISOString();
          const itemsToInsert = [];
          const seenSKs = new Set();

          for (const entry of untrackedItems) {
            const title = titleMap.get(entry.appId) || `App #${entry.appId}`;
            const normalizedTitle = title.toLowerCase().trim();
            const sk = `GAME#${normalizedTitle}`;

            if (existingKeys.has(sk)) {
              // Existing tracked item: preserve its target_price and settings — skip overwrite
              preservedCount++;
            } else if (!seenSKs.has(sk)) {
              // Deduplicate across the batch to satisfy DynamoDB BatchWrite item uniqueness
              seenSKs.add(sk);
              itemsToInsert.push({
                appId: entry.appId,
                title,
                sk,
              });
            }
          }

          // Persist items in chunks of 25 using BatchWriteCommand
          const BATCH_SIZE = 25;
          for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
            const chunk = itemsToInsert.slice(i, i + BATCH_SIZE);
            await docClient.send(
              new BatchWriteCommand({
                RequestItems: {
                  [TABLE_NAME]: chunk.map((item) => ({
                    PutRequest: {
                      Item: {
                        PK: `USER#${userId}`,
                        SK: item.sk,
                        game_title: item.title,
                        external_game_id: `steam:${item.appId}`,
                        target_price: null,
                        alert_all_time_low: true,
                        alert_free: true,
                        alert_steep_discount: true,
                        user_id: userId,
                        created_at: now,
                      },
                    },
                  })),
                },
              })
            );
          }

          const importedCount = itemsToInsert.length;
          const importedTitles = itemsToInsert.slice(0, 10).map((e) => e.title);

          // Build summary embed fields
          const summaryLines = [
            `▸ Total Steam wishlist entries processed: **${targetItems.length}**${wasCapped ? ` (of ${totalWishlistCount} total)` : ''}`,
            `▸ Newly imported to radar: **${importedCount}**`,
            `▸ Existing tracked items preserved: **${preservedCount}**`,
          ];

          if (wasCapped) {
            summaryLines.push('▸ Note: Synced top 100 most recently added wishlist titles.');
          }

          const summaryFields = [
            {
              name: 'Sync Summary',
              value: summaryLines.join('\n'),
              inline: false,
            },
          ];

          if (importedTitles.length > 0) {
            const previewLines = importedTitles.map((t) => `  └─ ${t}`);
            if (importedCount > importedTitles.length) {
              previewLines.push(`  └─ ...and ${importedCount - importedTitles.length} more`);
            }
            summaryFields.push({
              name: 'Imported Titles (Preview)',
              value: ['▸ First batch added:'].concat(previewLines).join('\n'),
              inline: false,
            });
          }

          const syncEmbed = {
            title: 'Steam Wishlist Sync Complete ❖',
            description: wasCapped
              ? 'Successfully synchronized top 100 most recently added wishlist titles into the zT Radar tracking registry.\nAll imported titles will trigger alerts on price drops, historical lows, and free promotions.'
              : 'Successfully synchronized your Steam wishlist into the zT Radar tracking registry.\nAll imported titles will trigger alerts on price drops, historical lows, and free promotions.',
            color: importedCount > 0 ? PALETTE.SUCCESS : PALETTE.NEUTRAL,
            fields: summaryFields,
            footer: {
              text: 'zT Radar • Steam Wishlist Intelligence',
            },
            timestamp: now,
          };

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                embeds: [syncEmbed],
              },
            }),
          };
        } catch (error) {
          console.error('Error executing wishlist sync-steam:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Sync Failed', 'Unable to complete Steam wishlist synchronization. Please try again.', PALETTE.DANGER)
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