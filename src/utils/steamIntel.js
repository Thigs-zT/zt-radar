const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

/**
 * Strips HTML tags and common BBCode formatting to render clean text for Discord embeds.
 */
function cleanFormatting(rawText) {
  if (!rawText) return '';
  return rawText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\s*>/gi, '▸ ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?(b|i|u|h1|h2|h3|list|\*)\]/gi, '')
    .replace(/\[url=[^\]]+\]([^\[]+)\[\/url\]/gi, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetches official game news and patch notes directly from Valve Steam Web API.
 */
export async function fetchGameNews(appId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  try {
    const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=3&maxlength=400`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timeoutId);
      return [];
    }

    const data = await res.json();
    const newsItems = data?.appnews?.newsitems || [];

    const parsedNews = newsItems.map((item) => {
      const dateStr = item.date ? new Date(item.date * 1000).toISOString().split('T')[0] : 'Recent';
      const cleanSnippet = cleanFormatting(item.contents);
      const truncatedSnippet = cleanSnippet.length > 250 ? cleanSnippet.substring(0, 247) + '...' : cleanSnippet;

      return {
        title: item.title || 'Official Announcement',
        url: item.url,
        author: item.author || 'Developer',
        date: dateStr,
        snippet: truncatedSnippet,
      };
    });

    clearTimeout(timeoutId);
    return parsedNews;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`Error fetching news for Steam AppID ${appId}:`, err.message || err);
    return [];
  }
}

/**
 * Fetches official PC system requirements (minimum and recommended) from Steam Storefront API.
 */
export async function fetchSystemRequirements(appId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic,pc_requirements&l=english`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timeoutId);
      return null;
    }

    const data = await res.json();
    const appData = data?.[appId]?.data;

    if (!appData) {
      clearTimeout(timeoutId);
      return null;
    }

    const gameTitle = appData.name || `App #${appId}`;
    const headerImage = appData.header_image || null;
    const pcReq = appData.pc_requirements || {};

    const rawMin = pcReq.minimum ? cleanFormatting(pcReq.minimum) : 'Not specified by developer.';
    const rawRec = pcReq.recommended ? cleanFormatting(pcReq.recommended) : 'Not specified by developer.';

    // Truncate defensively to respect Discord's 1024-character field limit
    const minSpecs = rawMin.length > 950 ? rawMin.substring(0, 947) + '...' : rawMin;
    const recSpecs = rawRec.length > 950 ? rawRec.substring(0, 947) + '...' : rawRec;

    clearTimeout(timeoutId);
    return {
      title: gameTitle,
      headerImage,
      minimum: minSpecs,
      recommended: recSpecs,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`Error fetching hardware specs for Steam AppID ${appId}:`, err.message || err);
    return null;
  }
}