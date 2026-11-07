import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  generateStateToken,
  validateAndConsumeStateToken,
  buildSteamLoginUrl,
  parseSteamIdFromClaimedId,
  buildUnlinkedAccountEmbed,
  validateWebRedirectUri,
  generateWebAuthState,
  consumeWebAuthState,
  buildSteamWebLoginUrl,
  signWebSessionToken,
  verifyWebSessionToken,
  buildWebRedirectUrl,
} from '../../src/utils/steamOpenId.js';

describe('Steam OpenID 2.0 Integration Utility', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const mockUserId = '123456789012345678';
  const mockTable = 'zTRadarTable';

  beforeEach(() => {
    ddbMock.reset();
  });

  afterEach(() => {
    ddbMock.restore();
  });

  describe('CSRF State Token Generation & Entropy', () => {
    it('should generate a 64-character lowercase hex token (32 bytes entropy) and persist to DynamoDB', async () => {
      ddbMock.on(PutCommand).resolves({});

      const token = await generateStateToken(mockUserId, ddbMock, mockTable);

      expect(token).toBeTypeOf('string');
      expect(token.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(1);
      const putItem = putCalls[0].args[0].input.Item;
      expect(putItem.PK).toBe(`USER#${mockUserId}`);
      expect(putItem.SK).toBe('STEAM_OAUTH_STATE');
      expect(putItem.state_token).toBe(token);
      expect(putItem.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should validate and consume state token in single-use semantics', async () => {
      const validToken = 'a'.repeat(64);
      const futureExpiry = Math.floor(Date.now() / 1000) + 300;

      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: `USER#${mockUserId}`,
          SK: 'STEAM_OAUTH_STATE',
          state_token: validToken,
          expires_at: futureExpiry,
        },
      });
      ddbMock.on(DeleteCommand).resolves({});

      const isValid = await validateAndConsumeStateToken(mockUserId, validToken, ddbMock, mockTable);
      expect(isValid).toBe(true);

      // Verify deletion was executed to prevent reuse
      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0].args[0].input.Key).toEqual({
        PK: `USER#${mockUserId}`,
        SK: 'STEAM_OAUTH_STATE',
      });
    });

    it('should reject expired or mismatched state token', async () => {
      const validToken = 'a'.repeat(64);
      const expiredTime = Math.floor(Date.now() / 1000) - 10;

      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: `USER#${mockUserId}`,
          SK: 'STEAM_OAUTH_STATE',
          state_token: validToken,
          expires_at: expiredTime,
        },
      });
      ddbMock.on(DeleteCommand).resolves({});

      const isValid = await validateAndConsumeStateToken(mockUserId, validToken, ddbMock, mockTable);
      expect(isValid).toBe(false);
    });
  });

  describe('buildSteamLoginUrl', () => {
    const mockCallbackUrl = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/auth/steam/callback';
    const mockToken = 'b'.repeat(64);

    it('should construct valid OpenID 2.0 parameters pointing to Steam endpoint', () => {
      const loginUrl = buildSteamLoginUrl(mockToken, mockCallbackUrl, mockUserId);

      expect(loginUrl.startsWith('https://steamcommunity.com/openid/login?')).toBe(true);

      const parsedUrl = new URL(loginUrl);
      const params = parsedUrl.searchParams;

      expect(params.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
      expect(params.get('openid.mode')).toBe('checkid_setup');
      expect(params.get('openid.identity')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
      expect(params.get('openid.claimed_id')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
      expect(params.get('openid.realm')).toBe('https://abc123.execute-api.us-east-1.amazonaws.com/');

      const returnTo = params.get('openid.return_to');
      expect(returnTo).toBeDefined();
      expect(returnTo).toContain(`user_id=${mockUserId}`);
      expect(returnTo).toContain(`state=${mockToken}`);
    });
  });

  describe('parseSteamIdFromClaimedId', () => {
    it('should extract 17-digit numeric SteamID64 from valid claimed_id', () => {
      const validClaimedId = 'https://steamcommunity.com/openid/id/76561198012345678';
      const steamId = parseSteamIdFromClaimedId(validClaimedId);

      expect(steamId).toBe('76561198012345678');
    });

    it('should return null for malformed or non-Steam claimed_id URLs', () => {
      const testCases = [
        'https://steamcommunity.com/openid/id/12345',           // too short (<17 digits)
        'https://steamcommunity.com/openid/id/7656119801234567890', // too long (>17 digits)
        'https://evil.com/openid/id/76561198012345678',         // wrong domain
        'https://steamcommunity.com/openid/id/abcdefg12345678', // non-numeric
        '',                                                     // empty string
        null,                                                   // null
        undefined,                                              // undefined
        12345678901234567,                                      // number type
      ];

      for (const testCase of testCases) {
        expect(parseSteamIdFromClaimedId(testCase)).toBeNull();
      }
    });
  });

  describe('buildUnlinkedAccountEmbed', () => {
    const mockLoginUrl = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/auth/steam/login?user_id=123';

    it('should build ephemeral response with Link button strictly <= 512 chars', () => {
      const response = buildUnlinkedAccountEmbed(mockUserId, mockLoginUrl);

      expect(response.type).toBe(4);
      expect(response.data.flags).toBe(64);
      expect(Array.isArray(response.data.embeds)).toBe(true);

      const actionRow = response.data.components[0];
      expect(actionRow.type).toBe(1);
      const button = actionRow.components[0];
      expect(button.type).toBe(2);
      expect(button.style).toBe(5);
      expect(button.url).toBe(mockLoginUrl);
      expect(button.url.length).toBeLessThanOrEqual(512);
      expect('custom_id' in button).toBe(false);
    });

    it('should throw an error if button URL exceeds 512 characters', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(510);
      expect(() => buildUnlinkedAccountEmbed(mockUserId, longUrl)).toThrow(/512/);
    });
  });
});

