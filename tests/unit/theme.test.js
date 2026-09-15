import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BRAND_COLORS,
  UNICODE_ICONS,
  ANSI_CODES,
  colorAnsi,
  formatAnsiBlock,
  renderProgressBar,
  resolveStoreBadge,
  registerStoreEmoji,
  clearCustomStoreEmojis,
  formatAnsiPriceDiff,
  formatStoreLabel,
  getCanonicalStoreName,
  getAnsiStoreHeader,
  CUSTOM_STORE_EMOJIS,
  APPLICATION_EMOJIS,
} from '../../src/utils/theme.js';

describe('Centralized Theming Engine & Visual Formatting Utilities', () => {
  describe('BRAND_COLORS Palette', () => {
    it('should export verified hexadecimal colors matching brand specifications', () => {
      expect(BRAND_COLORS.STEAM).toBe(0x1b2838);
      expect(BRAND_COLORS.DISCORD_BLURPLE).toBe(0x5865f2);
      expect(BRAND_COLORS.SUCCESS).toBe(0x2ecc71);
      expect(BRAND_COLORS.DEAL).toBe(0x2ecc71);
      expect(BRAND_COLORS.ALL_TIME_LOW_GOLD).toBe(0xf1c40f);
      expect(BRAND_COLORS.ATL_GOLD).toBe(0xf1c40f);
      expect(BRAND_COLORS.ALERT_CRIMSON).toBe(0xe74c3c);
      expect(BRAND_COLORS.TERMINAL_SLATE).toBe(0x2b2d31);
    });

    it('should maintain backward-compatible semantic aliases', () => {
      expect(BRAND_COLORS.BRAND).toBe(BRAND_COLORS.DISCORD_BLURPLE);
      expect(BRAND_COLORS.DANGER).toBe(BRAND_COLORS.ALERT_CRIMSON);
      expect(BRAND_COLORS.NEUTRAL).toBe(BRAND_COLORS.TERMINAL_SLATE);
      expect(BRAND_COLORS.STEAM_ACCENT).toBe(0x66c0f4);
    });
  });

  describe('renderProgressBar', () => {
    it('should produce accurate ratio blocks for 0%', () => {
      const bar = renderProgressBar(0, 100, 10);
      expect(bar).toBe('░░░░░░░░░░ 0%');
    });

    it('should produce accurate ratio blocks for 50%', () => {
      const bar = renderProgressBar(50, 100, 10);
      expect(bar).toBe('█████░░░░░ 50%');
    });

    it('should produce accurate ratio blocks for 100%', () => {
      const bar = renderProgressBar(100, 100, 10);
      expect(bar).toBe('██████████ 100%');
    });

    it('should respect custom barLength parameter', () => {
      const bar = renderProgressBar(3, 4, 8);
      expect(bar).toBe('██████░░ 75%');
    });

    it('should handle zero or negative total gracefully by returning 0% empty bar', () => {
      expect(renderProgressBar(10, 0, 10)).toBe('░░░░░░░░░░ 0%');
      expect(renderProgressBar(5, -50, 10)).toBe('░░░░░░░░░░ 0%');
    });

    it('should handle negative current value gracefully', () => {
      expect(renderProgressBar(-10, 100, 10)).toBe('░░░░░░░░░░ 0%');
    });

    it('should clamp current values that exceed total to 100%', () => {
      expect(renderProgressBar(150, 100, 10)).toBe('██████████ 100%');
    });
  });

  describe('formatAnsiBlock & colorAnsi', () => {
    it('should inject valid ANSI markdown codeblock headers and footers', () => {
      const rawText = 'Standard Terminal Output';
      const result = formatAnsiBlock(rawText);

      expect(result.startsWith('```ansi\n')).toBe(true);
      expect(result.endsWith('\n```')).toBe(true);
      expect(result).toContain(rawText);
    });

    it('should wrap text inside ANSI escape sequences with colorAnsi', () => {
      const greenText = colorAnsi('Active Promotion', 'GREEN');
      expect(greenText).toBe('\u001b[32mActive Promotion\u001b[0m');

      const boldCyanText = colorAnsi('System Telemetry', ANSI_CODES.BOLD_CYAN);
      expect(boldCyanText).toBe('\u001b[1;36mSystem Telemetry\u001b[0m');
    });

    it('should support high-intensity bold ANSI escape codes for dark theme readability', () => {
      expect(ANSI_CODES.BOLD_GREEN).toBe('\u001b[1;32m');
      expect(ANSI_CODES.BOLD_YELLOW).toBe('\u001b[1;33m');
      expect(ANSI_CODES.BOLD_CYAN).toBe('\u001b[1;36m');
      expect(ANSI_CODES.BOLD_WHITE).toBe('\u001b[1;37m');
    });

    it('should inject valid ANSI escape headers inside an ANSI block', () => {
      const content = `${ANSI_CODES.BOLD_YELLOW}Notice: Promotion Expiring Soon${ANSI_CODES.RESET}`;
      const block = formatAnsiBlock(content);

      expect(block).toContain('```ansi');
      expect(block).toContain('\u001b[1;33m');
      expect(block).toContain('\u001b[0m');
    });
  });

  describe('Custom Store Emojis & Configuration', () => {
    it('should export official Discord application store emoji identifiers by default', () => {
      expect(CUSTOM_STORE_EMOJIS.steam).toBe('<:store_steam:1549480215992995901>');
      expect(CUSTOM_STORE_EMOJIS.epic).toBe('<:store_epic:1549480211291308032>');
      expect(CUSTOM_STORE_EMOJIS.nuuvem).toBe('<:store_nuuvem:1549480214852145202>');
      expect(CUSTOM_STORE_EMOJIS.gog).toBe('<:store_gog:1549480213207973899>');
      expect(CUSTOM_STORE_EMOJIS.steam_animated).toBe('<a:store_steam_animated:1549480222812930099>');
      expect(APPLICATION_EMOJIS).toBe(CUSTOM_STORE_EMOJIS);
    });

    it('should resolve canonical storefront names properly', () => {
      expect(getCanonicalStoreName('steam')).toBe('Steam');
      expect(getCanonicalStoreName('epic games store')).toBe('Epic Games Store');
      expect(getCanonicalStoreName('nuuvem')).toBe('Nuuvem');
      expect(getCanonicalStoreName('gog')).toBe('GOG');
    });

    it('should resolve clean plain-text headers for ANSI codeblocks via getAnsiStoreHeader', () => {
      expect(getAnsiStoreHeader('Steam')).toBe('[Steam]');
      expect(getAnsiStoreHeader('Epic Games Store')).toBe('[Epic]');
      expect(getAnsiStoreHeader('Nuuvem')).toBe('[Nuuvem]');
      expect(getAnsiStoreHeader('GOG')).toBe('[GOG]');
      expect(getAnsiStoreHeader('Itch.io')).toBe('[Itch.io]');
    });
  });

  describe('resolveStoreBadge & formatStoreLabel with Official Emojis', () => {
    beforeEach(() => {
      clearCustomStoreEmojis();
      delete process.env.DISCORD_EMOJI_STEAM;
      delete process.env.EMOJI_STEAM;
      delete process.env.DISCORD_EMOJI_EPIC;
      delete process.env.EMOJI_EPIC;
    });

    afterEach(() => {
      clearCustomStoreEmojis();
    });

    it('should resolve supported digital storefronts to official Discord application emoji tags', () => {
      expect(resolveStoreBadge('Steam')).toBe('<:store_steam:1549480215992995901>');
      expect(resolveStoreBadge('steam')).toBe('<:store_steam:1549480215992995901>');
      expect(resolveStoreBadge('Epic Games Store')).toBe('<:store_epic:1549480211291308032>');
      expect(resolveStoreBadge('Epic Games')).toBe('<:store_epic:1549480211291308032>');
      expect(resolveStoreBadge('epic')).toBe('<:store_epic:1549480211291308032>');
      expect(resolveStoreBadge('Nuuvem')).toBe('<:store_nuuvem:1549480214852145202>');
      expect(resolveStoreBadge('nuuvem')).toBe('<:store_nuuvem:1549480214852145202>');
      expect(resolveStoreBadge('GOG')).toBe('<:store_gog:1549480213207973899>');
      expect(resolveStoreBadge('gog')).toBe('<:store_gog:1549480213207973899>');
    });

    it('should format store labels with custom emoji icons followed by store names without redundancy', () => {
      expect(formatStoreLabel('Steam')).toBe('<:store_steam:1549480215992995901> Steam');
      expect(formatStoreLabel('Epic Games Store')).toBe('<:store_epic:1549480211291308032> Epic Games Store');
      expect(formatStoreLabel('Nuuvem')).toBe('<:store_nuuvem:1549480214852145202> Nuuvem');
      expect(formatStoreLabel('GOG')).toBe('<:store_gog:1549480213207973899> GOG');
    });

    it('should allow dynamic override of store emojis via registry', () => {
      registerStoreEmoji('steam', '<:custom_steam:999999999999999999>');
      expect(resolveStoreBadge('Steam')).toBe('<:custom_steam:999999999999999999>');
      expect(formatStoreLabel('Steam')).toBe('<:custom_steam:999999999999999999> Steam');
    });

    it('should resolve environment variable overrides for store emojis', () => {
      process.env.DISCORD_EMOJI_STEAM = '<:steam_env:111222333444555666>';
      process.env.EMOJI_EPIC = '<:epic_env:222333444555666777>';

      expect(resolveStoreBadge('Steam')).toBe('<:steam_env:111222333444555666>');
      expect(resolveStoreBadge('Epic Games Store')).toBe('<:epic_env:222333444555666777>');
    });

    it('should handle unlisted or unknown store names with clean bracketed fallback tags', () => {
      expect(resolveStoreBadge('Humble Bundle')).toBe('[Humble Bundle]');
      expect(formatStoreLabel('Humble Bundle')).toBe('[Humble Bundle]');
      expect(resolveStoreBadge('')).toBe('[Store]');
      expect(formatStoreLabel('')).toBe('[Store]');
    });
  });

  describe('formatAnsiPriceDiff', () => {
    beforeEach(() => {
      clearCustomStoreEmojis();
    });

    it('should render high-intensity contrast single storefront price block with clean header and no raw emojis', () => {
      const primaryDeal = {
        shopName: 'Steam',
        regularPrice: 59.99,
        salePrice: 29.99,
        cutPercent: 50,
        currencySymbol: '$',
      };

      const block = formatAnsiPriceDiff(primaryDeal, null, '$');

      expect(block).toContain('```ansi');
      expect(block).toContain('\u001b[1;36m[Steam]\u001b[0m');
      // Assert raw emoji tags are completely excluded
      expect(block).not.toContain('<:store_steam:');
      expect(block).not.toContain('<:');
      // High-intensity white/gray for regular price
      expect(block).toContain('Regular: \u001b[1;37m$ 59.99\u001b[0m');
      // High-intensity green for current promotional price
      expect(block).toContain('Current: \u001b[1;32m$ 29.99 (-50%)\u001b[0m');
      expect(block).toContain('```');
    });

    it('should render dual storefront comparison with clean separation and bold yellow best value tag without emoji leakage', () => {
      const primaryDeal = {
        shopName: 'Steam',
        regularPrice: 69.99,
        salePrice: 48.99,
        cutPercent: 30,
        currencySymbol: '$',
      };

      const cheaperDeal = {
        shopName: 'Nuuvem',
        regularPrice: 69.99,
        salePrice: 34.99,
        cutPercent: 50,
        currencySymbol: '$',
      };

      const block = formatAnsiPriceDiff(primaryDeal, cheaperDeal, '$');

      expect(block).toContain('```ansi');
      expect(block).toContain('\u001b[1;36m[Steam]\u001b[0m');
      expect(block).not.toContain('<:');
      // Clean blank line separating the store blocks
      expect(block).toContain('\n\n');
      // High-intensity bold yellow best value header
      expect(block).toContain('\u001b[1;33m[Nuuvem] ★ Best Value\u001b[0m');
      // High-intensity green deal price
      expect(block).toContain('Deal:    \u001b[1;32m$ 34.99 (-50%)\u001b[0m');
      expect(block).toContain('```');
    });

    it('should render clean bracketed fallback tags without repetition when store is unlisted', () => {
      const primary = { shopName: 'Itch.io', regularPrice: 20, salePrice: 10, cutPercent: 50 };
      const cheaper = { shopName: 'GOG', regularPrice: 20, salePrice: 5, cutPercent: 75 };

      const block = formatAnsiPriceDiff(primary, cheaper, '$');
      expect(block).toContain('[Itch.io]');
      expect(block).not.toContain('[Itch.io] Itch.io');
      expect(block).toContain('\u001b[1;33m[GOG] ★ Best Value\u001b[0m');
      expect(block).not.toContain('<:');
    });

    it('should strip custom emoji tags inside ANSI blocks even when dynamic custom emojis are registered', () => {
      registerStoreEmoji('steam', '<:custom_steam:999999999999999999>');
      registerStoreEmoji('epic', '<:custom_epic:888888888888888888>');

      const primary = { shopName: 'Steam', regularPrice: 40, salePrice: 20, cutPercent: 50 };
      const cheaper = { shopName: 'Epic Games Store', regularPrice: 40, salePrice: 15, cutPercent: 62 };

      const block = formatAnsiPriceDiff(primary, cheaper, '$');
      expect(block).toContain('\u001b[1;36m[Steam]\u001b[0m');
      expect(block).toContain('\u001b[1;33m[Epic] ★ Best Value\u001b[0m');
      expect(block).not.toContain('<:custom_steam:');
      expect(block).not.toContain('<:custom_epic:');
    });
  });

  describe('UNICODE_ICONS', () => {
    it('should define standard structural geometric indicators', () => {
      expect(UNICODE_ICONS.SPARKLE).toBe('❖');
      expect(UNICODE_ICONS.ARROW).toBe('▸');
      expect(UNICODE_ICONS.CORNER).toBe('└─');
      expect(UNICODE_ICONS.BULLET).toBe('●');
    });
  });
});
