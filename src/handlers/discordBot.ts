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
import {
  searchGamesForAutocomplete,
  getGameDealInfo,
  getMarketOverviewDeals,
  formatExpiryAvailability,
  formatPriceComparisonDiff,
} from '../utils/itadApi.js';
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
  compareLibraries,
  calculateBacklogTelemetry,
  buildDuelEmbedPayload,
  buildBacklogEmbedPayload,
  findMatchingGames,
  buildGameMatchEmbedPayload,
} from '../utils/steamWeb.js';
import { getHowLongToBeatStats } from '../utils/hltbNative.js';
import {
  generateStateToken,
  validateAndConsumeStateToken,
  buildSteamLoginUrl,
  verifyOpenIdAssertion,
  buildUnlinkedAccountEmbed,
} from '../utils/steamOpenId.js';
import type {
  DiscordInteractionPayload,
  DiscordInteractionOption,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordActionRow,
  PlatformStatusEntry,
  DynamoDbWishlistItem,
} from '../types/index.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME || '';
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const AUTH_CALLBACK_URL = process.env.AUTH_CALLBACK_URL || '';

const RESPONSE_TYPES = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  UPDATE_MESSAGE: 7,
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

function createEphemeralEmbed(
  title: string,
  description: string,
  color: number = PALETTE.BRAND,
  fields: DiscordEmbedField[] = [],
) {
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

/**
 * Resolves a target parameter to a SteamID64, identifying whether it belongs to the caller
 * or a mentioned user, and whether an account is unlinked.
 */
export async function resolveSteamTarget(
  targetStr: string | null | undefined,
  callerUserId: string,
  ddbDocClient?: any,
  tableName?: string,
  steamApiKey?: string,
) {
  if (!targetStr) {
    // Target is the caller
    if (!ddbDocClient || !tableName) {
      return { success: false, unlinked: true, isCaller: true, userId: callerUserId, error: 'NO_LINKED_ACCOUNT' };
    }
    const cfg = await ddbDocClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `USER#${callerUserId}`,
          ':sk': 'CONFIG',
        },
      })
    );
    const steamId = cfg.Items?.[0]?.steam_id;
    if (!steamId) {
      return { success: false, unlinked: true, isCaller: true, userId: callerUserId, error: 'NO_LINKED_ACCOUNT' };
    }
    return { success: true, steamId, isCaller: true, userId: callerUserId };
  }

  const mentionMatch = targetStr.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    const mentionedId = mentionMatch[1];
    const isCaller = (mentionedId === callerUserId);
    if (!ddbDocClient || !tableName) {
      return { success: false, unlinked: true, isCaller, userId: mentionedId, error: isCaller ? 'NO_LINKED_ACCOUNT' : 'TARGET_NOT_LINKED' };
    }
    const cfg = await ddbDocClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `USER#${mentionedId}`,
          ':sk': 'CONFIG',
        },
      })
    );
    const steamId = cfg.Items?.[0]?.steam_id;
    if (!steamId) {
      return { success: false, unlinked: true, isCaller, userId: mentionedId, error: isCaller ? 'NO_LINKED_ACCOUNT' : 'TARGET_NOT_LINKED' };
    }
    return { success: true, steamId, isCaller, userId: mentionedId };
  }

  const resolved = await resolveSteamId(targetStr, steamApiKey || '');
  if (!resolved) {
    return {
      success: false,
      error: `Could not resolve Steam profile for: \`${targetStr}\`.\n\nPlease verify your input:\n▸ 17-digit numeric **SteamID64**\n▸ Profile URL (\`https://steamcommunity.com/id/...\`)\n▸ Custom vanity URL or alias`,
    };
  }
  return { success: true, steamId: resolved, isCaller: false };
}

/**
 * Builds the appropriate unlinked response payload based on whether the unlinked account
 * is the caller (returns OpenID 2.0 connection button) or a mentioned target (returns targeted guidance).
 *
 * @param {object} targetResult - Result from resolveSteamTarget where unlinked === true
 * @param {string} authLoginUrl - Base Steam OpenID login initiation URL
 * @returns {object} Discord interaction response payload
 */
export function buildTargetUnlinkedResponse(targetResult: any, authLoginUrl: string) {
  if (targetResult.isCaller) {
    const loginUrl = authLoginUrl ? `${authLoginUrl}?user_id=${encodeURIComponent(targetResult.userId)}` : '';
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildUnlinkedAccountEmbed(targetResult.userId, loginUrl)),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: MESSAGE_FLAGS.EPHEMERAL,
        embeds: [
          {
            title: 'Steam Account Not Linked',
            description: `User <@${targetResult.userId}> has not linked a Steam profile with zT Radar yet.\n\nAsk them to use \`/steam-link\`, or pass their SteamID64 / custom URL directly in the command.`,
            color: PALETTE.WARNING,
            footer: { text: 'zT Radar • Steam Identity Engine' },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    }),
  };
}

/**
 * Constructs paginated embed and action row components for /wishlist list.
 */
function buildWishlistPagePayload(
  items: any[],
  userConfig: any,
  requestedPage: number = 1,
): { embeds: DiscordEmbed[]; components: DiscordActionRow[] } {
  const totalItems = items.length;
  const ITEMS_PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);

  const sortedItems = [...items].sort((a, b) =>
    (a.game_title || '').localeCompare(b.game_title || '', undefined, { sensitivity: 'base' })
  );

  const startIndex = (page - 1) * ITEMS_PER_PAGE;
  const pageItems = sortedItems.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const userCurrency = userConfig?.preferred_currency || 'USD';
  const sym = userCurrency === 'BRL' ? 'R$' : '$';

  const formattedList = pageItems
    .map((item) => {
      const target = item.target_price
        ? `\n  └─ Target Price: **${sym} ${Number(item.target_price).toFixed(2)}**`
        : item.min_discount
          ? `\n  └─ Threshold: **≥ -${item.min_discount}% off**${item.min_rating ? ` (Score ≥ ${item.min_rating})` : ''}`
          : '\n  └─ Target Price: **Any promotional drop**';
      return `❖ **${item.game_title}**${target}`;
    })
    .join('\n\n');

  const listEmbed: DiscordEmbed = {
    title: `Personal Radar Registry ❖ ${totalItems} Active`,
    description: formattedList,
    color: PALETTE.BRAND,
    footer: {
      text: `Page ${page} of ${totalPages} ❖ ${totalItems} tracked titles (Display Currency: ${userCurrency})`,
    },
    timestamp: new Date().toISOString(),
  };

  const components: DiscordActionRow[] = [
    {
      type: 1, // Action Row
      components: [
        {
          type: 2, // Button
          style: 2, // Secondary
          label: '◀ Prev',
          custom_id: `wl_page:${page - 1}`,
          disabled: page === 1,
        },
        {
          type: 2, // Button
          style: 2, // Secondary
          label: 'Next ▶',
          custom_id: `wl_page:${page + 1}`,
          disabled: page === totalPages,
        },
      ],
    },
  ];

  return {
    embeds: [listEmbed],
    components,
  };
}

