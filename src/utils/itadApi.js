const ITAD_API_KEY = process.env.ITAD_API_KEY;
const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

const STORE_DIRECTORY = {
  '1': 'Steam',
  '7': 'GOG',
  '25': 'Epic Games Store',
  '35': 'Nuuvem',
  steam: 'Steam',
  gog: 'GOG',
  epic: 'Epic Games Store',
  'epic game store': 'Epic Games Store',
  'epic games': 'Epic Games Store',
  nuuvem: 'Nuuvem',
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
  /\bsuite\b/i,
  /\bthemes?\b/i,
  /\badd-?ons?\b/i,
  /\bplugins?\b/i,
  /\bplaytest\b/i,
];

export function resolveStoreName(rawStore) {
  if (!rawStore) return 'Authorized Store';
  const key = String(rawStore).toLowerCase().trim();
  return STORE_DIRECTORY[key] || STORE_DIRECTORY[rawStore] || 'Authorized Store';
}

export function isCuratedGame(title, storeName, imageUrl, includeThirdParty = false) {
  if (!title || !imageUrl) return false;

  for (const pattern of NON_GAME_PATTERNS) {
    if (pattern.test(title)) {
      return false;
    }
  }

  const normalizedStore = storeName.toLowerCase();
  const isPrimary = normalizedStore.includes('steam') || normalizedStore.includes('epic');
  const isAuthorizedThirdParty = normalizedStore.includes('gog') || normalizedStore.includes('nuuvem');

  if (!includeThirdParty && !isPrimary) {
    return false;
  }

  if (includeThirdParty && !isPrimary && !isAuthorizedThirdParty) {
    return false;
  }

  return true;
}

// Verified real popular game identifiers for empty autocomplete queries
const POPULAR_SUGGESTIONS = [
  { name: 'Grand Theft Auto V: Premium Edition', value: '102249|Grand Theft Auto V' },
  { name: 'Cyberpunk 2077', value: '206002|Cyberpunk 2077' },
  { name: 'ELDEN RING', value: '232535|ELDEN RING' },
  { name: 'The Witcher 3: Wild Hunt', value: '144238|The Witcher 3: Wild Hunt' },
  { name: 'Red Dead Redemption 2', value: '200427|Red Dead Redemption 2' },
  { name: "Baldur's Gate 3", value: '217088|Baldurs Gate 3' },
  { name: 'God of War', value: '239634|God of War' },
  { name: 'Hogwarts Legacy', value: '243888|Hogwarts Legacy' },
];

/**
 * Normalizes title for deduplication in autocomplete dropdown.
 */
function normalizeCoreTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(gameoftheyearedition|completeedition|enhancededition|definitivedition)/g, '');
}

export async function searchGamesForAutocomplete(query) {
  if (!query || query.trim().length === 0) {
    return POPULAR_SUGGESTIONS;
  }

  const trimmedQuery = query.trim();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2200);

  const seenCores = new Set();
  const uniqueResults = [];

  const addCandidate = (id, title) => {
    if (!title || !id) return;
    for (const pattern of NON_GAME_PATTERNS) {
      if (pattern.test(title)) return;
    }

    const core = normalizeCoreTitle(title);
    if (seenCores.has(core)) return;
    seenCores.add(core);

    uniqueResults.push({
      name: title.length > 100 ? title.substring(0, 97) + '...' : title,
      value: `${id}|${title}`.substring(0, 100),
    });
  };

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
          data.forEach((g) => addCandidate(g.id, g.title));
          if (uniqueResults.length > 0) {
            clearTimeout(timeoutId);
            return uniqueResults.slice(0, 25);
          }
        }
      }
    }

    // Fallback or CheapShark search
    const csUrl = `${CHEAPSHARK_BASE_URL}/games?title=${encodeURIComponent(trimmedQuery)}&limit=25`;
    const csRes = await fetch(csUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (csRes.ok) {
      const csData = await csRes.json();
      if (Array.isArray(csData) && csData.length > 0) {
        csData.forEach((g) => addCandidate(g.gameID, g.external));
        if (uniqueResults.length > 0) {
          clearTimeout(timeoutId);
          return uniqueResults.slice(0, 25);
        }
      }
    }

    clearTimeout(timeoutId);
    return POPULAR_SUGGESTIONS.filter((g) => g.name.toLowerCase().includes(trimmedQuery.toLowerCase()));
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Game search lookup error:', error.message || error);
    return POPULAR_SUGGESTIONS.filter((g) => g.name.toLowerCase().includes(trimmedQuery.toLowerCase()));
  }
}

