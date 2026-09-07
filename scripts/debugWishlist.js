import dotenv from 'dotenv';
dotenv.config();

const STEAM_API_KEY = process.env.STEAM_API_KEY;

// Provide SteamID64, profile link, or vanity URL via CLI arguments or default placeholder
const TARGET_STEAM_ID = process.argv[2] || 'YOUR_STEAM_ID64_HERE';

async function diagnose() {
  console.log(`\n--- Diagnosing Wishlist for SteamID: ${TARGET_STEAM_ID} ---`);

  // Test 1: Storefront Endpoint (store.steampowered.com)
  const storeUrl = `https://store.steampowered.com/wishlist/profiles/${TARGET_STEAM_ID}/wishlistdata/?p=0`;
  console.log(`\n[1] Testing Storefront Endpoint: ${storeUrl}`);
  try {
    const res = await fetch(storeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': `https://store.steampowered.com/wishlist/profiles/${TARGET_STEAM_ID}/`,
      },
    });

    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Redirected: ${res.redirected} -> URL: ${res.url}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);

    const text = await res.text();
    console.log(`Response preview (first 150 characters):\n${text.substring(0, 150)}...`);
    try {
      const json = JSON.parse(text);
      const keys = Object.keys(json);
      console.log(`JSON parsed successfully! Total games discovered: ${keys.length}`);
    } catch {
      console.log('Failed to parse as JSON (Steam returned HTML or empty payload).');
    }
  } catch (err) {
    console.error('Store Endpoint Error:', err.message);
  }

  // Test 2: Official Web API (IWishlistService)
  if (STEAM_API_KEY) {
    const apiUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${TARGET_STEAM_ID}`;
    console.log(`\n[2] Testing Official Web API (IWishlistService): ${apiUrl}`);
    try {
      const res = await fetch(apiUrl, {
        headers: {
          'x-webapi-key': STEAM_API_KEY,
        },
      });
      console.log(`Status: ${res.status} ${res.statusText}`);
      const data = await res.json();
      console.log('Web API Response:', JSON.stringify(data).substring(0, 200));
      if (data?.response?.items) {
        console.log(`Web API Success! Total items: ${data.response.items.length}`);
      }
    } catch (err) {
      console.error('Web API Error:', err.message);
    }
  } else {
    console.log('\n[2] STEAM_API_KEY absent in .env for IWishlistService testing.');
  }
}

diagnose();