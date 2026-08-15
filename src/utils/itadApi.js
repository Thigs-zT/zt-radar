const ITAD_BASE_URL = 'https://api.isthereanydeal.com';
const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';
const ITAD_API_KEY = process.env.ITAD_API_KEY;

// Fallback trending games
const DEFAULT_SUGGESTIONS = [
  { name: 'Elden Ring', value: '018d937f-2b50-7195-a22a-89a37adbc08a|Elden Ring' },
  { name: 'Cyberpunk 2077', value: '018d937e-61e3-7253-8320-c0b899cb6333|Cyberpunk 2077' },
  { name: 'Grand Theft Auto V', value: '018d937e-4050-705a-93ec-e4e138a06e9f|Grand Theft Auto V' },
  { name: 'The Witcher 3: Wild Hunt', value: '018d937e-3bb9-715a-b620-e2b83441584c|The Witcher 3: Wild Hunt' },
  { name: 'Red Dead Redemption 2', value: '018d937f-135f-7323-b6d8-f54070a256a4|Red Dead Redemption 2' }
];

/**
 * Searches games by title for Discord Autocomplete using ITAD (or CheapShark fallback)
 * @param {string} title Search query
 * @returns {Promise<Array<{name: string, value: string}>>}
 */
export async function searchGamesForAutocomplete(title) {
  const query = (title || '').trim();

  if (query.length < 2) {
    return DEFAULT_SUGGESTIONS;
  }

  // 1. Try ITAD v3 Lookup
  if (ITAD_API_KEY) {
    try {
      const url = `${ITAD_BASE_URL}/games/search/v1?key=${ITAD_API_KEY}&title=${encodeURIComponent(query)}&results=10`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'zT-Radar/1.0 (DiscordBot; AWS-Lambda)',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          return data.slice(0, 10).map((game) => {
            const name = `${game.title}`.substring(0, 100);
            const value = `${game.id}|${game.title}`.substring(0, 100);
            return { name, value };
          });
        }
      }
    } catch (itadError) {
      console.error('ITAD Autocomplete Error (switching to fallback):', itadError.message);
    }
  }

  // 2. Fallback: CheapShark API
  try {
    const url = `${CHEAPSHARK_BASE_URL}/games?title=${encodeURIComponent(query)}&limit=10`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'zT-Radar/1.0 (DiscordBot; AWS-Lambda)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.slice(0, 10).map((game) => {
          const name = `${game.external} (CheapShark)`.substring(0, 100);
          const value = `CS_${game.gameID}|${game.external}`.substring(0, 100);
          return { name, value };
        });
      }
    }
  } catch (csError) {
    console.error('CheapShark Autocomplete Fallback Error:', csError.message);
  }

  return DEFAULT_SUGGESTIONS.filter((g) => g.name.toLowerCase().includes(query.toLowerCase()));
}

/**
 * Fetches comprehensive deal details with Steam priority and best deal comparison
 * @param {string} gameId ITAD Game UUID
 * @param {string} title Game title fallback
 * @returns {Promise<Object|null>}
 */
export async function getGameDealInfo(gameId, title) {
  // 1. Try ITAD v3 Prices
  if (ITAD_API_KEY && gameId && !gameId.startsWith('CS_')) {
    try {
      const url = `${ITAD_BASE_URL}/games/prices/v2?key=${ITAD_API_KEY}&country=BR`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'zT-Radar/1.0 (DiscordBot; AWS-Lambda)',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify([gameId]),
        signal: AbortSignal.timeout(4000),
      });

      if (response.ok) {
        const data = await response.json();
        const gameData = data?.[0];
        const deals = gameData?.deals || [];

        if (deals.length > 0) {
          // Sort deals by lowest price
          const sortedDeals = [...deals].sort((a, b) => (a.price?.amount || 0) - (b.price?.amount || 0));
          const absoluteBest = sortedDeals[0];

          // Find Steam specific deal
          const steamDeal = deals.find(d => d.shop?.name?.toLowerCase().includes('steam'));

          let primaryDeal = null;
          let secondaryDeal = null;

          if (steamDeal) {
            primaryDeal = {
              storeName: steamDeal.shop?.name || 'Steam',
              salePrice: parseFloat(steamDeal.price?.amount || 0),
              normalPrice: parseFloat(steamDeal.regular?.amount || 0),
              savingsPercent: parseFloat(steamDeal.cut || 0),
              dealUrl: steamDeal.url,
            };

            // If best price is not Steam and cheaper than Steam
            if (absoluteBest && absoluteBest.shop?.id !== steamDeal.shop?.id && (absoluteBest.price?.amount || 0) < (steamDeal.price?.amount || 0)) {
              secondaryDeal = {
                storeName: absoluteBest.shop?.name || 'Alternative Store',
                salePrice: parseFloat(absoluteBest.price?.amount || 0),
                normalPrice: parseFloat(absoluteBest.regular?.amount || 0),
                savingsPercent: parseFloat(absoluteBest.cut || 0),
                dealUrl: absoluteBest.url,
              };
            }
          } else {
            // No Steam available: best available store becomes primary
            primaryDeal = {
              storeName: absoluteBest.shop?.name || 'Partner Store',
              salePrice: parseFloat(absoluteBest.price?.amount || 0),
              normalPrice: parseFloat(absoluteBest.regular?.amount || 0),
              savingsPercent: parseFloat(absoluteBest.cut || 0),
              dealUrl: absoluteBest.url,
            };
          }

          return {
            title: title,
            currency: 'BRL',
            currencySymbol: 'R$',
            primaryDeal,
            secondaryDeal,
            isAllTimeLow: absoluteBest.historyLow || (steamDeal?.historyLow) || false,
            thumb: null,
          };
        }
      }
    } catch (itadError) {
      console.error(`ITAD Price check failed for ${title}:`, itadError.message);
    }
  }

  // 2. Fallback: CheapShark Deals Query
  try {
    const url = `${CHEAPSHARK_BASE_URL}/deals?title=${encodeURIComponent(title)}&limit=1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'zT-Radar/1.0 (DiscordBot; AWS-Lambda)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const bestDeal = data[0];
        return {
          title: bestDeal.title,
          currency: 'USD',
          currencySymbol: '$',
          primaryDeal: {
            storeName: 'Steam / CheapShark Store',
            salePrice: parseFloat(bestDeal.salePrice),
            normalPrice: parseFloat(bestDeal.normalPrice),
            savingsPercent: parseFloat(bestDeal.savings),
            dealUrl: `https://www.cheapshark.com/redirect?dealID=${bestDeal.dealID}`,
          },
          secondaryDeal: null,
          isAllTimeLow: false,
          thumb: bestDeal.thumb,
        };
      }
    }
  } catch (csError) {
    console.error(`CheapShark Fallback check failed for ${title}:`, csError.message);
  }

  return null;
}