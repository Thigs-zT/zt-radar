/**
 * Steam Intelligence Utility (News & Hardware Specifications)
 *
 * Fetches official game news, patch notes, and hardware specs from Steam APIs.
 * Uses native Node.js fetch with defensive AbortController timeouts.
 */

import type { SteamNewsItem, SystemRequirementsInfo } from '../types/index.js';

const USER_AGENT = 'zT-Radar-Bot/1.0 (https://github.com/zt-radar)';

/**
 * Strips HTML tags and common BBCode formatting to render clean text for Discord embeds.
 */
function cleanFormatting(rawText: string): string {
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

interface RawNewsItem {
  title?: string;
  url?: string;
  author?: string;
  date?: number;
  contents?: string;
}

interface SteamNewsApiResponse {
  appnews?: {
    newsitems?: RawNewsItem[];
  };
}

/**
 * Fetches official game news and patch notes directly from Valve Steam Web API.
 */
export async function fetchGameNews(appId: string | number): Promise<SteamNewsItem[]> {
  try {
    const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=3&maxlength=400`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(1800),
    });

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as SteamNewsApiResponse;
    const newsItems = data?.appnews?.newsitems || [];

    const parsedNews: SteamNewsItem[] = newsItems.map((item) => {
      const dateStr = item.date ? new Date(item.date * 1000).toISOString().split('T')[0] : 'Recent';
      const cleanSnippet = cleanFormatting(item.contents || '');
      const truncatedSnippet = cleanSnippet.length > 250 ? cleanSnippet.substring(0, 247) + '...' : cleanSnippet;

      return {
        title: item.title || 'Official Announcement',
        url: item.url || `https://store.steampowered.com/news/app/${appId}`,
        author: item.author || 'Developer',
        date: dateStr,
        timestamp: item.date,
        snippet: truncatedSnippet,
      };
    });

    return parsedNews;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error fetching news for Steam AppID ${appId}:`, msg);
    return [];
  }
}

/**
 * Structures raw Steam system requirements into clean, boxed codeblocks.
 * Normalizes hardware tags (OS, Processor, Memory, Graphics, Storage, DirectX).
 */
export function formatHardwareSpecs(rawSpecs: string): string {
  if (!rawSpecs || rawSpecs.trim() === 'Not specified by developer.') {
    return '```yaml\nStatus: Not specified by developer.\n```';
  }

  // Remove leading "Minimum:" or "Recommended:" headers if present
  const cleaned = rawSpecs.replace(/^(Minimum|Recommended):\s*/i, '').trim();

  // Split by line breaks
  const rawLines = cleaned.split(/\n+/);
  const blockLines: string[] = [];

  const tagPatterns: Array<{ key: string; regex: RegExp }> = [
    { key: 'OS', regex: /^(?:▸\s*)?(?:OS|Operating System)\s*:\s*(.+)$/i },
    { key: 'Processor', regex: /^(?:▸\s*)?(?:Processor|CPU)\s*:\s*(.+)$/i },
    { key: 'Memory', regex: /^(?:▸\s*)?(?:Memory|RAM)\s*:\s*(.+)$/i },
    { key: 'Graphics', regex: /^(?:▸\s*)?(?:Graphics|Video Card|GPU)\s*:\s*(.+)$/i },
    { key: 'Storage', regex: /^(?:▸\s*)?(?:Storage|Hard Drive|Disk Space)\s*:\s*(.+)$/i },
    { key: 'DirectX', regex: /^(?:▸\s*)?(?:DirectX)\s*:\s*(.+)$/i },
    { key: 'Sound Card', regex: /^(?:▸\s*)?(?:Sound Card|Audio)\s*:\s*(.+)$/i },
  ];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let matched = false;
    for (const { key, regex } of tagPatterns) {
      const match = trimmed.match(regex);
      if (match && match[1]) {
        const paddedKey = `${key}:`.padEnd(11, ' ');
        blockLines.push(`${paddedKey}${match[1].trim()}`);
        matched = true;
        break;
      }
    }

    if (!matched) {
      const cleanLine = trimmed.replace(/^[▸•\-\*]\s*/, '').trim();
      if (
        cleanLine.length > 0 &&
        !cleanLine.toLowerCase().startsWith('minimum') &&
        !cleanLine.toLowerCase().startsWith('recommended')
      ) {
        blockLines.push(cleanLine);
      }
    }
  }

  if (blockLines.length === 0) {
    return `\`\`\`yaml\n${cleaned}\n\`\`\``;
  }

  return `\`\`\`yaml\n${blockLines.join('\n')}\n\`\`\``;
}



interface RawSteamAppDetailsResponse {
  [appId: string]: {
    success?: boolean;
    data?: {
      name?: string;
      header_image?: string;
      pc_requirements?: {
        minimum?: string;
        recommended?: string;
      };
    };
  };
}

/**
 * Fetches official PC system requirements (minimum and recommended) from Steam Storefront API.
 */
export async function fetchSystemRequirements(appId: string | number): Promise<SystemRequirementsInfo | null> {
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

    const data = (await res.json()) as RawSteamAppDetailsResponse;
    const appData = data?.[String(appId)]?.data;

    if (!appData) {
      clearTimeout(timeoutId);
      return null;
    }

    const gameTitle = appData.name || `App #${appId}`;
    const headerImage = appData.header_image || null;
    const pcReq = appData.pc_requirements || {};

    const rawMin = pcReq.minimum ? cleanFormatting(pcReq.minimum) : 'Not specified by developer.';
    const rawRec = pcReq.recommended ? cleanFormatting(pcReq.recommended) : 'Not specified by developer.';

    const minSpecs = rawMin.length > 950 ? rawMin.substring(0, 947) + '...' : rawMin;
    const recSpecs = rawRec.length > 950 ? rawRec.substring(0, 947) + '...' : rawRec;

    clearTimeout(timeoutId);
    return {
      title: gameTitle,
      headerImage,
      minimum: minSpecs,
      recommended: recSpecs,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error fetching hardware specs for Steam AppID ${appId}:`, msg);
    return null;
  }
}
