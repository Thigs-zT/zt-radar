const ITAD_API_KEY = process.env.ITAD_API_KEY;
const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

// Strictly authorized storefronts: Steam, Epic Games Store, Nuuvem, GOG
const ALLOWED_STORES = {
  steam: 'Steam',
  'epic games store': 'Epic Games Store',
  'epic games': 'Epic Games Store',
  epic: 'Epic Games Store',
  nuuvem: 'Nuuvem',
  gog: 'GOG',
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
  if (!rawStore) return null;
  const key = String(rawStore).toLowerCase().trim();
  if (key === '1' || key.includes('steam')) return 'Steam';
  if (key === '25' || key.includes('epic')) return 'Epic Games Store';
  if (key === '35' || key.includes('nuuvem')) return 'Nuuvem';
  if (key === '7' || key.includes('gog')) return 'GOG';
  return null; // Ignore any store outside our 4 approved storefronts
}

export function isCuratedGame(title, storeName, imageUrl, includeThirdParty = false) {
  if (!title || !imageUrl) return false;

  for (const pattern of NON_GAME_PATTERNS) {
    if (pattern.test(title)) {
      return false;
    }
  }

  const normalizedStore = (storeName || '').toLowerCase();
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

/**
 * Autocomplete searching Steam Store official catalog (canonical) + Epic Games Store exclusives.
 * Returns empty array when query is empty, only showing results when the user starts typing.
 */
export async function searchGamesForAutocomplete(query) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const trimmedQuery = query.trim();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  const choices = [];
  const seenTitles = new Set();
  const seenAppIds = new Set();

  try {
    // 1. Search Steam Store Official Search (Canonical real games)
    const steamSearchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(trimmedQuery)}&l=english&cc=US`;
    const steamRes = await fetch(steamSearchUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (steamRes.ok) {
      const steamData = await steamRes.json();
      const items = steamData?.items || [];

      for (const item of items) {
        if (!item.id || !item.name) continue;
        if (item.type && item.type !== 'app') continue;

        let isFiltered = false;
        for (const pattern of NON_GAME_PATTERNS) {
          if (pattern.test(item.name)) {
            isFiltered = true;
            break;
          }
        }
        if (isFiltered) continue;

        const normTitle = item.name.toLowerCase().trim();
        if (seenTitles.has(normTitle) || seenAppIds.has(item.id)) continue;
        seenTitles.add(normTitle);
        seenAppIds.add(item.id);

        choices.push({
          name: item.name.length > 100 ? item.name.substring(0, 97) + '...' : item.name,
          value: `steam:${item.id}|${item.name}`.substring(0, 100),
        });

        if (choices.length >= 20) break;
      }
    }

    // 2. Query ITAD for Epic Games Store exclusives or games not present on Steam
    if (ITAD_API_KEY && choices.length < 25) {
      try {
        const itadUrl = `${ITAD_BASE_URL}/games/search/v1?key=${ITAD_API_KEY}&title=${encodeURIComponent(trimmedQuery)}&results=15`;
        const itadRes = await fetch(itadUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (itadRes.ok) {
          const itadData = await itadRes.json();
          if (Array.isArray(itadData)) {
            for (const g of itadData) {
              if (!g.id || !g.title) continue;
              if (g.type && g.type !== 'game') continue;

              const normTitle = g.title.toLowerCase().trim();
              if (seenTitles.has(normTitle)) continue;

              let isFiltered = false;
              for (const pattern of NON_GAME_PATTERNS) {
                if (pattern.test(g.title)) {
                  isFiltered = true;
                  break;
                }
              }
              if (isFiltered) continue;

              seenTitles.add(normTitle);
              choices.push({
                name: `${g.title} (Epic / PC)`.substring(0, 100),
                value: `itad:${g.id}|${g.title}`.substring(0, 100),
              });

              if (choices.length >= 25) break;
            }
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    clearTimeout(timeoutId);
    return choices.slice(0, 25);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Autocomplete search error:', err.message || err);
    return [];
  }
}

/**
 * Retrieves comprehensive price, store comparison, and historical low data.
 */
export async function getGameDealInfo(rawGameIdentifier, preferredCurrency = 'USD', titleFallback = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  const country = preferredCurrency === 'BRL' ? 'br' : 'us';
  const currencySymbol = preferredCurrency === 'BRL' ? 'R$' : '$';
  const currency = preferredCurrency === 'BRL' ? 'BRL' : 'USD';

  let steamAppId = null;
  let itadGameId = null;
  let title = titleFallback || '';

  if (typeof rawGameIdentifier === 'string') {
    if (rawGameIdentifier.startsWith('steam:')) {
      steamAppId = rawGameIdentifier.replace('steam:', '').trim();
    } else if (rawGameIdentifier.startsWith('itad:')) {
      itadGameId = rawGameIdentifier.replace('itad:', '').trim();
    } else if (/^\d+$/.test(rawGameIdentifier)) {
      steamAppId = rawGameIdentifier;
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(rawGameIdentifier)) {
      itadGameId = rawGameIdentifier;
    } else {
      title = rawGameIdentifier;
    }
  }

  try {
    let steamDeal = null;
    let bannerImage = null;
    let reviewScore = null;

    // 1. Fetch Official Steam Store details if steamAppId is known
    if (steamAppId) {
      try {
        const steamUrl = `https://store.steampowered.com/api/appdetails?appids=${steamAppId}&cc=${country}&l=english`;
        const steamRes = await fetch(steamUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (steamRes.ok) {
          const steamData = await steamRes.json();
          const appDetails = steamData?.[steamAppId]?.data;

          if (appDetails) {
            title = appDetails.name || title;
            bannerImage = appDetails.header_image || null;
            reviewScore = appDetails.metacritic?.score ?? null;

            if (appDetails.is_free) {
              steamDeal = {
                shopName: 'Steam',
                salePrice: 0,
                regularPrice: 0,
                cutPercent: 100,
                url: `https://store.steampowered.com/app/${steamAppId}/`,
              };
            } else if (appDetails.price_overview) {
              steamDeal = {
                shopName: 'Steam',
                salePrice: appDetails.price_overview.final / 100,
                regularPrice: appDetails.price_overview.initial / 100,
                cutPercent: appDetails.price_overview.discount_percent,
                url: `https://store.steampowered.com/app/${steamAppId}/`,
              };
            }
          }
        }
      } catch (steamErr) {
        console.error('Steam appdetails error:', steamErr.message || steamErr);
      }
    }

    // 2. Query ITAD for multi-store comparison (Nuuvem, GOG, Epic) and Historical Low
    let historyLow = null;
    const storeBreakdown = {};

    if (steamDeal) {
      storeBreakdown['Steam'] = steamDeal;
    }

    if (ITAD_API_KEY) {
      try {
        // Resolve ITAD UUID if missing
        if (!itadGameId) {
          const lookupParam = steamAppId ? `appid=${steamAppId}` : `title=${encodeURIComponent(title)}`;
          const lookupUrl = `${ITAD_BASE_URL}/games/lookup/v1?key=${ITAD_API_KEY}&${lookupParam}`;
          const lookupRes = await fetch(lookupUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
          });

          if (lookupRes.ok) {
            const lookupData = await lookupRes.json();
            itadGameId = lookupData?.game?.id || null;
          }
        }

        if (itadGameId) {
          const priceUrl = `${ITAD_BASE_URL}/games/prices/v3?key=${ITAD_API_KEY}&country=${country.toUpperCase()}`;
          const historyUrl = `${ITAD_BASE_URL}/games/historylow/v1?key=${ITAD_API_KEY}&country=${country.toUpperCase()}`;

          const [priceRes, historyRes] = await Promise.all([
            fetch(priceUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: JSON.stringify([itadGameId]),
              signal: controller.signal,
            }),
            fetch(historyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
              body: JSON.stringify([itadGameId]),
              signal: controller.signal,
            }),
          ]);

          if (priceRes.ok) {
            const priceData = await priceRes.json();
            const itadDeals = priceData?.[0]?.deals || [];

            for (const d of itadDeals) {
              const shopName = resolveStoreName(d.shop?.name);
              if (!shopName) continue; // STRICTLY IGNORE any store outside our 4 approved stores!

              if (!storeBreakdown[shopName] || d.price.amount < storeBreakdown[shopName].salePrice) {
                storeBreakdown[shopName] = {
                  shopName,
                  salePrice: d.price.amount,
                  regularPrice: d.regular.amount,
                  cutPercent: d.cut,
                  url: d.url,
                };
              }
            }
          }

          if (historyRes.ok) {
            const historyData = await historyRes.json();
            historyLow = historyData?.[0]?.low?.price?.amount ?? null;
          }
        }
      } catch (itadErr) {
        console.error('ITAD comparison query error:', itadErr.message || itadErr);
      }
    }

    const availableDeals = Object.values(storeBreakdown);

    if (availableDeals.length === 0) {
      clearTimeout(timeoutId);
      return null;
    }

    // Determine primary offer (Steam by default, or the cheapest deal)
    const sortedByPrice = [...availableDeals].sort((a, b) => a.salePrice - b.salePrice);
    const absoluteCheapest = sortedByPrice[0];
    const defaultSteam = storeBreakdown['Steam'] || absoluteCheapest;

    const primaryRaw = defaultSteam;
    let secondaryRaw = null;

    if (absoluteCheapest.salePrice < primaryRaw.salePrice) {
      secondaryRaw = absoluteCheapest;
    }

    const primaryDeal = {
      shopName: primaryRaw.shopName,
      salePrice: primaryRaw.salePrice,
      regularPrice: primaryRaw.regularPrice,
      cutPercent: primaryRaw.cutPercent,
      url: primaryRaw.url,
      currency,
      currencySymbol,
    };

    const cheaperAlternative = secondaryRaw
      ? {
          shopName: secondaryRaw.shopName,
          salePrice: secondaryRaw.salePrice,
          regularPrice: secondaryRaw.regularPrice,
          cutPercent: secondaryRaw.cutPercent,
          url: secondaryRaw.url,
          currency,
          currencySymbol,
        }
      : null;

    const isAllTimeLow =
      historyLow !== null &&
      (primaryDeal.salePrice <= historyLow || (cheaperAlternative && cheaperAlternative.salePrice <= historyLow));

    const isFree = primaryDeal.salePrice === 0 || (cheaperAlternative && cheaperAlternative.salePrice === 0);

    clearTimeout(timeoutId);
    return {
      gameId: steamAppId ? `steam_${steamAppId}` : (itadGameId || rawGameIdentifier),
      title: title || 'Monitored Title',
      imageUrl: bannerImage,
      reviewScore,
      steamAppId,
      dealType: isFree ? 'FREE_TO_KEEP' : 'CURATED_DEAL',
      isAllTimeLow,
      allTimeLowPrice: historyLow,
      primaryDeal,
      cheaperAlternative,
      storeBreakdown,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`Error resolving deal info for ${rawGameIdentifier}:`, error.message || error);
    return null;
  }
}

/**
 * Probes Steam Store categories for active Free Weekend / Play For Free promotions.
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
            regularPrice: item.original_price ? item.original_price / 100 : 0,
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
              if (!shopName) continue;

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

    // 3. Fetch Acclaimed Games from CheapShark (Steam-only Deals)
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

          discountedDeals.push({
            gameId: d.gameID,
            title: d.title,
            imageUrl,
            reviewScore: rating,
            steamAppId: d.steamAppID || null,
            dealType: 'CURATED_DEAL',
            primaryDeal: {
              shopName: 'Steam',
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