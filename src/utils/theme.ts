import type { StoreDeal } from '../types/index.js';

/**
 * Enterprise Palette Constants for Discord Embeds.
 * Adheres to official platform branding and high-contrast accessibility standards.
 */
export const BRAND_COLORS = {
  STEAM: 0x1b2838,
  DISCORD_BLURPLE: 0x5865f2,
  SUCCESS: 0x2ecc71,
  DEAL: 0x2ecc71,
  ATL_GOLD: 0xf1c40f,
  ALL_TIME_LOW_GOLD: 0xf1c40f,
  ALERT_CRIMSON: 0xe74c3c,
  TERMINAL_SLATE: 0x2b2d31,

  // Semantic and component aliases
  BRAND: 0x5865f2,
  WARNING: 0xf1c40f,
  DANGER: 0xe74c3c,
  NEUTRAL: 0x2b2d31,
  STEAM_ACCENT: 0x66c0f4,
} as const;

export type BrandColorKey = keyof typeof BRAND_COLORS;

/**
 * Geometric and structural Unicode characters for visual hierarchy.
 * Generic mobile emojis are strictly avoided in favor of minimalist typography.
 */
export const UNICODE_ICONS = {
  SPARKLE: '❖',
  ARROW: '▸',
  CORNER: '└─',
  BULLET: '●',
  UP_TRIANGLE: '▲',
  DOWN_TRIANGLE: '▼',
  STAR: '★',
  DIVIDER: '•',
} as const;

/**
 * Standard & High-Intensity ANSI escape sequences supported by Discord markdown code blocks (` ```ansi `).
 */
export const ANSI_CODES = {
  RESET: '\u001b[0m',
  BOLD: '\u001b[1m',
  UNDERLINE: '\u001b[4m',

  // Standard Colors
  GRAY: '\u001b[30m',
  RED: '\u001b[31m',
  GREEN: '\u001b[32m',
  YELLOW: '\u001b[33m',
  BLUE: '\u001b[34m',
  PINK: '\u001b[35m',
  CYAN: '\u001b[36m',
  WHITE: '\u001b[37m',

  // High-Intensity Bold Colors (optimized for Discord dark theme readability)
  BOLD_GRAY: '\u001b[1;30m',
  BOLD_RED: '\u001b[1;31m',
  BOLD_GREEN: '\u001b[1;32m',
  BOLD_YELLOW: '\u001b[1;33m',
  BOLD_BLUE: '\u001b[1;34m',
  BOLD_PINK: '\u001b[1;35m',
  BOLD_CYAN: '\u001b[1;36m',
  BOLD_WHITE: '\u001b[1;37m',
} as const;

export type AnsiColorCode = keyof typeof ANSI_CODES;

/**
 * Wraps text inside an ANSI color escape sequence with an automatic trailing reset.
 */
export function colorAnsi(text: string, color: AnsiColorCode | string): string {
  const code = (color in ANSI_CODES ? ANSI_CODES[color as AnsiColorCode] : color) as string;
  return `${code}${text}${ANSI_CODES.RESET}`;
}

/**
 * Wraps text inside Discord ```ansi ``` markdown code blocks.
 */
export function formatAnsiBlock(text: string): string {
  return `\`\`\`ansi\n${text}\n\`\`\``;
}

/**
 * Renders a clean solid-block progress bar using Unicode geometric blocks with percentage.
 *
 * @param current - Current progress value.
 * @param total - Total target value.
 * @param barLength - Total length of the bar in characters (default: 10).
 * @returns Formatted progress bar string, e.g. "█████░░░░░ 50%"
 */
export function renderProgressBar(current: number, total: number, barLength: number = 10): string {
  const validLength = Math.max(1, Math.floor(barLength));

  if (total <= 0 || isNaN(total) || isNaN(current) || current <= 0) {
    const emptyBar = '░'.repeat(validLength);
    return `${emptyBar} 0%`;
  }

  const ratio = Math.max(0, Math.min(1, current / total));
  const filledCount = Math.max(0, Math.min(validLength, Math.round(ratio * validLength)));
  const unfilledCount = Math.max(0, validLength - filledCount);
  const percentage = Math.round(ratio * 100);

  const filledBar = '█'.repeat(filledCount);
  const emptyBar = '░'.repeat(unfilledCount);

  return `${filledBar}${emptyBar} ${percentage}%`;
}

