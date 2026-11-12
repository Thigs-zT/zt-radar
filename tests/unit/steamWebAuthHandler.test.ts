import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  verifyWebSessionToken,
  validateWebRedirectUri,
  buildSteamWebLoginUrl,
} from '../../src/utils/steamOpenId.js';

vi.mock('../../src/utils/steamWeb.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getPlayerSummary: vi.fn() };
});

const STEAM_ID = '76561198000000000';
const STATE = 'd'.repeat(64);
const CALLBACK = 'https://api.example.com/prod/auth/steam/callback';

describe('Steam OpenID web login handler routes', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  let handler: (event: unknown) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
  let getPlayerSummary: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ddbMock.reset();
    vi.resetModules();
    vi.stubEnv('TABLE_NAME', 'zTRadarTable');
    vi.stubEnv('AUTH_CALLBACK_URL', CALLBACK);
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'test-public-key');
    vi.stubEnv('STEAM_API_KEY', 'test-steam-key');
    vi.stubEnv('WEB_APP_URL', '');
    ({ handler } = (await import('../../src/handlers/discordBot.js')) as never);
    ({ getPlayerSummary } = (await import('../../src/utils/steamWeb.js')) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const loginEvent = (query: string) => ({
    requestContext: { http: { method: 'GET', path: '/auth/steam/login' } },
    rawPath: '/auth/steam/login',
    rawQueryString: query,
  });

  const callbackEvent = (query: string) => ({
    requestContext: { http: { method: 'GET', path: '/auth/steam/callback' } },
    rawPath: '/auth/steam/callback',
    rawQueryString: query,
  });

  const openIdQuery = (mode = 'id_res') =>
    new URLSearchParams({
      mode: 'web',
      state: STATE,
      'openid.mode': mode,
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
      'openid.sig': 'sig',
    }).toString();

  const storeWebState = (redirectUri = 'http://localhost:5173/') =>
    ddbMock.on(DeleteCommand).resolves({
      Attributes: {
        state_token: STATE,
        redirect_uri: redirectUri,
        mode: 'web',
        expires_at: Math.floor(Date.now() / 1000) + 300,
      },
    });

  describe('GET /auth/steam/login', () => {
    it.each([
      'http://localhost:5173',
      'https://zt-radar.pages.dev/app',
      'https://ztradar.app',
      'https://www.ztradar.app/app',
    ])('redirects to Steam for %s', async (uri) => {
      ddbMock.on(PutCommand).resolves({});
      const res = await handler(loginEvent(new URLSearchParams({ mode: 'web', redirect_uri: uri }).toString()));
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers!.Location);
      expect(location.origin + location.pathname).toBe('https://steamcommunity.com/openid/login');
      const returnTo = new URL(location.searchParams.get('openid.return_to')!);
      expect(returnTo.searchParams.get('mode')).toBe('web');
      const state = returnTo.searchParams.get('state')!;
      const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
      expect(item.PK).toBe(`WEB_AUTH#${state}`);
      expect(item.SK).toBe('OPENID_STATE');
      expect(item.mode).toBe('web');
    });

    it('uses ztradar.app realm and callback when AUTH_CALLBACK_URL targets the custom domain', async () => {
      vi.resetModules();
      vi.stubEnv('AUTH_CALLBACK_URL', 'https://ztradar.app/auth/steam/callback');
      const { handler: customDomainHandler } = (await import('../../src/handlers/discordBot.js')) as {
        handler: typeof handler;
      };
      ddbMock.on(PutCommand).resolves({});

      const res = await customDomainHandler(
        loginEvent(new URLSearchParams({ mode: 'web', redirect_uri: 'https://ztradar.app' }).toString()),
      );
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers!.Location);
      expect(location.searchParams.get('openid.realm')).toBe('https://ztradar.app/');
      const returnTo = location.searchParams.get('openid.return_to')!;
      expect(returnTo).toMatch(/^https:\/\/ztradar\.app\/auth\/steam\/callback\?mode=web&state=[0-9a-f]{64}$/);
    });

    it('rejects a malicious redirect_uri with 400 and writes nothing', async () => {
      const res = await handler(loginEvent(new URLSearchParams({ mode: 'web', redirect_uri: 'https://evil.com' }).toString()));
      expect(res.statusCode).toBe(400);
      expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
    });

    it('preserves the Discord user_id flow when mode is not web', async () => {
      ddbMock.on(PutCommand).resolves({});
      const res = await handler(loginEvent('user_id=123456789012345678'));
      expect(res.statusCode).toBe(302);
      const returnTo = new URL(new URL(res.headers!.Location).searchParams.get('openid.return_to')!);
      expect(returnTo.searchParams.get('user_id')).toBe('123456789012345678');
      expect(returnTo.searchParams.get('mode')).toBeNull();
      expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!.PK).toBe('USER#123456789012345678');
    });

    it('still returns 400 without user_id when not in web mode', async () => {
      const res = await handler(loginEvent(''));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /auth/steam/callback', () => {
    it('verifies, enriches the profile, signs the session, and redirects with a fragment', async () => {
      storeWebState();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'ns:x\nis_valid:true\n' }));
      getPlayerSummary.mockResolvedValue({ personaName: 'Gabe', avatarUrl: 'https://cdn/a.jpg', profileUrl: 'https://steamcommunity.com/id/gabe' });

      const res = await handler(callbackEvent(openIdQuery()));
      expect(res.statusCode).toBe(302);
      const location = res.headers!.Location;
      expect(location.startsWith('http://localhost:5173/#steam_auth=')).toBe(true);
      expect(location.includes('?')).toBe(false);

      const token = decodeURIComponent(location.split('#steam_auth=')[1]);
      const payload = verifyWebSessionToken(token, 'test-public-key');
      expect(payload).toMatchObject({ steamId64: STEAM_ID, personaName: 'Gabe', avatarUrl: 'https://cdn/a.jpg' });
      expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ PK: `WEB_AUTH#${STATE}`, SK: 'OPENID_STATE' });
      expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
    });

    it('falls back to "Steam User" when the profile lookup fails', async () => {
      storeWebState();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'is_valid:true' }));
      getPlayerSummary.mockRejectedValue(new Error('boom'));

      const res = await handler(callbackEvent(openIdQuery()));
      const token = decodeURIComponent(res.headers!.Location.split('#steam_auth=')[1]);
      expect(verifyWebSessionToken(token, 'test-public-key')).toMatchObject({ steamId64: STEAM_ID, personaName: 'Steam User' });
    });

    it('redirects with steam_auth_error when Valve rejects the assertion', async () => {
      storeWebState();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'is_valid:false' }));
      const res = await handler(callbackEvent(openIdQuery()));
      expect(res.statusCode).toBe(302);
      expect(res.headers!.Location).toBe('http://localhost:5173/#steam_auth_error=verification_failed');
    });

    it('redirects with steam_auth_error when the user cancels', async () => {
      storeWebState();
      const res = await handler(callbackEvent(openIdQuery('cancel')));
      expect(res.headers!.Location).toBe('http://localhost:5173/#steam_auth_error=verification_failed');
    });

    it('returns 403 without redirecting when the state is unknown or already consumed', async () => {
      ddbMock.on(DeleteCommand).resolves({});
      const res = await handler(callbackEvent(openIdQuery()));
      expect(res.statusCode).toBe(403);
      expect(res.headers!.Location).toBeUndefined();
    });

    it('preserves the Discord user_id callback flow', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { state_token: STATE, expires_at: Math.floor(Date.now() / 1000) + 300 },
      });
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'is_valid:true' }));
      getPlayerSummary.mockResolvedValue({ personaName: 'Gabe', avatarUrl: '' });

      const query = new URLSearchParams({
        user_id: '123456789012345678',
        state: STATE,
        'openid.mode': 'id_res',
        'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
      }).toString();
      const res = await handler(callbackEvent(query));
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Steam Account Linked');
      const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(update.Key).toEqual({ PK: 'USER#123456789012345678', SK: 'CONFIG' });
    });
  });

  describe('Custom domain origin & OpenID realm (ztradar.app)', () => {
    it('allows https://ztradar.app and subdomains via validateWebRedirectUri', () => {
      expect(validateWebRedirectUri('https://ztradar.app')).toBe('https://ztradar.app/');
      expect(validateWebRedirectUri('https://www.ztradar.app')).toBe('https://www.ztradar.app/');
      expect(validateWebRedirectUri('https://ztradar.app/wishlist?view=compact#hash')).toBe(
        'https://ztradar.app/wishlist?view=compact',
      );
      expect(validateWebRedirectUri('https://www.ztradar.app/auth#frag')).toBe('https://www.ztradar.app/auth');
    });

    it('rejects insecure or lookalike ztradar.app origins', () => {
      for (const badUri of [
        'http://ztradar.app',
        'http://www.ztradar.app',
        'https://evilztradar.app',
        'https://ztradar.app.evil.com',
        'https://.ztradar.app',
        'https://user:pass@ztradar.app',
      ]) {
        expect(validateWebRedirectUri(badUri)).toBeNull();
      }
    });

    it('generates ztradar.app realm and callback in buildSteamWebLoginUrl', () => {
      const authCallbackUrl = 'https://ztradar.app/auth/steam/callback';
      const loginUrl = new URL(buildSteamWebLoginUrl(STATE, authCallbackUrl));

      expect(loginUrl.origin + loginUrl.pathname).toBe('https://steamcommunity.com/openid/login');
      expect(loginUrl.searchParams.get('openid.realm')).toBe('https://ztradar.app/');
      expect(loginUrl.searchParams.get('openid.return_to')).toBe(
        `https://ztradar.app/auth/steam/callback?mode=web&state=${STATE}`,
      );
    });
  });
});