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
 * Standard ANSI escape sequences supported by Discord markdown code blocks (` ```ansi `).
 */
export const ANSI_CODES = {
  RESET: '\u001b[0m',
  BOLD: '\u001b[1m',
  UNDERLINE: '\u001b[4m',
  GRAY: '\u001b[30m',
  RED: '\u001b[31m',
  GREEN: '\u001b[32m',
  YELLOW: '\u001b[33m',
  BLUE: '\u001b[34m',
  PINK: '\u001b[35m',
  CYAN: '\u001b[36m',
  WHITE: '\u001b[37m',
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
 * In-memory registry for Discord custom application emojis (<:name:id>).
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
 * Resolves a storefront name to either a Discord Application Emoji (<:name:id>)
 * or a graceful branded ASCII fallback tag ([Steam], [Epic], [Nuuvem], [GOG]).
 *
 * Checks in order:
 * 1. Registered custom emoji map.
 * 2. Environment variables (e.g. `DISCORD_EMOJI_STEAM`, `EMOJI_STEAM`).
 * 3. Graceful ASCII fallback tag.
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

  // 2. Check environment variables
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

  // 3. Graceful ASCII fallback
  if (normalized && STORE_FALLBACK_BADGES[normalized]) {
    return STORE_FALLBACK_BADGES[normalized];
  }

  return `[${storeName.trim()}]`;
}

/**
 * Formats a high-contrast ANSI price comparison code block for game deals.
 * Incorporates storefront badges, Cyan titles, Green promotional prices, and Yellow best offer tags.
 */
export function formatAnsiPriceDiff(
  primaryDeal: Partial<StoreDeal>,
  cheaperAlternative?: Partial<StoreDeal> | null,
  fallbackSym: string = '$',
): string {
  const pSym = primaryDeal?.currencySymbol || fallbackSym;
  const pBadge = resolveStoreBadge(primaryDeal?.shopName || 'Store');
  const pShop = primaryDeal?.shopName || 'Store';
  const pReg = `${pSym} ${Number(primaryDeal?.regularPrice || 0).toFixed(2)}`;
  const pSale = `${pSym} ${Number(primaryDeal?.salePrice || 0).toFixed(2)}`;
  const pCut = (primaryDeal?.cutPercent ?? 0) > 0 ? ` (-${primaryDeal?.cutPercent}%)` : '';

  const lines: string[] = [];
  lines.push(`${ANSI_CODES.CYAN}${pBadge} ${pShop}${ANSI_CODES.RESET}`);
  lines.push(`  Regular: ${pReg}`);
  lines.push(`  Current: ${ANSI_CODES.GREEN}${pSale}${pCut}${ANSI_CODES.RESET}`);

  if (cheaperAlternative) {
    const aSym = cheaperAlternative.currencySymbol || pSym;
    const aBadge = resolveStoreBadge(cheaperAlternative.shopName || 'Store');
    const aShop = cheaperAlternative.shopName || 'Store';
    const aReg = `${aSym} ${Number(cheaperAlternative.regularPrice || 0).toFixed(2)}`;
    const aSale = `${aSym} ${Number(cheaperAlternative.salePrice || 0).toFixed(2)}`;
    const aCut = (cheaperAlternative.cutPercent ?? 0) > 0 ? ` (-${cheaperAlternative.cutPercent}%)` : '';

    lines.push('');
    lines.push(`${ANSI_CODES.YELLOW}${aBadge} ${aShop} ★ Best Value${ANSI_CODES.RESET}`);
    if (cheaperAlternative.regularPrice && cheaperAlternative.regularPrice > (cheaperAlternative.salePrice || 0)) {
      lines.push(`  Regular: ${aReg}`);
    }
    lines.push(`  Deal:    ${ANSI_CODES.GREEN}${aSale}${aCut}${ANSI_CODES.RESET}`);
  }

  return formatAnsiBlock(lines.join('\n'));
}
