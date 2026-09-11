/**
 * Steam OpenID 2.0 Integration Utility
 *
 * Implements Valve's OpenID 2.0 authentication flow using native Node.js modules only.
 * Zero external dependencies — uses node:crypto and global fetch (Node.js 22.x).
 *
 * Flow:
 *  1. generateStateToken()     — creates a CSRF state token and persists it to DynamoDB.
 *  2. buildSteamLoginUrl()     — constructs the redirect URL to Steam's OpenID endpoint.
 *  3. verifyOpenIdAssertion()  — validates Steam's callback via check_authentication handshake.
 *  4. buildUnlinkedAccountEmbed() — returns a Link Button embed payload for unlinked users.
 */

import { randomBytes } from 'node:crypto';
import { PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Steam OpenID 2.0 provider endpoint
const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

// Regex to extract SteamID64 from the claimed_id URL
const STEAM_CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

// State token TTL: 10 minutes in seconds
const STATE_TOKEN_TTL_SECONDS = 600;

const PALETTE_STEAM_ACCENT = 0x66c0f4;

/**
 * Generates a cryptographically secure 64-char hex state token and persists it to DynamoDB.
 *
 * @param userId - The Discord user ID initiating the OAuth flow.
 * @param docClient - DynamoDB document client.
 * @param tableName - DynamoDB table name.
 * @returns The generated state token hex string.
 */
export async function generateStateToken(
  userId: string,
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_TOKEN_TTL_SECONDS;

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `USER#${userId}`,
        SK: 'STEAM_OAUTH_STATE',
        state_token: token,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      },
    })
  );

  return token;
}

/**
 * Validates a state token against DynamoDB and cleans it up after validation.
 *
 * @param userId - The Discord user ID.
 * @param token - The state token to validate.
 * @param docClient - DynamoDB document client.
 * @param tableName - DynamoDB table name.
 * @returns True if the token is valid and not expired.
 */
export async function validateAndConsumeStateToken(
  userId: string,
  token: string,
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<boolean> {
  let item: { state_token?: string; expires_at?: number } | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'STEAM_OAUTH_STATE',
        },
      })
    );
    item = result?.Item as { state_token?: string; expires_at?: number } | undefined;
  } catch (err) {
    console.error('Error retrieving state token from DynamoDB:', err);
    return false;
  }
  if (!item) return false;

  const now = Math.floor(Date.now() / 1000);
  const isValid = item.state_token === token && (item.expires_at ?? 0) > now;

  // Always delete the token after inspection to enforce single-use semantics
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'STEAM_OAUTH_STATE',
        },
      })
    );
  } catch (err) {
    console.error('Error deleting consumed state token:', err);
  }

  return isValid;
}

/**
 * Constructs the full Steam OpenID 2.0 login redirect URL.
 *
 * @param stateToken - The CSRF state token.
 * @param baseCallbackUrl - The public HTTPS URL of the auth callback route.
 * @param userId - The Discord user ID to embed in the return_to URL for callback lookup.
 * @returns The fully encoded Steam OpenID redirect URL.
 */
export function buildSteamLoginUrl(
  stateToken: string,
  baseCallbackUrl: string,
  userId: string,
): string {
  // Embed both user_id and state into return_to so the callback handler can resolve the user
  const returnTo = `${baseCallbackUrl}?user_id=${encodeURIComponent(userId)}&state=${encodeURIComponent(stateToken)}`;

  // Derive realm from the callback base URL (scheme + host)
  const callbackParsed = new URL(baseCallbackUrl);
  const realm = `${callbackParsed.protocol}//${callbackParsed.host}/`;

  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });

  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/**
 * Parses the SteamID64 from an OpenID claimed_id URL.
 *
 * @param claimedId - The `openid.claimed_id` value from Steam's callback.
 * @returns The 17-digit SteamID64 string, or null if invalid.
 */