/**
 * Searches for a game's ITAD UUID or CheapShark GameID by title if the provided ID is invalid.
 */
async function resolveGameIdByTitle(title) {
  if (!title) return null;
  try {
    if (ITAD_API_KEY) {
      const itadUrl = `${ITAD_BASE_URL}/games/search/v1?key=${ITAD_API_KEY}&title=${encodeURIComponent(title)}&results=1`;
      const res = await fetch(itadUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) {
        const data = await res.json();
        if (data?.[0]?.id) return { type: 'ITAD', id: data[0].id };
      }
    }

    const csUrl = `${CHEAPSHARK_BASE_URL}/games?title=${encodeURIComponent(title)}&limit=1`;
    const csRes = await fetch(csUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (csRes.ok) {
      const csData = await csRes.json();
      if (csData?.[0]?.gameID) return { type: 'CHEAPSHARK', id: csData[0].gameID };
    }
  } catch {
    // Graceful fallback
  }
  return null;
}

export async function getGameDealInfo(rawGameIdentifier, preferredCurrency = 'USD', titleFallback = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  const country = preferredCurrency === 'BRL' ? 'BR' : 'US';
  const currencySymbol = preferredCurrency === 'BRL' ? 'R$' : '$';
  const currency = preferredCurrency === 'BRL' ? 'BRL' : 'USD';

  let gameId = rawGameIdentifier;

  try {
    // If identifier is a title or invalid format, resolve it first
    if (!gameId || gameId.includes('-') && gameId.length < 15 && !gameId.match(/^[0-9a-f]{8}-/)) {
      const resolved = await resolveGameIdByTitle(titleFallback || rawGameIdentifier);
      if (resolved) gameId = resolved.id;
    }

    if (ITAD_API_KEY && gameId) {
      const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${ITAD_API_KEY}&country=${country}`;
      const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${ITAD_API_KEY}&country=${country}`;
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
          const storeBreakdown = {};

          gamePrices.forEach((deal) => {
            const rawName = deal.shop?.name?.toLowerCase() || '';
            let key = null;
            if (rawName.includes('steam')) key = 'Steam';
            else if (rawName.includes('epic')) key = 'Epic Games Store';
            else if (rawName.includes('nuuvem')) key = 'Nuuvem';
            else if (rawName.includes('gog')) key = 'GOG';

            if (key && !storeBreakdown[key]) {
              storeBreakdown[key] = {
                shopName: key,
                salePrice: deal.price.amount,
                regularPrice: deal.regular.amount,
                cutPercent: deal.cut,
                url: deal.url,
              };
            }
          });

          const validDeals = Object.values(storeBreakdown);
          const sortedDeals = (validDeals.length > 0 ? validDeals : gamePrices).sort(
            (a, b) => a.salePrice - b.salePrice
          );

          const cheapestOffer = sortedDeals[0];
          const steamOffer = storeBreakdown['Steam'] || null;

          const primaryRaw = steamOffer || cheapestOffer;
          let secondaryRaw = null;

          if (steamOffer && cheapestOffer && cheapestOffer.salePrice < steamOffer.salePrice) {
            secondaryRaw = cheapestOffer;
          }

          const primaryDeal = {
            shopName: primaryRaw.shopName || resolveStoreName(primaryRaw.shop?.name),
            salePrice: primaryRaw.salePrice ?? primaryRaw.price?.amount ?? 0,
            regularPrice: primaryRaw.regularPrice ?? primaryRaw.regular?.amount ?? 0,
            cutPercent: primaryRaw.cutPercent ?? primaryRaw.cut ?? 0,
            url: primaryRaw.url,
            currency,
            currencySymbol,
          };

          const cheaperAlternative = secondaryRaw
            ? {
                shopName: secondaryRaw.shopName || resolveStoreName(secondaryRaw.shop?.name),
                salePrice: secondaryRaw.salePrice ?? secondaryRaw.price?.amount ?? 0,
                regularPrice: secondaryRaw.regularPrice ?? secondaryRaw.regular?.amount ?? 0,
                cutPercent: secondaryRaw.cutPercent ?? secondaryRaw.cut ?? 0,
                url: secondaryRaw.url,
                currency,
                currencySymbol,
              }
            : null;

          const isAllTimeLow =
            historyLow !== null &&
            (primaryDeal.salePrice <= historyLow ||
              (cheaperAlternative && cheaperAlternative.salePrice <= historyLow));

          const isFree = primaryDeal.salePrice === 0 || (cheaperAlternative && cheaperAlternative.salePrice === 0);
          const dealType = isFree ? 'FREE_TO_KEEP' : 'CURATED_DEAL';

          clearTimeout(timeoutId);
          return {
            gameId,
            title: priceData[0]?.title || titleFallback || 'Monitored Title',
            imageUrl: bannerImage,
            reviewScore,
            steamAppId,
            dealType,
            isAllTimeLow,
            allTimeLowPrice: historyLow,
            primaryDeal,
            cheaperAlternative,
            storeBreakdown,
          };
        }
      }
    }

    // Fallback: CheapShark API (USD)
    const csUrl = `${CHEAPSHARK_BASE_URL}/games?id=${gameId}`;
    const csRes = await fetch(csUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (csRes.ok) {
      const csData = await csRes.json();
      const rawDeals = csData.deals || [];
      const allowedStoreIDs = new Set(['1', '7', '25']);
      const deals = rawDeals.filter((d) => allowedStoreIDs.has(d.storeID));
      const workingDeals = deals.length > 0 ? deals : rawDeals;

      if (workingDeals.length > 0) {
        const storeBreakdown = {};

        workingDeals.forEach((d) => {
          const sName = resolveStoreName(d.storeID);
          if (!storeBreakdown[sName]) {
            storeBreakdown[sName] = {
              shopName: sName,
              salePrice: parseFloat(d.price),
              regularPrice: parseFloat(d.retailPrice),
              cutPercent: Math.round(parseFloat(d.savings)),
              url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
            };
          }
        });

        const steamDeal = storeBreakdown['Steam'] || null;
        const cheapestDeal = Object.values(storeBreakdown).reduce(
          (prev, curr) => (curr.salePrice < prev.salePrice ? curr : prev),
          Object.values(storeBreakdown)[0]
        );

        const primaryRaw = steamDeal || cheapestDeal;
        let secondaryRaw = null;

        if (steamDeal && cheapestDeal && cheapestDeal.salePrice < steamDeal.salePrice) {
          secondaryRaw = cheapestDeal;
        }

        const primaryDeal = {
          shopName: primaryRaw.shopName,
          salePrice: primaryRaw.salePrice,
          regularPrice: primaryRaw.regularPrice,
          cutPercent: primaryRaw.cutPercent,
          url: primaryRaw.url,
          currency: 'USD',
          currencySymbol: '$',
        };

        const cheaperAlternative = secondaryRaw
          ? {
              shopName: secondaryRaw.shopName,
              salePrice: secondaryRaw.salePrice,
              regularPrice: secondaryRaw.regularPrice,
              cutPercent: secondaryRaw.cutPercent,
              url: secondaryRaw.url,
              currency: 'USD',
              currencySymbol: '$',
            }
          : null;

        const metacriticScore = csData.info?.metacriticScore ? parseInt(csData.info.metacriticScore, 10) : null;
        const bannerImage = csData.info?.thumb || null;
        const steamAppId = csData.info?.steamAppID || null;

        const cheapestEver = csData.cheapestPriceEver?.price ? parseFloat(csData.cheapestPriceEver.price) : null;
        const isAllTimeLow = cheapestEver !== null ? primaryDeal.salePrice <= cheapestEver : false;
        const isFree = primaryDeal.salePrice === 0;

        clearTimeout(timeoutId);
        return {
          gameId,
          title: csData.info?.title || titleFallback || 'Monitored Title',
          imageUrl: bannerImage,
          reviewScore: metacriticScore,
          steamAppId,
          dealType: isFree ? 'FREE_TO_KEEP' : 'CURATED_DEAL',
          isAllTimeLow,
          allTimeLowPrice: cheapestEver,
          primaryDeal,
          cheaperAlternative,
          storeBreakdown,
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

async function lookupBrlPriceForTitle(title, includeThirdParty = false) {
  if (!ITAD_API_KEY || !title) return null;

  try {
    const searchUrl = `${ITAD_BASE_URL}/games/search/v1?key=${ITAD_API_KEY}&title=${encodeURIComponent(title)}&results=1`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const gameId = searchData?.[0]?.id;
    if (!gameId) return null;

    const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${ITAD_API_KEY}&country=BR`;
    const priceRes = await fetch(priceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify([gameId]),
    });

    if (!priceRes.ok) return null;
    const priceData = await priceRes.json();
    const deals = priceData?.[0]?.deals || [];

    const validDeals = deals.filter((deal) => {
      const name = deal.shop?.name?.toLowerCase() || '';
      if (name.includes('steam') || name.includes('epic')) return true;
      if (includeThirdParty && (name.includes('nuuvem') || name.includes('gog'))) return true;
      return false;
    });

    if (validDeals.length === 0) return null;

    const steamDeal = validDeals.find(
      (deal) => deal.shop?.name?.toLowerCase().includes('steam') || deal.shop?.id === 61
    );

    const sortedByPrice = [...validDeals].sort((a, b) => a.price.amount - b.price.amount);
    const chosenDeal = sortedByPrice[0];
    const primaryDeal = steamDeal || chosenDeal;

    return {
      salePrice: primaryDeal.price.amount,
      regularPrice: primaryDeal.regular.amount,
      cutPercent: primaryDeal.cut,
      url: primaryDeal.url,
      shopName: resolveStoreName(primaryDeal.shop?.name),
    };
  } catch {
    return null;
  }
}

/**
 * Checks Steam Storefront categories for active "Free Weekend / Play For Free" promotions.
 */
async function fetchSteamFreeWeekends() {
  try {
    const url = 'https://store.steampowered.com/api/featuredcategories/';
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];

    const data = await res.json();
    const candidates = [
      ...(data?.specials?.items || []),
      ...(data?.top_sellers?.items || []),
    ];

    const freeWeekends = [];
    const seen = new Set();

    for (const item of candidates) {
      if (!item.id || seen.has(item.id)) continue;
      // Steam flags Free Play Days / Free Weekend items in package metadata
      const isFreeWeekend =
        item.headline?.toLowerCase().includes('free weekend') ||
        item.body?.toLowerCase().includes('play for free') ||
        item.name?.toLowerCase().includes('free weekend');

      if (isFreeWeekend) {
        seen.add(item.id);
        freeWeekends.push({
          gameId: `steam_${item.id}`,
          title: item.name,
          imageUrl: item.header_image || item.large_capsule_image || null,
          reviewScore: null,
          steamAppId: item.id,
          dealType: 'FREE_PLAY_DAYS',
          primaryDeal: {
            shopName: 'Steam',
            salePrice: 0,
            regularPrice: item.original_price ? (item.original_price / 100) : 0,
            cutPercent: 100,
            url: `https://store.steampowered.com/app/${item.id}/`,
            currency: 'USD',
            currencySymbol: '$',
          },
          cheaperAlternative: null,
        });
      }
    }

    return freeWeekends;
  } catch (err) {
    console.error('Error querying Steam free weekends:', err.message || err);
    return [];
  }
}