export const handler = async (
  event: any,
): Promise<{ statusCode: number; headers?: Record<string, string>; body: string }> => {
  // HTTP routing guard — intercept GET requests for Steam OpenID auth routes
  // before Ed25519 signature verification (these are not Discord interactions).
  const httpMethod = (event.requestContext?.http?.method || event.httpMethod || '').toUpperCase();
  const rawPath = event.rawPath || event.requestContext?.http?.path || event.path || '';
  const isSteamLogin = httpMethod === 'GET' && (rawPath === '/auth/steam/login' || rawPath.endsWith('/auth/steam/login'));
  const isSteamCallback = httpMethod === 'GET' && (rawPath === '/auth/steam/callback' || rawPath.endsWith('/auth/steam/callback'));

  if (isSteamLogin) {
    const userId = event.queryStringParameters?.user_id || new URLSearchParams(event.rawQueryString || '').get('user_id');

    if (!userId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<h2>Bad Request</h2><p>Missing user_id parameter.</p>',
      };
    }

    if (!AUTH_CALLBACK_URL) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<h2>Service Unavailable</h2><p>Steam OpenID callback URL is not configured.</p>',
      };
    }

    try {
      const stateToken = await generateStateToken(userId, docClient, TABLE_NAME);
      const steamRedirectUrl = buildSteamLoginUrl(stateToken, AUTH_CALLBACK_URL, userId);
      return {
        statusCode: 302,
        headers: {
          Location: steamRedirectUrl,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
        body: '',
      };
    } catch (err) {
      console.error('Error generating Steam login redirect:', err);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<h2>Internal Error</h2><p>Unable to initiate Steam authentication. Please try again.</p>',
      };
    }
  }

  if (isSteamCallback) {
    const rawParams = event.rawQueryString ? Object.fromEntries(new URLSearchParams(event.rawQueryString)) : {};
    const queryParams = {
      ...rawParams,
      ...(event.queryStringParameters || {}),
    };
    const stateToken = queryParams.state;

    // Extract the user_id that was embedded in the return_to URL's state param format
    // The state token is a 64-char hex string keyed by user ID in DynamoDB.
    // We need to find the user by iterating — since we store per user, decode from state.
    // Architecture note: the state token lookup requires a scan unless userId is also passed.
    // Solution: pass userId as a separate query param on the return_to URL.
    const userId = queryParams.user_id;

    if (!stateToken || !userId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<h2>Bad Request</h2><p>Missing required OpenID callback parameters.</p>',
      };
    }

    try {
      // Validate CSRF state token before trusting the assertion
      const isValidState = await validateAndConsumeStateToken(userId, stateToken, docClient, TABLE_NAME);
      if (!isValidState) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: '<h2>Authentication Failed</h2><p>Invalid or expired state token. Please try linking your account again.</p>',
        };
      }

      // Verify the OpenID assertion with Steam's check_authentication endpoint
      const steamId64 = await verifyOpenIdAssertion(queryParams);
      if (!steamId64) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: '<h2>Verification Failed</h2><p>Steam could not verify your identity. Please try again.</p>',
        };
      }

      // Fetch persona name and avatar from Steam Web API for display
      let personaName = steamId64;
      let avatarUrl = '';
      if (STEAM_API_KEY) {
        try {
          const summary = await getPlayerSummary(steamId64, STEAM_API_KEY);
          if (summary) {
            personaName = summary.personaName || steamId64;
            avatarUrl = summary.avatarUrl || '';
          }
        } catch (profileErr: any) {
          console.warn('Could not fetch Steam profile for callback confirmation:', profileErr?.message || profileErr);
        }
      }

      // Persist verified Steam identity to DynamoDB
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `USER#${userId}`,
            SK: 'CONFIG',
          },
          UpdateExpression:
            'SET steam_id = :sid, steam_persona_name = :sname, steam_avatar_url = :savatar, steam_verified = :verified, updated_at = :now',
          ExpressionAttributeValues: {
            ':sid': steamId64,
            ':sname': personaName,
            ':savatar': avatarUrl,
            ':verified': true,
            ':now': new Date().toISOString(),
          },
        })
      );

      const html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '  <title>zT Radar - Steam Account Linked</title>',
        '  <style>',
        '    body { font-family: system-ui, sans-serif; background: #1b2838; color: #c7d5e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }',
        '    .card { background: #2a475e; border-radius: 8px; padding: 2rem 2.5rem; max-width: 420px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }',
        '    h1 { color: #66c0f4; margin-bottom: 0.5rem; font-size: 1.4rem; }',
        '    .persona { font-size: 1.1rem; font-weight: 600; color: #ffffff; margin: 0.75rem 0 0.25rem; }',
        '    .steamid { font-family: monospace; font-size: 0.85rem; color: #8f98a0; }',
        '    .note { margin-top: 1.25rem; font-size: 0.85rem; color: #8f98a0; }',
        '    .checkmark { font-size: 2.5rem; margin-bottom: 0.5rem; }',
        '  </style>',
        '</head>',
        '<body>',
        '  <div class="card">',
        '    <div class="checkmark">&#10003;</div>',
        '    <h1>Steam Account Linked</h1>',
        `    <p class="persona">${personaName.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
        `    <p class="steamid">${steamId64}</p>`,
        '    <p class="note">You may close this window and return to Discord. Your Steam profile is now linked to zT Radar.</p>',
        '  </div>',
        '</body>',
        '</html>',
      ].join('\n');

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      };
    } catch (err) {
      console.error('Error during Steam OpenID callback processing:', err);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<h2>Internal Error</h2><p>An unexpected error occurred. Please try linking your account again.</p>',
      };
    }
  }

  // Ed25519 signature verification for Discord interaction webhooks
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

  const interaction: DiscordInteractionPayload = JSON.parse(rawBody);

  // Handshake PING (Type 1)
  if (interaction.type === 1) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: RESPONSE_TYPES.PONG }),
    };
  }

  // Message Component Interaction (Type 3) - e.g. Pagination Buttons
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id || '';
    const userId = interaction.member?.user?.id || interaction.user?.id;

    if (customId.startsWith('wl_page:')) {
      const targetPage = parseInt(customId.split(':')[1], 10) || 1;

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
        const userConfig = userConfigResult.Items?.[0] || null;
        const pageData = buildWishlistPagePayload(items, userConfig, targetPage);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              ...pageData,
            },
          }),
        };
      } catch (error) {
        console.error('Error handling wishlist pagination button:', error);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Pagination Error',
                  description: 'Unable to load the requested page. Please run `/wishlist list` again.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }
    }

    if (customId.startsWith('duel_p:')) {
      const parts = customId.split(':');
      const targetPage = parseInt(parts[1], 10) || 1;
      const steamIdA = parts[2];
      const steamIdB = parts[3];

      if (!steamIdA || !steamIdB || !STEAM_API_KEY) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Duel Inaccessible',
                  description: 'Unable to load duel data for pagination.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }

      try {
        const [summaryA, summaryB, comparison] = await Promise.all([
          getPlayerSummary(steamIdA, STEAM_API_KEY),
          getPlayerSummary(steamIdB, STEAM_API_KEY),
          compareLibraries(steamIdA, steamIdB, STEAM_API_KEY),
        ]);

        if (!summaryA || !summaryB || !comparison?.success) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.UPDATE_MESSAGE,
              data: {
                embeds: [
                  {
                    title: 'Pagination Error',
                    description: 'Failed to retrieve duel comparison data.',
                    color: PALETTE.DANGER,
                  },
                ],
              },
            }),
          };
        }

        const { embeds, components } = buildDuelEmbedPayload(comparison, summaryA, summaryB, targetPage);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds,
              components,
            },
          }),
        };
      } catch (err) {
        console.error('Error in duel pagination:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Pagination Error',
                  description: 'An error occurred while loading duel page.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }
    }

    if (customId.startsWith('match_p:')) {
      const parts = customId.split(':');
      const targetPage = parseInt(parts[1], 10) || 1;
      const filterMode = parts[2] || 'coop';
      const steamIdA = parts[3];
      const steamIdB = parts[4];

      if (!steamIdA || !steamIdB || !STEAM_API_KEY) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Match Inaccessible',
                  description: 'Unable to load game match data for pagination.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }

      try {
        const [summaryA, summaryB, matchResult] = await Promise.all([
          getPlayerSummary(steamIdA, STEAM_API_KEY),
          getPlayerSummary(steamIdB, STEAM_API_KEY),
          findMatchingGames(steamIdA, steamIdB, filterMode, STEAM_API_KEY),
        ]);

        if (!summaryA || !summaryB || !matchResult?.success) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.UPDATE_MESSAGE,
              data: {
                embeds: [
                  {
                    title: 'Pagination Error',
                    description: 'Failed to retrieve game match comparison data.',
                    color: PALETTE.DANGER,
                  },
                ],
              },
            }),
          };
        }

        const { embeds, components } = buildGameMatchEmbedPayload(matchResult, summaryA, summaryB, targetPage, filterMode);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds,
              components,
            },
          }),
        };
      } catch (err) {
        console.error('Error in game match pagination:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Pagination Error',
                  description: 'An error occurred while loading game match page.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }
    }

    if (customId.startsWith('backlog_p:')) {
      const parts = customId.split(':');
      const targetPage = parseInt(parts[1], 10) || 1;
      const steamId = parts[2];

      if (!steamId || !STEAM_API_KEY) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Backlog Inaccessible',
                  description: 'Unable to load backlog data for pagination.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }

      try {
        let preferredCurrency = 'USD';
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
          preferredCurrency = userConfigResult.Items?.[0]?.preferred_currency || 'USD';
        } catch {
          // fallback to USD
        }

        const [summary, telemetry] = await Promise.all([
          getPlayerSummary(steamId, STEAM_API_KEY),
          calculateBacklogTelemetry(steamId, STEAM_API_KEY, preferredCurrency),
        ]);

        if (!summary || !telemetry?.success) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.UPDATE_MESSAGE,
              data: {
                embeds: [
                  {
                    title: 'Pagination Error',
                    description: 'Failed to retrieve backlog telemetry data.',
                    color: PALETTE.DANGER,
                  },
                ],
              },
            }),
          };
        }

        const { embed, components } = await buildBacklogEmbedPayload(telemetry, summary, targetPage);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [embed],
              components,
            },
          }),
        };
      } catch (err) {
        console.error('Error in backlog pagination:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.UPDATE_MESSAGE,
            data: {
              embeds: [
                {
                  title: 'Pagination Error',
                  description: 'An error occurred while loading backlog page.',
                  color: PALETTE.DANGER,
                },
              ],
            },
          }),
        };
      }
    }
  }

  // Autocomplete Handling (Type 4)
  if (interaction.type === 4) {
    const { name, options } = interaction.data || {};
    const userId = interaction.member?.user?.id || interaction.user?.id;

    const autocompleteCommands = ['compare', 'can-it-run', 'game-news', 'wishlist', 'how-long-to-beat'];

    if (autocompleteCommands.includes(name || '')) {
      const subCommand: DiscordInteractionOption | undefined = options?.[0];
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
    const { name, options } = interaction.data || {};
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

        const embed: DiscordEmbed = {
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

    // Command: /how-long-to-beat <game>
    if (name === 'how-long-to-beat') {
      const gameOption = options?.find((opt) => opt.name === 'game');
      const rawVal = gameOption?.value;

      if (!rawVal) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Selection Required',
              'Please type and select a game from the autocomplete suggestions dropdown.',
              PALETTE.WARNING
            )
          ),
        };
      }

      let externalGameId = rawVal;
      let gameTitle = rawVal;

      if (rawVal.includes('|')) {
        const [idPart, ...titleParts] = rawVal.split('|');
        externalGameId = idPart;
        gameTitle = titleParts.join('|');
      }

      try {
        // Query caller's regional currency preference
        let userCurrency = 'USD';
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
          userCurrency = userConfigResult.Items?.[0]?.preferred_currency || 'USD';
        } catch {
          // Fallback to USD
        }

        // Concurrently query HowLongToBeat completion statistics and live storefront deal intelligence
        const [hltbSettled, dealSettled] = await Promise.allSettled([
          getHowLongToBeatStats(gameTitle),
          getGameDealInfo(externalGameId, userCurrency, gameTitle),
        ]);

        const hltbData = hltbSettled.status === 'fulfilled' ? hltbSettled.value : null;
        const dealInfo = dealSettled.status === 'fulfilled' ? dealSettled.value : null;

        if (!hltbData || !hltbData.success) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Playtime Data Unavailable',
                `Could not retrieve HowLongToBeat completion statistics for **${gameTitle}**.\nThe title may not be indexed on HowLongToBeat or the service is temporarily unresponsive.`,
                PALETTE.WARNING
              )
            ),
          };
        }

        const sym = userCurrency === 'BRL' ? 'R$' : '$';
        const bestOffer = dealInfo?.cheaperAlternative || dealInfo?.primaryDeal || null;
        const bestPrice = bestOffer ? bestOffer.salePrice : null;
        const mainHours = hltbData.mainStoryHours || 0;
        const extraHours = hltbData.mainExtraHours || 0;
        const compHours = hltbData.completionistHours || 0;
        const allHours = hltbData.allPlayStylesHours || 0;

        // Effective hours for primary Cost-Per-Hour calculation
        const effectiveHours = mainHours > 0 ? mainHours : (allHours > 0 ? allHours : (extraHours > 0 ? extraHours : 0));

        // Format Average Completion Times breakdown
        const completionLines = [];
        if (mainHours > 0) {
          completionLines.push(`▸ Main Story: **${mainHours} hours**`);
        }
        if (extraHours > 0) {
          completionLines.push(`▸ Main + Extras: **${extraHours} hours**`);
        }
        if (compHours > 0) {
          completionLines.push(`▸ 100% Completionist: **${compHours} hours**`);
        }
        if (completionLines.length === 0 && allHours > 0) {
          completionLines.push(`▸ All PlayStyles Average: **${allHours} hours**`);
        }

        // Compute Cost-Per-Hour entertainment metric
        let cphValue = '';
        if (bestPrice === null || !bestOffer) {
          cphValue = '▸ Storefront pricing currently unavailable to compute cost-per-hour.';
        } else if (bestPrice === 0) {
          cphValue = [
            `▸ **Free to Play / 100% Promotional (${sym} 0.00 / hour)**`,
            `└─ Based on current free storefront price at ${bestOffer.shopName}.`,
          ].join('\n');
        } else if (effectiveHours > 0) {
          const cph = (bestPrice / effectiveHours).toFixed(2);
          const hoursBasis = mainHours > 0 ? 'Main Story' : 'All PlayStyles';
          const cutText = bestOffer.cutPercent > 0 ? ` (-${bestOffer.cutPercent}%)` : '';
          cphValue = [
            `▸ **${sym} ${cph} / hour** (based on ${hoursBasis}: ${effectiveHours}h)`,
            `└─ Live Offer: **${sym} ${bestPrice.toFixed(2)}**${cutText} at ${bestOffer.shopName}`,
          ].join('\n');
        } else {
          const cutText = bestOffer.cutPercent > 0 ? ` (-${bestOffer.cutPercent}%)` : '';
          cphValue = [
            `▸ Live Offer: **${sym} ${bestPrice.toFixed(2)}**${cutText} at ${bestOffer.shopName}`,
            '└─ Playtime duration too variable to compute hourly rate.',
          ].join('\n');
        }

        const fields = [
          {
            name: 'Average Completion Times',
            value: completionLines.length > 0 ? completionLines.join('\n') : '▸ No verified completion times recorded.',
            inline: false,
          },
          {
            name: 'Cost-Per-Hour Analysis',
            value: cphValue,
            inline: false,
          },
        ];

        if (dealInfo && dealInfo.reviewScore) {
          fields.push({
            name: 'Community Score',
            value: `▸ **${dealInfo.reviewScore}/100** approval`,
            inline: true,
          });
        }

        if (dealInfo && dealInfo.allTimeLowPrice != null) {
          fields.push({
            name: 'Historical Low (ATL)',
            value: `▸ **${sym} ${dealInfo.allTimeLowPrice.toFixed(2)}**`,
            inline: true,
          });
        }

        // Action buttons
        const buttons = [];
        if (bestOffer?.url) {
          buttons.push({
            type: 2,
            style: 5,
            label: `Buy on ${bestOffer.shopName}`,
            url: bestOffer.url,
          });
        }

        if (hltbData.gameId) {
          buttons.push({
            type: 2,
            style: 5,
            label: 'View on HowLongToBeat',
            url: `https://howlongtobeat.com/game/${hltbData.gameId}`,
          });
        }

        if (dealInfo?.steamAppId) {
          buttons.push({
            type: 2,
            style: 5,
            label: 'SteamDB',
            url: `https://steamdb.info/app/${dealInfo.steamAppId}/`,
          });
        }

        const components = buttons.length > 0 ? [{ type: 1, components: buttons.slice(0, 5) }] : [];

        const embed: DiscordEmbed = {
          title: `HowLongToBeat ❖ ${hltbData.gameTitle || gameTitle}`,
          description: `Playtime intelligence & entertainment value analysis for **${hltbData.gameTitle || gameTitle}**.`,
          color: PALETTE.BRAND,
          fields,
          footer: {
            text: `zT Radar • Data via HowLongToBeat & Authorized Stores (${userCurrency})`,
          },
          timestamp: new Date().toISOString(),
        };

        const imageUrl = dealInfo?.imageUrl || hltbData.imageUrl;
        if (imageUrl) {
          embed.thumbnail = { url: imageUrl };
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
      } catch (hltbError) {
        console.error('Error executing /how-long-to-beat command:', hltbError);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed(
              'Analysis Error',
              'An unexpected error occurred while analyzing playtime metrics.',
              PALETTE.DANGER
            )
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

        const formatLine = (item: PlatformStatusEntry) => {
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

        const embed: DiscordEmbed = {
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

        const diffBlock = formatPriceComparisonDiff(dealInfo.primaryDeal, dealInfo.cheaperAlternative, sym);
        const fieldName = dealInfo.cheaperAlternative
          ? `Price Comparison ❖ ${dealInfo.primaryDeal.shopName} vs ${dealInfo.cheaperAlternative.shopName}`
          : `Price Overview ❖ ${dealInfo.primaryDeal.shopName}`;

        const fields = [
          {
            name: fieldName,
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

        if (dealInfo.allTimeLowPrice != null) {
          const isRealAtl = dealInfo.isAllTimeLow && bestOffer.cutPercent > 0 && bestOffer.salePrice < bestOffer.regularPrice;
          const diffFromAtl = bestOffer.salePrice - dealInfo.allTimeLowPrice;
          let atlStatus = '';

          if (isRealAtl) {
            atlStatus = `▸ **${sym} ${dealInfo.allTimeLowPrice.toFixed(2)}**\n└─ **MATCHES LOWEST PRICE EVER!**`;
          } else if (diffFromAtl > 0) {
            atlStatus = `▸ **${sym} ${dealInfo.allTimeLowPrice.toFixed(2)}**\n└─ Current price is ${sym} ${diffFromAtl.toFixed(2)} above record low.`;
          } else {
            atlStatus = `▸ **${sym} ${dealInfo.allTimeLowPrice.toFixed(2)}**\n└─ Standard retail price.`;
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

        const embed: DiscordEmbed = {
          title: `zT Radar ❖ Price Comparison: ${dealInfo.title}`,
          description: `Live price comparison in **${preferredCurrency} (${sym})**.`,
          color: (dealInfo.isAllTimeLow && bestOffer.cutPercent > 0 && bestOffer.salePrice < bestOffer.regularPrice) ? PALETTE.SUCCESS : PALETTE.BRAND,
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
        description: 'Comprehensive directory of gaming intelligence, price monitoring, and server broadcast commands.',
        color: PALETTE.BRAND,
        fields: [
          {
            name: '❖ Personal & Market Intelligence [DM & Server]',
            value: [
              '▸ `/compare <game>`\n  └─ Price check across Steam, Epic, Nuuvem & GOG with ATL.',
              '▸ `/can-it-run <game>`\n  └─ Minimum & recommended PC specs from Steam.',
              '▸ `/game-news <game>`\n  └─ Patch notes, news, and developer dispatches.',
              '▸ `/how-long-to-beat <game>`\n  └─ Completion times and cost-per-hour metrics.',
              '▸ `/steam-most-played`\n  └─ Top 10 most-played Steam titles by players.',
              '▸ `/steam-trending`\n  └─ Top 10 surging games on the Steam Store.',
              '▸ `/platform-status`\n  └─ Service availability for Steam, Epic, PSN & Xbox.',
              '▸ `/wishlist <add|list|clear|remove|sync-steam>`\n  └─ Track deals & price targets.',
              '▸ `/currency <choice>`\n  └─ Set personal currency between USD ($) and BRL (R$).',
              '▸ `/steam-link [target]`\n  └─ Link Steam account (Valve OpenID one-click, SteamID64, or vanity).',
              '▸ `/steam-profile [user] [target]`\n  └─ View profile overview, VAC status, and stats.',
              '▸ `/game-match <target1> <target2> [filter]`\n  └─ Discover shared co-op & multiplayer games across two libraries.',
              '▸ `/steam-duel <target1> <target2>`\n  └─ Compare playtime and achievement dominance on common games.',
              '▸ `/steam-backlog [target]`\n  └─ Telemetry on unplayed games, backlog percentage & wasted value.',
              '▸ `/free-play-radar`\n  └─ Browse active free giveaways and Free Weekends.',
              '▸ `/free-radar-dm <enabled>`\n  └─ Toggle automated DM alerts for free games.',
            ].join('\n'),
            inline: false,
          },
          {
            name: '❖ Server Administration & Curated Radar [Server Only • Requires Manage Server]',
            value: [
              '▸ `/config-channel <channel> [currency] [include_third_party] [free_only]`\n  └─ Route curated deals and free game broadcasts into a server channel.',
              '▸ `/config-channel-experimental [min_discount] [min_rating]`\n  └─ Configure minimum discount and community rating broadcast filters.',
              '▸ `/config-channel-remove`\n  └─ Deactivate automatic deal and giveaway broadcasts for this server.',
              '▸ `/radar-status`\n  └─ Display server broadcast configuration and system operational status.',
            ].join('\n'),
            inline: false,
          },
        ],
        footer: {
          text: 'zT Radar • Gaming Intelligence & Deal Radar',
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

    // Command: /free-play-radar
    if (name === 'free-play-radar') {
      try {
        let userCurrency = 'USD';
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
          if (userConfigResult.Items?.[0]?.preferred_currency) {
            userCurrency = userConfigResult.Items[0].preferred_currency;
          }
        } catch (cfgErr: any) {
          console.warn('Could not query user config for /free-play-radar:', cfgErr?.message || cfgErr);
        }

        const marketDeals = await getMarketOverviewDeals(false, userCurrency);
        const freeToKeep = marketDeals.filter((d) => d.dealType === 'FREE_TO_KEEP');
        const freePlayEvents = marketDeals.filter((d) => d.dealType === 'FREE_PLAY_DAYS');

        if (freeToKeep.length === 0 && freePlayEvents.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Free Play Radar ❖ Market Overview',
                'No promotional free games are currently active. Check back on Thursday when Epic Games updates weekly giveaways.',
                PALETTE.NEUTRAL
              )
            ),
          };
        }

        const sym = userCurrency === 'BRL' ? 'R$' : '$';
        const fields = [];
        const buttons = [];

        if (freeToKeep.length > 0) {
          const keepDescriptions = freeToKeep.map((deal) => {
            const regPrice = deal.primaryDeal?.regularPrice
              ? `${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`
              : 'Paid';
            const expiryText = formatExpiryAvailability(deal.expiry || deal.primaryDeal?.expiry);

            return [
              `❖ **${deal.title}** (${deal.primaryDeal.shopName})`,
              `  └─ Claim for permanent library ownership • Value: ~~${regPrice}~~ ➔ **FREE**`,
              `  ${expiryText}`,
              '```diff',
              `- Regular Price: ${regPrice}`,
              `+ Promotional:   ${sym} 0.00 (-100%)`,
              '```',
            ].join('\n');
          });

          fields.push({
            name: '100% Free to Keep ❖ Permanent Giveaways',
            value: keepDescriptions.join('\n'),
            inline: false,
          });
        }

        if (freePlayEvents.length > 0) {
          const eventDescriptions = freePlayEvents.map((deal) => {
            const regPrice = deal.primaryDeal?.regularPrice
              ? `${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`
              : 'Standard';
            const expiryText = formatExpiryAvailability(deal.expiry || deal.primaryDeal?.expiry);

            return [
              `❖ **${deal.title}** (Steam)`,
              `  └─ Active Free Weekend promotion • Regular Price: ${regPrice}`,
              `  ${expiryText}`,
              '```diff',
              `- Base Price:    ${regPrice}`,
              `+ Weekend Play:  Free Access (Temporary)`,
              '```',
            ].join('\n');
          });

          fields.push({
            name: 'Free Play Events ❖ Play for Free This Weekend',
            value: eventDescriptions.join('\n'),
            inline: false,
          });
        }

        // Add store link buttons (up to 5 buttons in an Action Row)
        const allFreeDeals = [...freeToKeep, ...freePlayEvents];
        const seenButtonUrls = new Set();

        for (const deal of allFreeDeals) {
          if (buttons.length >= 5) break;

          if (deal.primaryDeal?.url && !seenButtonUrls.has(deal.primaryDeal.url)) {
            seenButtonUrls.add(deal.primaryDeal.url);
            buttons.push({
              type: 2, // BUTTON
              style: 5, // LINK
              label: `Claim on ${deal.primaryDeal.shopName}`,
              url: deal.primaryDeal.url,
            });
          }

          if (buttons.length < 5 && deal.steamAppId) {
            const steamDbUrl = `https://steamdb.info/app/${deal.steamAppId}/`;
            if (!seenButtonUrls.has(steamDbUrl)) {
              seenButtonUrls.add(steamDbUrl);
              buttons.push({
                type: 2,
                style: 5,
                label: `SteamDB (${deal.title.substring(0, 15)})`,
                url: steamDbUrl,
              });
            }
          }
        }

        const components = buttons.length > 0 ? [{ type: 1, components: buttons.slice(0, 5) }] : [];
        const featuredImage = allFreeDeals.find((d) => d.imageUrl)?.imageUrl || null;

        const embed: DiscordEmbed = {
          title: 'zT Radar ❖ Free Play & Giveaway Intelligence',
          description: 'Currently detected 100% free promotions and active Free Weekend events.',
          color: freeToKeep.length > 0 ? PALETTE.SUCCESS : 0x9B59B6,
          fields,
          footer: {
            text: `Currency: ${userCurrency} • Steam & Epic Games Store`,
          },
          timestamp: new Date().toISOString(),
        };

        if (featuredImage) {
          embed.thumbnail = { url: featuredImage };
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
      } catch (err) {
        console.error('Error executing /free-play-radar:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Free Radar Error', 'Could not query active free game promotions. Please try again shortly.', PALETTE.DANGER)
          ),
        };
      }
    }

    // Command: /free-radar-dm <enabled>
    if (name === 'free-radar-dm') {
      const enabledOpt = options?.find((opt) => opt.name === 'enabled');
      const isEnabled = Boolean(enabledOpt?.value);

      try {
        await docClient.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: `USER#${userId}`,
              SK: 'CONFIG',
            },
            UpdateExpression: 'SET alert_global_free = :val, updated_at = :now',
            ExpressionAttributeValues: {
              ':val': isEnabled,
              ':now': new Date().toISOString(),
            },
          })
        );

        const embed = isEnabled
          ? {
              title: 'Global Free Alerts Enabled ❖ Direct Messages Active',
              description: [
                'You will now receive automated direct messages whenever new **100% free games** (Steam & Epic Games Store) or **Free Weekend events** go live, without needing to add them to your personal wishlist.',
                '',
                '▸ **Alert Types**: Permanent giveaways & temporary Free Weekend access.',
                '▸ **Throttling**: Capped at max 3 deal notifications per hourly scanner cycle.',
                '▸ **Store Whitelist**: Steam and Epic Games Store.',
                '',
                '*You can toggle this off anytime with `/free-radar-dm enabled:False`.*',
              ].join('\n'),
              color: PALETTE.SUCCESS,
              footer: { text: 'zT Radar • Global Free Play Dispatch' },
              timestamp: new Date().toISOString(),
            }
          : {
              title: 'Global Free Alerts Disabled',
              description: [
                'You have disabled automated direct messages for free games and Free Weekend events.',
                'You will still receive notifications for games specifically added to your personal wishlist.',
              ].join('\n'),
              color: PALETTE.NEUTRAL,
              footer: { text: 'zT Radar • Global Free Play Dispatch' },
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
        console.error('Error updating user alert_global_free setting:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            createEphemeralEmbed('Operation Failed', 'Unable to update free deal alert settings. Please try again.', PALETTE.DANGER)
          ),
        };
      }
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

      // Smart fallback: no target provided -> initiate OpenID 2.0 one-click flow
      if (!rawTarget) {
        if (!AUTH_CALLBACK_URL) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'OpenID Not Configured',
                'The one-click Steam login flow is not available on this instance. Please use `/steam-link <target>` with your SteamID64, profile URL, or vanity name.',
                PALETTE.WARNING
              )
            ),
          };
        }

        try {
          const authLoginUrl = AUTH_CALLBACK_URL.replace('/callback', '/login');
          const loginUrl = `${authLoginUrl}?user_id=${encodeURIComponent(userId || '')}`;
          const embedPayload = buildUnlinkedAccountEmbed(userId || '', loginUrl);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(embedPayload),
          };
        } catch (err) {
          console.error('Error initiating Steam OpenID flow for user', userId, ':', err);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Authentication Error',
                'Unable to initiate Steam OpenID login. Please try again or use `/steam-link <target>` for manual linking.',
                PALETTE.DANGER
              )
            ),
          };
        }
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

    // Command: /steam-duel <target1> <target2>
    if (name === 'steam-duel') {
      const target1Opt = options?.find((opt) => opt.name === 'target1')?.value?.trim();
      const target2Opt = options?.find((opt) => opt.name === 'target2')?.value?.trim();

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

      const authLoginUrl = AUTH_CALLBACK_URL ? AUTH_CALLBACK_URL.replace('/callback', '/login') : '';

      try {
        const [res1, res2] = await Promise.all([
          resolveSteamTarget(target1Opt, userId || '', docClient, TABLE_NAME, STEAM_API_KEY),
          resolveSteamTarget(target2Opt, userId || '', docClient, TABLE_NAME, STEAM_API_KEY),
        ]);

        if (res1.unlinked) {
          return buildTargetUnlinkedResponse(res1, authLoginUrl);
        }

        if (res2.unlinked) {
          return buildTargetUnlinkedResponse(res2, authLoginUrl);
        }

        if (res1.error) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Steam Resolution Failed', res1.error, PALETTE.WARNING)),
          };
        }

        if (res2.error) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Steam Resolution Failed', res2.error, PALETTE.WARNING)),
          };
        }

        const steamIdA = res1.steamId;
        const steamIdB = res2.steamId;

        if (steamIdA === steamIdB) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Invalid Duel Pairing',
                'Cannot duel a Steam library against itself. Please specify two different players or profiles.',
                PALETTE.WARNING
              )
            ),
          };
        }

        const [summaryA, summaryB, comparison] = await Promise.all([
          getPlayerSummary(steamIdA, STEAM_API_KEY),
          getPlayerSummary(steamIdB, STEAM_API_KEY),
          compareLibraries(steamIdA, steamIdB, STEAM_API_KEY),
        ]);

        if (!summaryA || !summaryB) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Profile Inaccessible', 'Unable to retrieve Steam summary data for one or both profiles.', PALETTE.WARNING)
            ),
          };
        }

        if (!comparison?.success) {
          if (comparison?.error === 'PRIVATE_LIBRARY') {
            const privateName =
              comparison.privatePlayer === 'A'
                ? summaryA.personaName
                : comparison.privatePlayer === 'B'
                ? summaryB.personaName
                : 'Both players';

            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                  embeds: [
                    {
                      title: 'Steam Library Private ❖ Duel Inaccessible',
                      description: `Cannot perform library duel: **${privateName}** has their Steam game library set to **Private**.\n\nOwned games must be set to **Public** in Steam Privacy Settings to allow library cross-referencing.`,
                      color: PALETTE.WARNING,
                      footer: { text: 'zT Radar • Steam Duel Intelligence' },
                      timestamp: new Date().toISOString(),
                    },
                  ],
                },
              }),
            };
          }

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Duel Failed', 'An error occurred while cross-referencing libraries.', PALETTE.DANGER)),
          };
        }

        if (comparison.commonGames.length === 0) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                embeds: [
                  {
                    author: {
                      name: `${summaryA.personaName} vs ${summaryB.personaName} • Steam Duel`,
                      icon_url: summaryA.avatarUrl || undefined,
                    },
                    title: 'Steam Library Duel',
                    description: `No common titles found between **${summaryA.personaName}** (${comparison.countA} games) and **${summaryB.personaName}** (${comparison.countB} games).`,
                    color: 0x5865f2,
                    thumbnail: summaryB.avatarUrl ? { url: summaryB.avatarUrl } : undefined,
                    footer: { text: 'zT Radar • Steam Duel Intelligence' },
                    timestamp: new Date().toISOString(),
                  },
                ],
              },
            }),
          };
        }

        const { embeds, components } = buildDuelEmbedPayload(comparison, summaryA, summaryB, 1);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              embeds,
              components,
            },
          }),
        };
      } catch (err) {
        console.error('Error executing /steam-duel:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createEphemeralEmbed('Operation Failed', 'Unable to complete Steam library duel.', PALETTE.DANGER)),
        };
      }
    }

    // Command: /game-match <target1> <target2> [filter]
    if (name === 'game-match') {
      const target1Opt = options?.find((opt) => opt.name === 'target1')?.value?.trim();
      const target2Opt = options?.find((opt) => opt.name === 'target2')?.value?.trim();
      const filterOpt = options?.find((opt) => opt.name === 'filter')?.value?.trim() || 'coop';
      const filterMode = filterOpt === 'all' ? 'all' : 'coop';

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

      const authLoginUrl = AUTH_CALLBACK_URL ? AUTH_CALLBACK_URL.replace('/callback', '/login') : '';

      try {
        const [res1, res2] = await Promise.all([
          resolveSteamTarget(target1Opt, userId || '', docClient, TABLE_NAME, STEAM_API_KEY),
          resolveSteamTarget(target2Opt, userId || '', docClient, TABLE_NAME, STEAM_API_KEY),
        ]);

        if (res1.unlinked) {
          return buildTargetUnlinkedResponse(res1, authLoginUrl);
        }

        if (res2.unlinked) {
          return buildTargetUnlinkedResponse(res2, authLoginUrl);
        }

        if (res1.error) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Steam Resolution Failed', res1.error, PALETTE.WARNING)),
          };
        }

        if (res2.error) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Steam Resolution Failed', res2.error, PALETTE.WARNING)),
          };
        }

        const steamIdA = res1.steamId;
        const steamIdB = res2.steamId;

        if (steamIdA === steamIdB) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Invalid Match Pairing',
                'Cannot match a Steam library against itself. Please specify two different players or profiles.',
                PALETTE.WARNING
              )
            ),
          };
        }

        const [summaryA, summaryB, matchResult] = await Promise.all([
          getPlayerSummary(steamIdA, STEAM_API_KEY),
          getPlayerSummary(steamIdB, STEAM_API_KEY),
          findMatchingGames(steamIdA, steamIdB, filterMode, STEAM_API_KEY),
        ]);

        if (!summaryA || !summaryB) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Profile Inaccessible', 'Unable to retrieve Steam summary data for one or both profiles.', PALETTE.WARNING)
            ),
          };
        }

        if (!matchResult?.success) {
          if (matchResult?.error === 'PRIVATE_LIBRARY') {
            const privateName =
              matchResult.privatePlayer === 'A'
                ? summaryA.personaName
                : matchResult.privatePlayer === 'B'
                ? summaryB.personaName
                : 'Both players';

            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                  embeds: [
                    {
                      title: 'Steam Library Private ❖ Match Inaccessible',
                      description: `Cannot find matching games: **${privateName}** has their Steam game library set to **Private**.\n\nOwned games must be set to **Public** in Steam Privacy Settings to allow library cross-referencing.`,
                      color: PALETTE.WARNING,
                      footer: { text: 'zT Radar • Steam Match Intelligence' },
                      timestamp: new Date().toISOString(),
                    },
                  ],
                },
              }),
            };
          }

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Match Failed', 'An error occurred while cross-referencing libraries.', PALETTE.DANGER)),
          };
        }

        if (matchResult.matchingGames.length === 0) {
          const filterDesc = filterMode === 'coop' ? 'co-op or multiplayer ' : '';
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                embeds: [
                  {
                    author: {
                      name: `${summaryA.personaName} ✖ ${summaryB.personaName} • Game Match`,
                      icon_url: summaryA.avatarUrl || undefined,
                    },
                    title: 'Shared Game Discovery',
                    description: `No shared ${filterDesc}titles found between **${summaryA.personaName}** (${matchResult.countA} games) and **${summaryB.personaName}** (${matchResult.countB} games).${filterMode === 'coop' ? '\n\nTry running `/game-match` with filter set to **All Shared Games** to inspect single-player overlaps.' : ''}`,
                    color: 0x5865f2,
                    thumbnail: summaryB.avatarUrl ? { url: summaryB.avatarUrl } : undefined,
                    footer: { text: 'zT Radar • Steam Co-op Discovery' },
                    timestamp: new Date().toISOString(),
                  },
                ],
              },
            }),
          };
        }

        const { embeds, components } = buildGameMatchEmbedPayload(matchResult, summaryA, summaryB, 1, filterMode);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              embeds,
              components,
            },
          }),
        };
      } catch (err) {
        console.error('Error executing /game-match:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createEphemeralEmbed('Operation Failed', 'Unable to complete Steam game match discovery.', PALETTE.DANGER)),
        };
      }
    }

    // Command: /steam-backlog [target]
    if (name === 'steam-backlog') {
      const targetOpt = options?.find((opt) => opt.name === 'target')?.value?.trim();

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

      const authLoginUrl = AUTH_CALLBACK_URL ? AUTH_CALLBACK_URL.replace('/callback', '/login') : '';

      try {
        const res = await resolveSteamTarget(targetOpt, userId || '', docClient, TABLE_NAME, STEAM_API_KEY);
        if (res.unlinked) {
          return buildTargetUnlinkedResponse(res, authLoginUrl);
        }
        if (res.error) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Steam Resolution Failed', res.error, PALETTE.WARNING)
            ),
          };
        }
        const steamId = res.steamId;

        let preferredCurrency = 'USD';
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
          preferredCurrency = userConfigResult.Items?.[0]?.preferred_currency || 'USD';
        } catch {
          // fallback to USD
        }

        const [summary, telemetry] = await Promise.all([
          getPlayerSummary(steamId, STEAM_API_KEY),
          calculateBacklogTelemetry(steamId, STEAM_API_KEY, preferredCurrency),
        ]);

        if (!summary) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Profile Inaccessible', 'Unable to retrieve Steam summary data for profile.', PALETTE.WARNING)
            ),
          };
        }

        if (!telemetry?.success) {
          if (telemetry?.error === 'PRIVATE_LIBRARY') {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                  embeds: [
                    {
                      title: 'Steam Library Private ❖ Backlog Inaccessible',
                      description: `Cannot analyze backlog telemetry: **${summary.personaName}** has their Steam game library set to **Private**.\n\nOwned games must be set to **Public** in Steam Privacy Settings to inspect library telemetry.`,
                      color: PALETTE.WARNING,
                      footer: { text: 'zT Radar • Steam Backlog Intelligence' },
                      timestamp: new Date().toISOString(),
                    },
                  ],
                },
              }),
            };
          }

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createEphemeralEmbed('Backlog Analysis Failed', 'An error occurred while analyzing library backlog.', PALETTE.DANGER)),
          };
        }

        const { embed, components } = await buildBacklogEmbedPayload(telemetry, summary, 1);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              embeds: [embed],
              components,
            },
          }),
        };
      } catch (err) {
        console.error('Error executing /steam-backlog:', err);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createEphemeralEmbed('Operation Failed', 'Unable to analyze Steam library backlog.', PALETTE.DANGER)),
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
      const subCommand: DiscordInteractionOption | undefined = options?.[0];
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
        const gameOption = subCommand?.options?.find((opt) => opt.name === 'game');
        const targetPriceOption = subCommand?.options?.find((opt) => opt.name === 'target_price');

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
        const gameOption = subCommand?.options?.find((opt) => opt.name === 'game');
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
              ProjectionExpression: 'PK, SK',
            })
          );

          const items = queryResult.Items || [];

          if (items.length === 0) {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                createEphemeralEmbed(
                  'Wishlist Already Empty',
                  'You have no monitored titles in your wishlist to remove.',
                  PALETTE.NEUTRAL
                )
              ),
            };
          }

          // Batch delete items in parallel chunks of 25 using BatchWriteCommand
          const BATCH_SIZE = 25;
          const deleteChunks = [];
          for (let i = 0; i < items.length; i += BATCH_SIZE) {
            deleteChunks.push(items.slice(i, i + BATCH_SIZE));
          }

          await Promise.all(
            deleteChunks.map((chunk) =>
              docClient.send(
                new BatchWriteCommand({
                  RequestItems: {
                    [TABLE_NAME]: chunk.map((item) => ({
                      DeleteRequest: {
                        Key: {
                          PK: item.PK,
                          SK: item.SK,
                        },
                      },
                    })),
                  },
                })
              )
            )
          );

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed(
                'Wishlist Cleared ❖',
                `Successfully removed **${items.length}** tracked title${items.length === 1 ? '' : 's'} from your monitored wishlist.`,
                PALETTE.SUCCESS
              )
            ),
          };
        } catch (error) {
          console.error('Error clearing wishlist items:', error);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              createEphemeralEmbed('Clear Error', 'Failed to wipe your monitored wishlist.', PALETTE.DANGER)
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

          const userConfig = userConfigResult.Items?.[0] || null;
          const pageData = buildWishlistPagePayload(items, userConfig, 1);

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: RESPONSE_TYPES.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: MESSAGE_FLAGS.EPHEMERAL,
                ...pageData,
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

        const minDiscountOption = subCommand?.options?.find((opt) => opt.name === 'min_discount');
        const minRatingOption = subCommand?.options?.find((opt) => opt.name === 'min_rating');

        const userMinDiscount = minDiscountOption?.value !== undefined ? Math.max(10, Math.min(100, Number(minDiscountOption.value))) : 70;
        const userMinRating = minRatingOption?.value !== undefined ? Math.max(0, Math.min(100, Number(minRatingOption.value))) : null;

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
              ProjectionExpression: 'SK, external_game_id',
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

          // Resolve game titles for untracked items via memory directory and bounded Steam appdetails API
          const untrackedAppIds = untrackedItems.map((entry) => entry.appId);
          const titleMap = await resolveSteamAppTitles(untrackedAppIds, 1200);

          const now = new Date().toISOString();
          const itemsToInsert = [];
          const seenSKs = new Set();

          for (const entry of untrackedItems) {
            const title = titleMap.get(entry.appId) || `Steam App #${entry.appId}`;
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

          // Persist items in parallel chunks of 25 using BatchWriteCommand
          const BATCH_SIZE = 25;
          const writeChunks = [];
          for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
            writeChunks.push(itemsToInsert.slice(i, i + BATCH_SIZE));
          }

          await Promise.all(
            writeChunks.map((chunk) =>
              docClient.send(
                new BatchWriteCommand({
                  RequestItems: {
                    [TABLE_NAME]: chunk.map((item) => {
                      const putItem: DynamoDbWishlistItem = {
                        PK: `USER#${userId}`,
                        SK: item.sk,
                        game_title: item.title,
                        external_game_id: `steam:${item.appId}`,
                        target_price: null,
                        min_discount: userMinDiscount,
                        alert_all_time_low: true,
                        alert_free: true,
                        alert_steep_discount: true,
                        user_id: userId || '',
                        created_at: now,
                      };
                      if (userMinRating !== null) {
                        putItem.min_rating = userMinRating;
                      }
                      return {
                        PutRequest: {
                          Item: putItem,
                        },
                      };
                    }),
                  },
                })
              )
            )
          );

          const importedCount = itemsToInsert.length;
          const importedTitles = itemsToInsert.slice(0, 10).map((e) => e.title);

          // Build summary embed fields
          const summaryLines = [
            `▸ Total Steam wishlist entries processed: **${targetItems.length}**${wasCapped ? ` (of ${totalWishlistCount} total)` : ''}`,
            `▸ Newly imported to radar: **${importedCount}**`,
            `▸ Existing tracked items preserved: **${preservedCount}**`,
            `▸ Minimum discount threshold: **≥ -${userMinDiscount}% off**`,
          ];

          if (userMinRating !== null) {
            summaryLines.push(`▸ Minimum review score: **≥ ${userMinRating}/100**`);
          }

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
              ? `Successfully synchronized top 100 most recently added wishlist titles into the zT Radar tracking registry.\nImported titles will trigger alerts when promotions reach at least -${userMinDiscount}% off or on 100% free giveaways.`
              : `Successfully synchronized your Steam wishlist into the zT Radar tracking registry.\nImported titles will trigger alerts when promotions reach at least -${userMinDiscount}% off or on 100% free giveaways.`,
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