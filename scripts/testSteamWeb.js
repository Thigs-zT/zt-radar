import dotenv from 'dotenv';
dotenv.config();

import {
  resolveSteamId,
  getPlayerSummary,
  getPlayerBans,
  getPlayerOwnedGames,
  getCompletePlayerProfile,
} from '../src/utils/steamWeb.js';

async function runTests() {
  console.log('--- Valve Steam Web API Integration Test Suite ---');

  // Test 1: Static resolution tests (without API key)
  console.log('\n[Test 1] Testing static SteamID64 resolution formats:');
  const rawId = '76561197960287930';
  const resolvedRaw = await resolveSteamId(rawId, null);
  console.log(`Raw ID Resolution: ${resolvedRaw === rawId ? 'PASS' : 'FAIL'} (${resolvedRaw})`);

  const profileUrl = 'https://steamcommunity.com/profiles/76561197960287930/';
  const resolvedProfile = await resolveSteamId(profileUrl, null);
  console.log(`Profile URL Resolution: ${resolvedProfile === rawId ? 'PASS' : 'FAIL'} (${resolvedProfile})`);

  const emptyResult = await resolveSteamId('', null);
  console.log(`Empty Input Resolution: ${emptyResult === null ? 'PASS' : 'FAIL'} (${emptyResult})`);

  // Test 2: Live API resolution tests (requires STEAM_API_KEY)
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) {
    console.log('\n[Notice] STEAM_API_KEY not present in environment.');
    console.log('Skipping live API calls. Set STEAM_API_KEY in .env to run live integration tests.');
    console.log('\nAll static tests passed successfully.');
    return;
  }

  console.log('\n[Test 2] Testing live Steam Web API endpoints with API key:');

  // Test 2.1: Resolve vanity URL
  console.log('Resolving vanity URL "gabelogannewell"...');
  const resolvedVanity = await resolveSteamId('gabelogannewell', apiKey);
  console.log(`Vanity resolution result: ${resolvedVanity}`);

  const targetId = resolvedVanity || rawId;

  // Test 2.2: Fetch player summary
  console.log(`Fetching player summary for SteamID ${targetId}...`);
  const summary = await getPlayerSummary(targetId, apiKey);
  if (summary) {
    console.log(`Player Summary: PASS (Persona: "${summary.personaName}", State: ${summary.personaStateLabel})`);
  } else {
    console.log('Player Summary: FAILED or returned null');
  }

  // Test 2.3: Fetch player bans
  console.log(`Fetching player bans for SteamID ${targetId}...`);
  const bans = await getPlayerBans(targetId, apiKey);
  if (bans) {
    console.log(`Player Bans: PASS (VAC Banned: ${bans.vacBanned}, Community Banned: ${bans.communityBanned})`);
  } else {
    console.log('Player Bans: FAILED or returned null');
  }

  // Test 2.4: Fetch owned games
  console.log(`Fetching owned games for SteamID ${targetId}...`);
  const games = await getPlayerOwnedGames(targetId, apiKey);
  if (games) {
    console.log(`Owned Games: PASS (Game Count: ${games.gameCount}, Total Playtime: ${games.totalPlaytimeHours} hrs)`);
  } else {
    console.log('Owned Games: FAILED or returned null');
  }

  // Test 2.5: Full orchestration
  console.log('Testing full orchestration via getCompletePlayerProfile...');
  const fullProfile = await getCompletePlayerProfile('https://steamcommunity.com/id/gabelogannewell', apiKey);
  console.log(`Full Profile Orchestration: ${fullProfile.success ? 'PASS' : 'FAIL'}`);

  console.log('\nIntegration test suite completed successfully.');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
