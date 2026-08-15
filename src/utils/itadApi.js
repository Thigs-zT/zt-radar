const ITAD_API_KEY = process.env.ITAD_API_KEY;
const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

// Unified store name mapping for clean display
const STORE_DIRECTORY = {
  // CheapShark Store IDs
  '1': 'Steam',
  '2': 'GamersGate',
  '3': 'GreenManGaming',
  '7': 'GOG',
  '8': 'Origin / EA',
  '11': 'Humble Store',
  '13': 'Uplay / Ubisoft',
  '15': 'Fanatical',
  '25': 'Epic Games Store',
  '31': 'Blizzard Battle.net',
  '35': 'Nuuvem',
  // ITAD Store Slugs / Names
  steam: 'Steam',
  gog: 'GOG',
  epic: 'Epic Games Store',
  nuuvem: 'Nuuvem',
  humblestore: 'Humble Store',
  greenmangaming: 'GreenManGaming',
  origin: 'EA App',
  uplay: 'Ubisoft Connect',
  gamersgate: 'GamersGate',
  fanatical: 'Fanatical',
};

export function resolveStoreName(rawStore) {
  if (!rawStore) return 'Authorized Store';
  const key = String(rawStore).toLowerCase().trim();
  return STORE_DIRECTORY[key] || STORE_DIRECTORY[rawStore] || rawStore;
}

/**
 * Searches for games to populate Discord slash command autocomplete options.
 * Strict 2.0-second timeout ensures completion within Discord 3.0s window.
 */
export async function searchGamesForAutocomplete(query) {
  if (!query || query.length < 2) {
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    if (ITAD_API_KEY) {
      const itadUrl = `${ITAD_BASE_URL}/games/search/v1?key=${ITAD_API_KEY}&title=${encodeURIComponent(query)}&results=25`;
      const res = await fetch(itadUrl, { signal: controller.signal });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          clearTimeout(timeoutId);
          return data.slice(0, 25).map((game) => ({
            name: game.title.length > 100 ? game.title.substring(0, 97) + '...' : game.title,
            value: `${game.id}|${game.title}`.substring(0, 100),
          }));
        }
      }
    }

    // Fallback: CheapShark API game lookup
    const csUrl = `${CHEAPSHARK_BASE_URL}/games?title=${encodeURIComponent(query)}&limit=25`;
    const csRes = await fetch(csUrl, { signal: controller.signal });

    if (csRes.ok) {
      const csData = await csRes.json();
      if (Array.isArray(csData) && csData.length > 0) {
        clearTimeout(timeoutId);
        return csData.slice(0, 25).map((game) => ({
          name: game.external.length > 100 ? game.external.substring(0, 97) + '...' : game.external,
          value: `${game.gameID}|${game.external}`.substring(0, 100),
        }));
      }
    }

    clearTimeout(timeoutId);
    return [];
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Game search lookup error:', error.message || error);
    return [];
  }
}

/**
 * Fetches real-time price deal intelligence with Steam store prioritization.
 */
export async function getGameDealInfo(gameId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    if (ITAD_API_KEY) {
      const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${ITAD_API_KEY}&country=BR`;
      const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${ITAD_API_KEY}&country=BR`;

      const [priceRes, historyRes] = await Promise.all([
        fetch(priceUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([gameId]),
          signal: controller.signal,
        }),
        fetch(historyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([gameId]),
          signal: controller.signal,
        }),
      ]);

      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const historyData = historyRes.ok ? await historyRes.json() : [];

        const gamePrices = priceData?.[0]?.deals || [];
        const historyLow = historyData?.[0]?.low?.price?.amount ?? null;

        if (gamePrices.length > 0) {
          const steamOffer = gamePrices.find(
            (deal) => deal.shop?.name?.toLowerCase().includes('steam') || deal.shop?.id === 61
          );

          // Sort deals by lowest price
          const sortedDeals = [...gamePrices].sort((a, b) => a.price.amount - b.price.amount);
          const cheapestOffer = sortedDeals[0];

          const primaryRaw = steamOffer || cheapestOffer;
          let secondaryRaw = null;

          if (steamOffer && cheapestOffer && cheapestOffer.price.amount < steamOffer.price.amount) {
            secondaryRaw = cheapestOffer;
          }

          const primaryDeal = {
            shopName: resolveStoreName(primaryRaw.shop.name),
            salePrice: primaryRaw.price.amount,
            regularPrice: primaryRaw.regular.amount,
            cutPercent: primaryRaw.cut,
            url: primaryRaw.url,
          };

          const cheaperAlternative = secondaryRaw
            ? {
                shopName: resolveStoreName(secondaryRaw.shop.name),
                salePrice: secondaryRaw.price.amount,
                regularPrice: secondaryRaw.regular.amount,
                cutPercent: secondaryRaw.cut,
                url: secondaryRaw.url,
              }
            : null;

          const isAllTimeLow = historyLow !== null && (primaryDeal.salePrice <= historyLow || (cheaperAlternative && cheaperAlternative.salePrice <= historyLow));

          clearTimeout(timeoutId);
          return {
            gameId,
            title: priceData[0]?.title || 'Monitored Title',
            isAllTimeLow,
            allTimeLowPrice: historyLow,
            primaryDeal,
            cheaperAlternative,
          };
        }
      }
    }

    // Fallback: CheapShark deals lookup
    const csUrl = `${CHEAPSHARK_BASE_URL}/games?id=${gameId}`;
    const csRes = await fetch(csUrl, { signal: controller.signal });

    if (csRes.ok) {
      const csData = await csRes.json();
      const deals = csData.deals || [];
      if (deals.length > 0) {
        const steamDeal = deals.find((d) => d.storeID === '1');
        const cheapestDeal = deals.reduce((prev, curr) => (parseFloat(curr.price) < parseFloat(prev.price) ? curr : prev), deals[0]);

        const primaryRaw = steamDeal || cheapestDeal;
        let secondaryRaw = null;

        if (steamDeal && cheapestDeal && parseFloat(cheapestDeal.price) < parseFloat(steamDeal.price)) {
          secondaryRaw = cheapestDeal;
        }

        const primaryDeal = {
          shopName: resolveStoreName(primaryRaw.storeID),
          salePrice: parseFloat(primaryRaw.price),
          regularPrice: parseFloat(primaryRaw.retailPrice),
          cutPercent: Math.round(parseFloat(primaryRaw.savings)),
          url: `https://www.cheapshark.com/redirect?dealID=${primaryRaw.dealID}`,
        };

        const cheaperAlternative = secondaryRaw
          ? {
              shopName: resolveStoreName(secondaryRaw.storeID),
              salePrice: parseFloat(secondaryRaw.price),
              regularPrice: parseFloat(secondaryRaw.retailPrice),
              cutPercent: Math.round(parseFloat(secondaryRaw.savings)),
              url: `https://www.cheapshark.com/redirect?dealID=${secondaryRaw.dealID}`,
            }
          : null;

        clearTimeout(timeoutId);
        return {
          gameId,
          title: csData.info?.title || 'Monitored Title',
          isAllTimeLow: csData.cheapestPriceEver?.price ? primaryDeal.salePrice <= parseFloat(csData.cheapestPriceEver.price) : false,
          allTimeLowPrice: csData.cheapestPriceEver?.price ? parseFloat(csData.cheapestPriceEver.price) : null,
          primaryDeal,
          cheaperAlternative,
        };
      }
    }

    clearTimeout(timeoutId);
    return null;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`Error fetching deal info for ${gameId}:`, error.message || error);
    return null;
  }
}