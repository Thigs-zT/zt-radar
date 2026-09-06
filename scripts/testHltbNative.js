// Direct test for src/utils/hltbNative.js
import assert from 'node:assert';
import { getHowLongToBeatStats } from '../src/utils/hltbNative.js';

console.log('--- Testing Native HowLongToBeat Module ---\n');

async function testHltbNative() {
  // Test 1: Invalid / empty inputs
  console.log('[Test 1] Testing invalid inputs:');
  const emptyRes = await getHowLongToBeatStats('');
  assert.strictEqual(emptyRes.success, false);
  assert.strictEqual(emptyRes.error, 'DATA_UNAVAILABLE');

  const nullRes = await getHowLongToBeatStats(null);
  assert.strictEqual(nullRes.success, false);
  console.log('  Invalid input handling: PASS');

  // Test 2: Live lookup for Witcher 3
  console.log('\n[Test 2] Testing live lookup for "The Witcher 3: Wild Hunt":');
  const w3 = await getHowLongToBeatStats('The Witcher 3: Wild Hunt');
  console.log('  Witcher 3 result:', w3);
  assert.strictEqual(w3.success, true);
  assert.ok(w3.mainStoryHours > 40, `Main story hours (${w3.mainStoryHours}) should be > 40`);
  assert.ok(w3.mainExtraHours > w3.mainStoryHours, 'Main+Extra should be > Main story');
  assert.ok(w3.completionistHours > w3.mainExtraHours, 'Completionist should be > Main+Extra');
  assert.ok(w3.imageUrl.startsWith('https://howlongtobeat.com/games/'), 'Image URL format verified');
  console.log('  Witcher 3 verification: PASS');

  // Test 3: Live lookup for Hades
  console.log('\n[Test 3] Testing live lookup for "Hades":');
  const hades = await getHowLongToBeatStats('Hades');
  console.log('  Hades result:', hades);
  assert.strictEqual(hades.success, true);
  assert.ok(hades.mainStoryHours > 15, `Hades main story hours (${hades.mainStoryHours}) should be > 15`);
  console.log('  Hades verification: PASS');

  console.log('\nAll HowLongToBeat native tests passed successfully!');
}

testHltbNative().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
