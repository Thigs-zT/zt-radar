const ITAD_API_KEY = process.env.ITAD_API_KEY;
const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

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
  'epic game store': 'Epic Games Store',
  'epic games': 'Epic Games Store',
  nuuvem: 'Nuuvem',
  humblestore: 'Humble Store',
  greenmangaming: 'GreenManGaming',
  origin: 'EA App',
  uplay: 'Ubisoft Connect',
  gamersgate: 'GamersGate',
  fanatical: 'Fanatical',
};

const NON_GAME_PATTERNS = [
  /\bsoundtrack\b/i,
  /\bost\b/i,
  /\bartbook\b/i,
  /\bartworks?\b/i,
  /\bseason pass\b/i,
  /\bexpansion pass\b/i,
  /\bsong pack\b/i,
  /\bdemo version\b/i,
  /\bdemo\b/i,
  /\bdlc\b/i,
  /\bpack\b/i,
  /\bguide\b/i,
  /\bupgrade\b/i,
  /\bcourse\b/i,
  /\btraining\b/i,
  /\bcertification\b/i,
];

export function resolveStoreName(rawStore) {
  if (!rawStore) return 'Authorized Store';
  const key = String(rawStore).toLowerCase().trim();
  return STORE_DIRECTORY[key] || STORE_DIRECTORY[rawStore] || rawStore;
}

export function isCuratedGame(title, storeName, imageUrl, includeThirdParty = false) {
  if (!title || !imageUrl) return false;

  for (const pattern of NON_GAME_PATTERNS) {
    if (pattern.test(title)) {
      return false;
    }
  }

  const normalizedStore = storeName.toLowerCase();
  const isSteamOrEpic = normalizedStore.includes('steam') || normalizedStore.includes('epic');

  if (!includeThirdParty && !isSteamOrEpic) {
    return false;
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
      const res = await fetch(itadUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });

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
    const csRes = await fetch(csUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

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
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify([gameId]),
          signal: controller.signal,
        }),
        fetch(historyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify([gameId]),
          signal: controller.signal,
        }),
        fetch(infoUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        }).catch(() => null),
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
    const csRes = await fetch(csUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

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
 * Fetches curated top-selling & acclaimed games with high review counts + active 100% free promotions.
 */
export async function getMarketOverviewDeals(includeThirdParty = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    const freeDeals = [];
    const discountedDeals = [];
    const seenTitles = new Set();

    // 1. Fetch Active 100% Free Games from ITAD
    if (ITAD_API_KEY) {
      try {
        const storeFilter = includeThirdParty ? '' : '&shops=61,16';
        const itadFreeUrl = `${ITAD_BASE_URL}/deals/v2?key=${ITAD_API_KEY}&country=BR&limit=30&sort=-cut${storeFilter}`;
        const itadRes = await fetch(itadFreeUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (itadRes.ok) {
          const itadData = await itadRes.json();
          const list = itadData?.list || [];

          for (const item of list) {
            if (!item.deal || !item.title) continue;
            const price = item.deal?.price?.amount ?? 1;

            if (price === 0) {
              const shopName = resolveStoreName(item.deal?.shop?.name);
              const imageUrl = item.assets?.banner400 || item.assets?.banner300 || item.assets?.boxart || null;

              if (!isCuratedGame(item.title, shopName, imageUrl, includeThirdParty)) {
                continue;
              }

              const normalizedTitle = item.title.toLowerCase().trim();
              if (seenTitles.has(normalizedTitle)) continue;
              seenTitles.add(normalizedTitle);

              freeDeals.push({
                gameId: item.id,
                title: item.title,
                imageUrl,
                reviewScore: item.reviews?.steam?.score ?? item.reviews?.metacritic?.score ?? null,
                steamAppId: item.appid || item.steam_appid || null,
                primaryDeal: {
                  shopName,
                  salePrice: 0,
                  regularPrice: item.deal?.regular?.amount ?? 0,
                  cutPercent: 100,
                  url: item.deal?.url,
                },
                cheaperAlternative: null,
              });
            }
          }
        }
      } catch (itadErr) {
        console.error('ITAD free deals error:', itadErr);
      }
    }

    // 2. Fetch Acclaimed Games from CheapShark (Requiring Steam Review Count >= 1000 OR Metacritic Score)
    try {
      const csUrl = `${CHEAPSHARK_BASE_URL}/deals?storeID=1&pageSize=40&sortBy=Deal%20Rating&desc=0`;
      const csRes = await fetch(csUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });

      if (csRes.ok) {
        const csDeals = await csRes.json();
        for (const d of csDeals) {
          if (!d.title) continue;

          const shopName = 'Steam';
          const imageUrl = d.thumb || null;
          const savings = Math.round(parseFloat(d.savings));
          const rating = d.steamRatingPercent ? parseInt(d.steamRatingPercent, 10) : (d.metacriticScore ? parseInt(d.metacriticScore, 10) : null);
          const reviewCount = d.steamRatingCount ? parseInt(d.steamRatingCount, 10) : 0;
          const hasMetacritic = Boolean(d.metacriticScore && parseInt(d.metacriticScore, 10) > 0);

          // Popularity Barrier: Discard games with fewer than 1000 Steam reviews unless they have a Metacritic score
          if (!hasMetacritic && reviewCount < 1000) {
            continue;
          }

          if (savings < 60 || (rating && rating < 75)) {
            continue;
          }

          if (!isCuratedGame(d.title, shopName, imageUrl, includeThirdParty)) {
            continue;
          }

          const normalizedTitle = d.title.toLowerCase().trim();
          if (seenTitles.has(normalizedTitle)) continue;
          seenTitles.add(normalizedTitle);

          discountedDeals.push({
            gameId: d.gameID,
            title: d.title,
            imageUrl,
            reviewScore: rating,
            steamAppId: d.steamAppID || null,
            primaryDeal: {
              shopName,
              salePrice: parseFloat(d.salePrice),
              regularPrice: parseFloat(d.normalPrice),
              cutPercent: savings,
              url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
            },
            cheaperAlternative: null,
          });
        }
      }
    } catch (csErr) {
      console.error('CheapShark overview deals error:', csErr);
    }

    clearTimeout(timeoutId);
    return [...freeDeals, ...discountedDeals];
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Fatal error in market overview deals lookup:', error.message || error);
    return [];
  }
}