describe('Steam OpenID 2.0 Web Flow Utilities', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const table = 'zTRadarTable';
  const callback = 'https://api.example.com/prod/auth/steam/callback';

  beforeEach(() => {
    ddbMock.reset();
  });

  describe('validateWebRedirectUri', () => {
    it('accepts localhost and loopback dev origins', () => {
      expect(validateWebRedirectUri('http://localhost:5173')).toBe('http://localhost:5173/');
      expect(validateWebRedirectUri('http://127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
    });

    it('accepts HTTPS pages.dev origins and strips fragments', () => {
      expect(validateWebRedirectUri('https://zt-radar.pages.dev/#x')).toBe('https://zt-radar.pages.dev/');
    });

    it('accepts the configured WEB_APP_URL origin', () => {
      expect(validateWebRedirectUri('https://radar.example.org/home', 'https://radar.example.org')).toBe(
        'https://radar.example.org/home',
      );
    });

    it('rejects malicious or malformed origins', () => {
      const bad = [
        'https://evil.com',
        'http://zt-radar.pages.dev',
        'https://pages.dev.evil.com',
        'https://evilpages.dev',
        'https://zt-radar.pages.dev@evil.com',
        'https://user:pw@zt-radar.pages.dev',
        'http://localhost:5174',
        'javascript:alert(1)',
        'not a url',
        '',
        undefined,
      ];
      for (const uri of bad) {
        expect(validateWebRedirectUri(uri)).toBeNull();
      }
      expect(validateWebRedirectUri('https://evil.com', 'https://radar.example.org')).toBeNull();
    });
  });

  describe('Web auth state persistence', () => {
    it('persists WEB_AUTH state with 600s TTL', async () => {
      ddbMock.on(PutCommand).resolves({});
      const before = Math.floor(Date.now() / 1000);
      const token = await generateWebAuthState('http://localhost:5173/', ddbMock, table);
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
      const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
      expect(item.PK).toBe('WEB_AUTH#' + token);
      expect(item.SK).toBe('OPENID_STATE');
      expect(item.mode).toBe('web');
      expect(item.redirect_uri).toBe('http://localhost:5173/');
      expect(item.expires_at).toBeGreaterThanOrEqual(before + 599);
      expect(item.expires_at).toBeLessThanOrEqual(before + 602);
    });

    it('atomically consumes a valid state via DeleteItem ALL_OLD', async () => {
      const state = 'a'.repeat(64);
      ddbMock.on(DeleteCommand).resolves({
        Attributes: {
          state_token: state,
          redirect_uri: 'http://localhost:5173/',
          mode: 'web',
          expires_at: Math.floor(Date.now() / 1000) + 100,
        },
      });
      const result = await consumeWebAuthState(state, ddbMock, table);
      expect(result).toEqual({ redirectUri: 'http://localhost:5173/' });
      expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.ReturnValues).toBe('ALL_OLD');
    });

    it('rejects missing, expired, and malformed states', async () => {
      const state = 'b'.repeat(64);
      ddbMock.on(DeleteCommand).resolves({});
      expect(await consumeWebAuthState(state, ddbMock, table)).toBeNull();

      ddbMock.on(DeleteCommand).resolves({
        Attributes: { state_token: state, redirect_uri: 'http://localhost:5173/', mode: 'web', expires_at: 1 },
      });
      expect(await consumeWebAuthState(state, ddbMock, table)).toBeNull();

      expect(await consumeWebAuthState('short', ddbMock, table)).toBeNull();
    });
  });

  describe('buildSteamWebLoginUrl', () => {
    it('embeds mode=web and state in return_to', () => {
      const url = new URL(buildSteamWebLoginUrl('c'.repeat(64), callback));
      expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
      const returnTo = new URL(url.searchParams.get('openid.return_to'));
      expect(returnTo.searchParams.get('mode')).toBe('web');
      expect(returnTo.searchParams.get('state')).toBe('c'.repeat(64));
      expect(returnTo.searchParams.get('user_id')).toBeNull();
    });
  });

  describe('Signed session token', () => {
    const profile = { steamId64: '76561198000000000', personaName: 'Tester', avatarUrl: 'https://a/b.jpg' };

    it('round-trips with HMAC-SHA256 and exposes iat/exp', () => {
      const token = signWebSessionToken(profile, 'secret');
      const payload = verifyWebSessionToken(token, 'secret');
      expect(payload).toMatchObject(profile);
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it('rejects tampered payloads, wrong secrets, and expired tokens', () => {
      const token = signWebSessionToken(profile, 'secret');
      const [body, sig] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...profile, steamId64: '76561198999999999', iat: 1, exp: 9999999999 })).toString('base64url');
      expect(verifyWebSessionToken(forged + '.' + sig, 'secret')).toBeNull();
      expect(verifyWebSessionToken(body + '.' + sig, 'other')).toBeNull();
      expect(verifyWebSessionToken(signWebSessionToken(profile, 'secret', -10), 'secret')).toBeNull();
    });
  });

  describe('buildWebRedirectUrl', () => {
    it('uses URL fragments for success and error', () => {
      expect(buildWebRedirectUrl('http://localhost:5173/', { signedPayload: 'a.b' })).toBe('http://localhost:5173/#steam_auth=a.b');
      expect(buildWebRedirectUrl('http://localhost:5173/', { error: 'verification_failed' })).toBe(
        'http://localhost:5173/#steam_auth_error=verification_failed',
      );
    });
  });
});