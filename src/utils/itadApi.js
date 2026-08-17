const ITAD_API_KEY = process.env.ITAD_API_KEY;
const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

const STORE_DIRECTORY = {
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

const JUNK_KEYWORDS = [
  'bundle',
  'season pass',
  'expansion pass',
  'expansion pack',
  'dlc',
  'soundtrack',
  ' ost',
  'artbook',
  'demo version',
  ' demo',
  'certification',
  'course',
  'training',
  'book bundle',
  'comic bundle',
  'software bundle',
  'pack',
  'upgrade',
  'guide',
];

export function resolveStoreName(rawStore) {
  if (!rawStore) return 'Authorized Store';
  const key = String(rawStore).toLowerCase().trim();
  return STORE_DIRECTORY[key] || STORE_DIRECTORY[rawStore] || rawStore;
}

export function isCuratedGame(title, storeName, imageUrl, includeThirdParty = false) {
  if (!title || !imageUrl) return false;

  const normalizedTitle = title.toLowerCase();

  for (const keyword of JUNK_KEYWORDS) {
    if (normalizedTitle.includes(keyword)) {
      return false;
    }
  }

  // Default store filtering: Steam and Epic Games Store only
  if (!includeThirdParty) {
    return storeName === 'Steam' || storeName === 'Epic Games Store';
  }

  return true;
}

const POPULAR_SUGGESTIONS = [
  { name: 'Grand Theft Auto V', value: 'gta-v|Grand Theft Auto V' },
  { name: 'Cyberpunk 2077', value: 'cyberpunk-2077|Cyberpunk 2077' },
  { name: 'Elden Ring', value: 'elden-ring|Elden Ring' },
  { name: 'The Witcher 3: Wild Hunt', value: 'the-witcher-3|The Witcher 3: Wild Hunt' },
  { name: 'Red Dead Redemption 2', value: 'rdr2|Red Dead Redemption 2' },
  { name: 'Baldurs Gate 3', value: 'baldurs-gate-3|Baldurs Gate 3' },
  { name: 'God of War Ragnarok', value: 'gow-ragnarok|God of War Ragnarok' },
  { name: 'Hogwarts Legacy', value: 'hogwarts-legacy|Hogwarts Legacy' },
];

export async function searchGamesForAutocomplete(query) {
  if (!query || query.trim().length === 0) {
    return POPULAR_SUGGESTIONS;
  }

  const trimmedQuery = query.trim();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    if (ITAD_API_KEY) {
      const itadUrl = `${ITAD_BASE_URL}/games/search/v1?key=${ITAD_API_KEY}&title=${encodeURIComponent(trimmedQuery)}&results=25`;
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

    const csUrl = `${CHEAPSHARK_BASE_URL}/games?title=${encodeURIComponent(trimmedQuery)}&limit=25`;
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
    return POPULAR_SUGGESTIONS.filter((g) => g.name.toLowerCase().includes(trimmedQuery.toLowerCase()));
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Game search lookup error:', error.message || error);
    return POPULAR_SUGGESTIONS;
  }
}

export async function getGameDealInfo(gameId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    if (ITAD_API_KEY) {
      const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${ITAD_API_KEY}&country=BR`;
      const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${ITAD_API_KEY}&country=BR`;
      const infoUrl = `${ITAD_BASE_URL}/games/info/v2?key=${ITAD_API_KEY}&id=${gameId}`;

      const [priceRes, historyRes, infoRes] = await Promise.all([
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
        fetch(infoUrl, { signal: controller.signal }).catch(() => null),
      ]);

      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const historyData = historyRes.ok ? await historyRes.json() : [];
        const infoData = infoRes && infoRes.ok ? await infoRes.json() : null;

        const gamePrices = priceData?.[0]?.deals || [];
        const historyLow = historyData?.[0]?.low?.price?.amount ?? null;

        const bannerImage = infoData?.assets?.banner400 || infoData?.assets?.banner300 || infoData?.assets?.boxart || null;
        const reviewScore = infoData?.reviews?.steam?.score ?? infoData?.reviews?.metacritic?.score ?? null;
        const steamAppId = infoData?.appid || infoData?.steam_appid || null;

        if (gamePrices.length > 0) {
          const steamOffer = gamePrices.find(
            (deal) => deal.shop?.name?.toLowerCase().includes('steam') || deal.shop?.id === 61
          );

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

          const isAllTimeLow =
            historyLow !== null &&
            (primaryDeal.salePrice <= historyLow ||
              (cheaperAlternative && cheaperAlternative.salePrice <= historyLow));

          clearTimeout(timeoutId);
          return {
            gameId,
            title: priceData[0]?.title || 'Monitored Title',
            imageUrl: bannerImage,
            reviewScore,
            steamAppId,
            isAllTimeLow,
            allTimeLowPrice: historyLow,
            primaryDeal,
            cheaperAlternative,
          };
        }
      }
    }

    // Fallback: CheapShark API
    const csUrl = `${CHEAPSHARK_BASE_URL}/games?id=${gameId}`;
    const csRes = await fetch(csUrl, { signal: controller.signal });

    if (csRes.ok) {
      const csData = await csRes.json();
      const deals = csData.deals || [];
      if (deals.length > 0) {
        const steamDeal = deals.find((d) => d.storeID === '1');
        const cheapestDeal = deals.reduce(
          (prev, curr) => (parseFloat(curr.price) < parseFloat(prev.price) ? curr : prev),
          deals[0]
        );

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

        const metacriticScore = csData.info?.metacriticScore ? parseInt(csData.info.metacriticScore, 10) : null;
        const bannerImage = csData.info?.thumb || null;
        const steamAppId = csData.info?.steamAppID || null;

        clearTimeout(timeoutId);
        return {
          gameId,
          title: csData.info?.title || 'Monitored Title',
          imageUrl: bannerImage,
          reviewScore: metacriticScore,
          steamAppId,
          isAllTimeLow: csData.cheapestPriceEver?.price
            ? primaryDeal.salePrice <= parseFloat(csData.cheapestPriceEver.price)
            : false,
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

/**
 * Fetches popular top-selling deals and active free game promotions.
 */
export async function getMarketOverviewDeals(includeThirdParty = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    if (ITAD_API_KEY) {
      // Pull both popular best-sellers and high discount deals
      const [popularRes, deepCutRes] = await Promise.all([
        fetch(`${ITAD_BASE_URL}/deals/v2?key=${ITAD_API_KEY}&country=BR&limit=60&sort=-popular`, { signal: controller.signal }),
        fetch(`${ITAD_BASE_URL}/deals/v2?key=${ITAD_API_KEY}&country=BR&limit=60&sort=-cut`, { signal: controller.signal }),
      ]);

      const popularData = popularRes.ok ? await popularRes.json() : { list: [] };
      const deepCutData = deepCutRes.ok ? await deepCutRes.json() : { list: [] };

      clearTimeout(timeoutId);

      const combinedList = [...(popularData.list || []), ...(deepCutData.list || [])];
      const seenGameIds = new Set();
      const mappedDeals = [];

      for (const item of combinedList) {
        if (!item.deal || !item.title || seenGameIds.has(item.id)) continue;

        const shopName = resolveStoreName(item.deal?.shop?.name);
        const imageUrl = item.assets?.banner400 || item.assets?.banner300 || item.assets?.boxart || null;

        if (!isCuratedGame(item.title, shopName, imageUrl, includeThirdParty)) {
          continue;
        }

        seenGameIds.add(item.id);
        mappedDeals.push({
          gameId: item.id,
          title: item.title,
          imageUrl,
          reviewScore: item.reviews?.steam?.score ?? item.reviews?.metacritic?.score ?? null,
          steamAppId: item.appid || item.steam_appid || null,
          primaryDeal: {
            shopName,
            salePrice: item.deal?.price?.amount ?? 0,
            regularPrice: item.deal?.regular?.amount ?? 0,
            cutPercent: item.deal?.cut ?? 0,
            url: item.deal?.url,
          },
          cheaperAlternative: null,
        });
      }

      return mappedDeals;
    }

    // Fallback: CheapShark Popular Top Deals
    const csUrl = `${CHEAPSHARK_BASE_URL}/deals?pageSize=60&sortBy=Deal%20Rating`;
    const csRes = await fetch(csUrl, { signal: controller.signal });

    if (csRes.ok) {
      const csDeals = await csRes.json();
      clearTimeout(timeoutId);
      const mappedDeals = [];

      for (const d of csDeals) {
        if (!d.title) continue;

        const shopName = resolveStoreName(d.storeID);
        const imageUrl = d.thumb || null;

        if (!isCuratedGame(d.title, shopName, imageUrl, includeThirdParty)) {
          continue;
        }

        mappedDeals.push({
          gameId: d.gameID,
          title: d.title,
          imageUrl,
          reviewScore: d.metacriticScore ? parseInt(d.metacriticScore, 10) : (d.steamRatingPercent ? parseInt(d.steamRatingPercent, 10) : null),
          steamAppId: d.steamAppID || null,
          primaryDeal: {
            shopName,
            salePrice: parseFloat(d.salePrice),
            regularPrice: parseFloat(d.normalPrice),
            cutPercent: Math.round(parseFloat(d.savings)),
            url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
          },
          cheaperAlternative: null,
        });
      }

      return mappedDeals;
    }

    clearTimeout(timeoutId);
    return [];
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Error fetching market overview deals:', error.message || error);
    return [];
  }
}