export async function getMarketOverviewDeals(includeThirdParty = false, preferredCurrency = 'USD') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5500);

  try {
    const freeDeals = [];
    const freeWeekendDeals = [];
    const discountedDeals = [];
    const seenTitles = new Set();

    // 1. Fetch 100% Free Game Promotions (Keep Forever - Steam & Epic)
    if (ITAD_API_KEY) {
      try {
        const storeFilter = includeThirdParty ? '&shops=61,16,35' : '&shops=61,16';
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
                dealType: 'FREE_TO_KEEP',
                primaryDeal: {
                  shopName,
                  salePrice: 0,
                  regularPrice: item.deal?.regular?.amount ?? 0,
                  cutPercent: 100,
                  url: item.deal?.url,
                  currency: preferredCurrency === 'BRL' ? 'BRL' : 'USD',
                  currencySymbol: preferredCurrency === 'BRL' ? 'R$' : '$',
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

    // 2. Fetch Active Steam Free Weekend / Play For Free Events
    try {
      const activeFreeWeekends = await fetchSteamFreeWeekends();
      for (const fw of activeFreeWeekends) {
        const norm = fw.title.toLowerCase().trim();
        if (!seenTitles.has(norm)) {
          seenTitles.add(norm);
          freeWeekendDeals.push(fw);
        }
      }
    } catch (fwErr) {
      console.error('Free weekend probe error:', fwErr);
    }

    // 3. Fetch Acclaimed Games from CheapShark (Standard Curated Discounts)
    try {
      const csUrl = `${CHEAPSHARK_BASE_URL}/deals?storeID=1&pageSize=50&sortBy=Deal%20Rating&desc=0`;
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
          const normalPrice = parseFloat(d.normalPrice);
          const hasMetacritic = Boolean(d.metacriticScore && parseInt(d.metacriticScore, 10) >= 75);

          if (normalPrice < 4.99) continue;
          if (rating && rating < 80) continue;
          if (hasMetacritic && reviewCount < 1500) continue;
          if (!hasMetacritic && reviewCount < 4000) continue;
          if (savings < 60) continue;

          if (!isCuratedGame(d.title, shopName, imageUrl, includeThirdParty)) continue;

          const normalizedTitle = d.title.toLowerCase().trim();
          if (seenTitles.has(normalizedTitle)) continue;
          seenTitles.add(normalizedTitle);

          let salePrice = parseFloat(d.salePrice);
          let regularPrice = normalPrice;
          let cutPercent = savings;
          let currency = 'USD';
          let currencySymbol = '$';
          let dealUrl = `https://www.cheapshark.com/redirect?dealID=${d.dealID}`;
          let finalShopName = shopName;

          if (preferredCurrency === 'BRL') {
            const brlData = await lookupBrlPriceForTitle(d.title, includeThirdParty);
            if (brlData && brlData.salePrice !== undefined) {
              salePrice = brlData.salePrice;
              regularPrice = brlData.regularPrice;
              cutPercent = brlData.cutPercent;
              currency = 'BRL';
              currencySymbol = 'R$';
              if (brlData.url) dealUrl = brlData.url;
              if (brlData.shopName) finalShopName = brlData.shopName;
            }
          }

          discountedDeals.push({
            gameId: d.gameID,
            title: d.title,
            imageUrl,
            reviewScore: rating,
            steamAppId: d.steamAppID || null,
            dealType: 'CURATED_DEAL',
            primaryDeal: {
              shopName: finalShopName,
              salePrice,
              regularPrice,
              cutPercent,
              url: dealUrl,
              currency,
              currencySymbol,
            },
            cheaperAlternative: null,
          });
        }
      }
    } catch (csErr) {
      console.error('CheapShark overview deals error:', csErr);
    }

    clearTimeout(timeoutId);
    return [...freeDeals, ...freeWeekendDeals, ...discountedDeals];
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Fatal error in market overview deals lookup:', error.message || error);
    return [];
  }
}