export function parseSteamIdFromClaimedId(claimedId: string): string | null {
  if (!claimedId || typeof claimedId !== 'string') return null;
  const match = claimedId.match(STEAM_CLAIMED_ID_PATTERN);
  return match ? match[1] : null;
}

/**
 * Verifies a Steam OpenID 2.0 callback assertion using the check_authentication handshake.
 *
 * @param params - Query parameters from Steam's callback URL.
 * @returns Validated SteamID64 string, or null on failure.
 */
export async function verifyOpenIdAssertion(
  params: Record<string, string>,
): Promise<string | null> {
  // Step 1: Must be a positive assertion
  if (params['openid.mode'] !== 'id_res') {
    console.warn('OpenID assertion rejected: mode is not id_res, got:', params['openid.mode']);
    return null;
  }

  // Step 2: Extract and validate the claimed Steam ID
  const claimedId = params['openid.claimed_id'];
  const steamId64 = parseSteamIdFromClaimedId(claimedId);
  if (!steamId64) {
    console.warn('OpenID assertion rejected: invalid claimed_id format:', claimedId);
    return null;
  }

  // Step 3: Reconstruct verification payload — same params but mode changed to check_authentication
  const verificationParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    verificationParams.set(key, key === 'openid.mode' ? 'check_authentication' : value);
  }

  // Step 4: POST to Steam's OpenID endpoint for server-side signature validation
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2400);

  try {
    const response = await fetch(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verificationParams.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error('Steam check_authentication request failed with status:', response.status);
      return null;
    }

    const responseText = await response.text();

    // Steam responds with a plain-text key:value format; look for "is_valid:true"
    if (!responseText.includes('is_valid:true')) {
      console.warn('Steam check_authentication returned is_valid:false');
      return null;
    }

    return steamId64;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('Steam check_authentication request timed out');
    } else {
      console.error('Error during Steam OpenID check_authentication:', err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds a Discord interaction response payload prompting the user to link their Steam account.
 * Includes a Discord Link Button (Type 2, Style 5) pointing to the lightweight login URL.
 *
 * @param userId - The Discord user ID requesting the link.
 * @param loginUrl - The lightweight login initiation URL (must be <= 512 characters).
 * @returns A complete Discord interaction response body ready to be JSON.stringify'd.
 */
export function buildUnlinkedAccountEmbed(userId: string, loginUrl: string): object {
  if (!loginUrl || typeof loginUrl !== 'string' || loginUrl.length > 512) {
    throw new Error(
      `Login URL exceeds Discord 512-char limit for Link Buttons: ${loginUrl ? loginUrl.length : 'invalid'} chars`
    );
  }

  return {
    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
    data: {
      flags: 64, // EPHEMERAL
      embeds: [
        {
          title: 'Steam Account Not Linked ❖',
          description: [
            'No Steam account is currently linked to your Discord profile on zT Radar.',
            '',
            '▸ Click **Link via Valve** below to authenticate through the official Steam OpenID 2.0 portal.',
            '▸ Your identity is verified cryptographically by Valve — no passwords are shared with zT Radar.',
            '▸ Alternatively, use `/steam-link <target>` with your SteamID64, profile URL, or vanity name for manual linking.',
          ].join('\n'),
          color: PALETTE_STEAM_ACCENT,
          fields: [
            {
              name: 'What gets stored?',
              value: [
                '└─ Your verified **SteamID64** (17-digit numeric identifier).',
                '└─ Your public **persona name** and **avatar URL**.',
                '└─ No passwords, tokens, or private Steam data.',
              ].join('\n'),
              inline: false,
            },
          ],
          footer: {
            text: 'zT Radar • Steam Ecosystem Intelligence',
          },
          timestamp: new Date().toISOString(),
        },
      ],
      components: [
        {
          type: 1, // Action Row
          components: [
            {
              type: 2, // Button
              style: 5, // Link
              label: 'Link via Valve',
              url: loginUrl,
            },
          ],
        },
      ],
    },
  };
}
