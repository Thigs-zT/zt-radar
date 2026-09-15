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
      // 75% of 8 = 6 filled, 2 empty
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

      const cyanText = colorAnsi('System Telemetry', ANSI_CODES.CYAN);
      expect(cyanText).toBe('\u001b[36mSystem Telemetry\u001b[0m');
    });

    it('should inject valid ANSI escape headers inside an ANSI block', () => {
      const content = `${ANSI_CODES.YELLOW}Notice: Promotion Expiring Soon${ANSI_CODES.RESET}`;
      const block = formatAnsiBlock(content);

      expect(block).toContain('```ansi');
      expect(block).toContain('\u001b[33m');
      expect(block).toContain('\u001b[0m');
    });
  });

  describe('resolveStoreBadge', () => {
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

    it('should resolve supported digital storefronts cleanly to ASCII fallback tags', () => {
      expect(resolveStoreBadge('Steam')).toBe('[Steam]');
      expect(resolveStoreBadge('steam')).toBe('[Steam]');
      expect(resolveStoreBadge('Epic Games Store')).toBe('[Epic]');
      expect(resolveStoreBadge('Epic Games')).toBe('[Epic]');
      expect(resolveStoreBadge('epic')).toBe('[Epic]');
      expect(resolveStoreBadge('Nuuvem')).toBe('[Nuuvem]');
      expect(resolveStoreBadge('nuuvem')).toBe('[Nuuvem]');
      expect(resolveStoreBadge('GOG')).toBe('[GOG]');
      expect(resolveStoreBadge('gog')).toBe('[GOG]');
    });

    it('should resolve custom Discord application emojis when registered in registry', () => {
      registerStoreEmoji('steam', '<:steam_logo:102030405060708090>');
      registerStoreEmoji('nuuvem', '<:nuuvem_badge:987654321098765432>');

      expect(resolveStoreBadge('Steam')).toBe('<:steam_logo:102030405060708090>');
      expect(resolveStoreBadge('Nuuvem')).toBe('<:nuuvem_badge:987654321098765432>');
      // Unregistered store retains fallback
      expect(resolveStoreBadge('GOG')).toBe('[GOG]');
    });

    it('should resolve custom Discord application emojis from environment variables', () => {
      process.env.DISCORD_EMOJI_STEAM = '<:steam_env:111222333444555666>';
      process.env.EMOJI_EPIC = '<:epic_env:222333444555666777>';

      expect(resolveStoreBadge('Steam')).toBe('<:steam_env:111222333444555666>');
      expect(resolveStoreBadge('Epic Games Store')).toBe('<:epic_env:222333444555666777>');
    });

    it('should handle unlisted or unknown store names gracefully', () => {
      expect(resolveStoreBadge('Humble Bundle')).toBe('[Humble Bundle]');
      expect(resolveStoreBadge('')).toBe('[Store]');
    });
  });

  describe('formatAnsiPriceDiff', () => {
    it('should render high-contrast single storefront price block', () => {
      const primaryDeal = {
        shopName: 'Steam',
        regularPrice: 59.99,
        salePrice: 29.99,
        cutPercent: 50,
        currencySymbol: '$',
      };

      const block = formatAnsiPriceDiff(primaryDeal, null, '$');

      expect(block).toContain('```ansi');
      expect(block).toContain('[Steam] Steam');
      expect(block).toContain('Regular: $ 59.99');
      expect(block).toContain('Current: \u001b[32m$ 29.99 (-50%)\u001b[0m');
      expect(block).toContain('```');
    });

    it('should render dual storefront comparison with best value highlight', () => {
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
      expect(block).toContain('[Steam] Steam');
      expect(block).toContain('[Nuuvem] Nuuvem ★ Best Value');
      expect(block).toContain('Deal:    \u001b[32m$ 34.99 (-50%)\u001b[0m');
      expect(block).toContain('```');
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