/**
 * Centralized custom store emoji mapping from environment configurations.
 */
export const CUSTOM_STORE_EMOJIS: Record<string, string> = {
  steam: process.env.DISCORD_EMOJI_STEAM || '',
  epic: process.env.DISCORD_EMOJI_EPIC || '',
  nuuvem: process.env.DISCORD_EMOJI_NUUVEM || '',
  gog: process.env.DISCORD_EMOJI_GOG || '',
  steam_animated: process.env.DISCORD_EMOJI_STEAM_ANIMATED || '',
};

/**
 * Centralized application emoji mapping alias with fallback awareness.
 */
export const APPLICATION_EMOJIS = CUSTOM_STORE_EMOJIS;

/**
 * In-memory registry for dynamic Discord custom application emojis (<:name:id>).
 */
const customStoreEmojis: Map<string, string> = new Map();

/**
 * Registers or overrides a custom Discord application emoji for a storefront.
 */
export function registerStoreEmoji(storeName: string, emoji: string): void {
  if (storeName && emoji) {
    customStoreEmojis.set(storeName.toLowerCase().trim(), emoji.trim());
  }
}

/**
 * Clears all custom registered store emojis (useful for testing).
 */
export function clearCustomStoreEmojis(): void {
  customStoreEmojis.clear();
}

/**
 * Standard ASCII fallback badges for authorized digital storefronts.
 */
export const STORE_FALLBACK_BADGES: Record<string, string> = {
  steam: '[Steam]',
  epic: '[Epic]',
  'epic games': '[Epic]',
  'epic games store': '[Epic]',
  nuuvem: '[Nuuvem]',
  gog: '[GOG]',
};

/**
 * Normalizes store name into canonical key for badge resolution.
 */
function normalizeStoreKey(rawStore: string): string | null {
  const s = rawStore.toLowerCase().trim();
  if (s.includes('steam') || s === '1') return 'steam';
  if (s.includes('epic') || s === '25') return 'epic';
  if (s.includes('nuuvem') || s === '35') return 'nuuvem';
  if (s.includes('gog') || s === '7') return 'gog';
  return null;
}

/**
 * Resolves canonical storefront display name.
 */
export function getCanonicalStoreName(rawStore: string): string {
  const s = (rawStore || '').toLowerCase().trim();
  if (s.includes('steam') || s === '1') return 'Steam';
  if (s.includes('epic') || s === '25') return 'Epic Games Store';
  if (s.includes('nuuvem') || s === '35') return 'Nuuvem';
  if (s.includes('gog') || s === '7') return 'GOG';
  return rawStore.trim() || 'Store';
}

/**
 * Resolves a storefront name to either a Discord Application Emoji (<:name:id>)
 * or a graceful branded ASCII fallback tag ([Steam], [Epic], [Nuuvem], [GOG]).
 *
 * Checks in order:
 * 1. Registered custom emoji map.
 * 2. Centralized CUSTOM_STORE_EMOJIS configuration.
 * 3. Environment variables (e.g. `DISCORD_EMOJI_STEAM`, `EMOJI_STEAM`).
 * 4. Graceful ASCII fallback tag.
 */
