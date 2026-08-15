const CHEAPSHARK_BASE_URL = 'https://www.cheapshark.com/api/1.0';

// Fallback suggestions when user hasn't typed anything yet
const DEFAULT_SUGGESTIONS = [
  { name: 'Elden Ring', value: '243764|Elden Ring' },
  { name: 'Cyberpunk 2077', value: '207904|Cyberpunk 2077' },
  { name: 'Grand Theft Auto V', value: '144078|Grand Theft Auto V' },
  { name: 'The Witcher 3: Wild Hunt', value: '144079|The Witcher 3: Wild Hunt' },
  { name: 'Red Dead Redemption 2', value: '208152|Red Dead Redemption 2' }
];

export async function searchGamesForAutocomplete(title) {
  const query = (title || '').trim();

  // If query is empty or 1 char, return default trending games
  if (query.length < 2) {
    return DEFAULT_SUGGESTIONS;
  }

  try {
    const url = `${CHEAPSHARK_BASE_URL}/games?title=${encodeURIComponent(query)}&limit=10`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'zT-Radar-App/1.0 (DiscordBot; AWS-Lambda)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(2000) // 2.0s strict timeout
    });

    if (!response.ok) {
      console.error(`CheapShark API responded with status: ${response.status}`);
      return DEFAULT_SUGGESTIONS.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return [];
    }

    return data.slice(0, 10).map((game) => {
      const priceText = game.cheapest ? ` (Best: $${game.cheapest})` : '';
      const name = `${game.external}${priceText}`.substring(0, 100);
      const value = `${game.gameID}|${game.external}`.substring(0, 100);

      return { name, value };
    });
  } catch (error) {
    console.error('Fetch Autocomplete Error:', error.message);
    return DEFAULT_SUGGESTIONS.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
  }
}

/**
 * Fetches deal details for a specific game by title
 * @param {string} title Game title
 * @returns {Promise<Object|null>} Best current deal info or null
 */
export async function getGameDealInfo(title) {
  try {
    const url = `https://www.cheapshark.com/api/1.0/deals?title=${encodeURIComponent(title)}&limit=1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'zT-Radar-App/1.0 (DiscordBot; AWS-Lambda)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const bestDeal = data[0];
    return {
      dealId: bestDeal.dealID,
      title: bestDeal.title,
      salePrice: parseFloat(bestDeal.salePrice),
      normalPrice: parseFloat(bestDeal.normalPrice),
      savingsPercent: parseFloat(bestDeal.savings),
      metacriticScore: parseInt(bestDeal.metacriticScore || '0', 10),
      thumb: bestDeal.thumb,
      steamRatingPercent: bestDeal.steamRatingPercent,
      dealUrl: `https://www.cheapshark.com/redirect?dealID=${bestDeal.dealID}`
    };
  } catch (error) {
    console.error(`Error fetching deal info for ${title}:`, error.message);
    return null;
  }
}