export function resolveStoreBadge(storeName: string): string {
  if (!storeName || typeof storeName !== 'string') {
    return '[Store]';
  }

  const rawKey = storeName.toLowerCase().trim();
  const normalized = normalizeStoreKey(rawKey);

  // 1. Check custom registered emoji
  if (customStoreEmojis.has(rawKey)) {
    return customStoreEmojis.get(rawKey)!;
  }
  if (normalized && customStoreEmojis.has(normalized)) {
    return customStoreEmojis.get(normalized)!;
  }

  // 2. Check centralized custom emoji configuration
  if (normalized && CUSTOM_STORE_EMOJIS[normalized] && CUSTOM_STORE_EMOJIS[normalized].trim().length > 0) {
    return CUSTOM_STORE_EMOJIS[normalized].trim();
  }

  // 3. Check environment variables
  const storeIdentifier = (normalized || rawKey).toUpperCase().replace(/[\s-]+/g, '_');
  const envCandidates = [
    `DISCORD_EMOJI_${storeIdentifier}`,
    `EMOJI_${storeIdentifier}`,
  ];

  for (const envKey of envCandidates) {
    const val = process.env[envKey];
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }

  // 4. Graceful ASCII fallback
  if (normalized && STORE_FALLBACK_BADGES[normalized]) {
    return STORE_FALLBACK_BADGES[normalized];
  }

  return `[${getCanonicalStoreName(storeName)}]`;
}

/**
 * Formats a storefront label avoiding redundancy:
 * - When a custom Discord emoji is resolved: `<:name:id> StoreName`
 * - When a fallback bracketed tag is resolved: `[StoreName]`
 */
export function formatStoreLabel(storeName: string): string {
  const badge = resolveStoreBadge(storeName);
  if (badge.startsWith('<')) {
    return `${badge} ${getCanonicalStoreName(storeName)}`;
  }
  return badge;
}

/**
 * Formats a high-intensity, contrast-optimized ANSI price comparison code block for game deals.
 * Uses bold ANSI escapes (\u001b[1;36m, \u001b[1;37m, \u001b[1;32m, \u001b[1;33m) and prevents
 * redundant store name repetition.
 */
export function formatAnsiPriceDiff(
  primaryDeal: Partial<StoreDeal>,
  cheaperAlternative?: Partial<StoreDeal> | null,
  fallbackSym: string = '$',
): string {
  const pSym = primaryDeal?.currencySymbol || fallbackSym;
  const pLabel = formatStoreLabel(primaryDeal?.shopName || 'Store');
  const pReg = `${pSym} ${Number(primaryDeal?.regularPrice || 0).toFixed(2)}`;
  const pSale = `${pSym} ${Number(primaryDeal?.salePrice || 0).toFixed(2)}`;
  const pCut = (primaryDeal?.cutPercent ?? 0) > 0 ? ` (-${primaryDeal?.cutPercent}%)` : '';

  const lines: string[] = [];
  lines.push(`${ANSI_CODES.BOLD_CYAN}${pLabel}${ANSI_CODES.RESET}`);
  lines.push(`  Regular: ${ANSI_CODES.BOLD_WHITE}${pReg}${ANSI_CODES.RESET}`);
  lines.push(`  Current: ${ANSI_CODES.BOLD_GREEN}${pSale}${pCut}${ANSI_CODES.RESET}`);

  if (cheaperAlternative) {
    const aSym = cheaperAlternative.currencySymbol || pSym;
    const aLabel = formatStoreLabel(cheaperAlternative.shopName || 'Store');
    const aReg = `${aSym} ${Number(cheaperAlternative.regularPrice || 0).toFixed(2)}`;
    const aSale = `${aSym} ${Number(cheaperAlternative.salePrice || 0).toFixed(2)}`;
    const aCut = (cheaperAlternative.cutPercent ?? 0) > 0 ? ` (-${cheaperAlternative.cutPercent}%)` : '';

    lines.push('');
    lines.push(`${ANSI_CODES.BOLD_YELLOW}${aLabel} ★ Best Value${ANSI_CODES.RESET}`);
    if (cheaperAlternative.regularPrice && cheaperAlternative.regularPrice > (cheaperAlternative.salePrice || 0)) {
      lines.push(`  Regular: ${ANSI_CODES.BOLD_WHITE}${aReg}${ANSI_CODES.RESET}`);
    }
    lines.push(`  Deal:    ${ANSI_CODES.BOLD_GREEN}${aSale}${aCut}${ANSI_CODES.RESET}`);
  }

  return formatAnsiBlock(lines.join('\n'));
}
