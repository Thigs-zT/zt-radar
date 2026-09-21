/**
 * Steam Sales Calendar Intelligence Utility
 *
 * Curates Valve official Steam seasonal sales (Spring, Summer, Autumn, Winter)
 * and major Steam Fests/Next Fests for 2026-2027. Provides dynamic countdowns,
 * active event detection, and branded Discord embeds.
 */

import type {
  SteamSaleEvent,
  SteamSaleStatus,
  DiscordEmbed,
  DiscordActionRow,
} from '../types/index.js';
import {
  BRAND_COLORS,
  ANSI_CODES,
  formatAnsiBlock,
  CUSTOM_STORE_EMOJIS,
  resolveStoreBadge,
} from './theme.js';

/**
 * Curated list of official Valve Steam seasonal promotions and major festivals.
 * Chronologically indexed and timestamped in UTC.
 */
export const STEAM_SALES_SCHEDULE: readonly SteamSaleEvent[] = [
  {
    name: 'Steam Next Fest: February 2026',
    type: 'fest',
    startDate: '2026-02-23T18:00:00Z',
    endDate: '2026-03-02T18:00:00Z',
    description: 'Valve multi-day celebration of upcoming PC games featuring hundreds of free playable demos and developer livestreams.',
  },
  {
    name: 'Steam Spring Sale 2026',
    type: 'seasonal',
    startDate: '2026-03-19T17:00:00Z',
    endDate: '2026-03-26T17:00:00Z',
    description: 'Official Valve Spring seasonal promotional event featuring catalog-wide discounts across thousands of titles.',
  },
  {
    name: 'Steam Deckbuilders Fest',
    type: 'fest',
    startDate: '2026-03-30T17:00:00Z',
    endDate: '2026-04-06T17:00:00Z',
    description: 'Discounts and spotlight on card-battlers, roguelike deckbuilders, and tactical tabletop-inspired strategy games.',
  },
  {
    name: 'Steam Open World Survival Craft Fest',
    type: 'fest',
    startDate: '2026-05-18T17:00:00Z',
    endDate: '2026-05-25T17:00:00Z',
    description: 'Celebration of open-world survival, base-building, and expansive crafting sandbox adventures.',
  },
  {
    name: 'Steam Next Fest: June 2026',
    type: 'fest',
    startDate: '2026-06-08T17:00:00Z',
    endDate: '2026-06-15T17:00:00Z',
    description: 'Mid-year Next Fest edition showcasing hundreds of unreleased games and exclusive demo access.',
  },
  {
    name: 'Steam Summer Sale 2026',
    type: 'seasonal',
    startDate: '2026-06-25T17:00:00Z',
    endDate: '2026-07-09T17:00:00Z',
    description: 'The pinnacle mid-year Steam sale event with massive discounts across thousands of titles, special profile items, and badge events.',
  },
  {
    name: 'Steam Fighting Games Fest',
    type: 'fest',
    startDate: '2026-07-27T17:00:00Z',
    endDate: '2026-08-03T17:00:00Z',
    description: 'Spotlighting traditional fighting games, 3D brawlers, martial arts, and arena combat experiences.',
  },
  {
    name: 'Steam Turn-Based RPG Fest',
    type: 'fest',
    startDate: '2026-08-17T17:00:00Z',
    endDate: '2026-08-24T17:00:00Z',
    description: 'Discounts and developer spotlights on tactical turn-based roleplaying and strategy adventures.',
  },
  {
    name: 'Steam Space Exploration Fest',
    type: 'fest',
    startDate: '2026-09-07T17:00:00Z',
    endDate: '2026-09-14T17:00:00Z',
    description: 'Dedicated festival celebrating space simulators, interplanetary exploration, and sci-fi sagas.',
  },
  {
    name: 'Steam Next Fest: October 2026',
    type: 'fest',
    startDate: '2026-10-12T17:00:00Z',
    endDate: '2026-10-19T17:00:00Z',
    description: 'Autumn edition of Next Fest presenting upcoming fall and winter PC game releases with playable demos.',
  },
  {
    name: 'Steam Scream Fest (Halloween 2026)',
    type: 'fest',
    startDate: '2026-10-26T17:00:00Z',
    endDate: '2026-11-02T17:00:00Z',
    description: 'Annual Halloween celebration featuring discounts on survival horror, psychological thrillers, and spooky in-game events.',
  },
  {
    name: 'Steam Autumn Sale 2026',
    type: 'seasonal',
    startDate: '2026-11-24T18:00:00Z',
    endDate: '2026-12-01T18:00:00Z',
    description: 'Major Black Friday & Cyber Week seasonal sale featuring the launch of Steam Awards nominations.',
  },
  {
    name: 'Steam Winter Sale 2026',
    type: 'seasonal',
    startDate: '2026-12-17T18:00:00Z',
    endDate: '2027-01-07T18:00:00Z',
    description: 'The premier year-end holiday sale with platform-wide discounts, seasonal trading cards, and official Steam Awards voting.',
  },
  {
    name: 'Steam Next Fest: February 2027',
    type: 'fest',
    startDate: '2027-02-22T18:00:00Z',
    endDate: '2027-03-01T18:00:00Z',
    description: 'Opening Next Fest of 2027 offering hundreds of new PC demos and developer chats.',
  },
  {
    name: 'Steam Spring Sale 2027',
    type: 'seasonal',
    startDate: '2027-03-18T17:00:00Z',
    endDate: '2027-03-25T17:00:00Z',
    description: 'Valve 2027 Spring seasonal promotional sale.',
  },
];

/**
 * Detects if a major Steam sale is active right now or determines the immediate next upcoming sale.
 *
 * @param referenceDate - Optional date override for deterministic testing (defaults to now).
 */
export function getCurrentOrNextSale(referenceDate?: Date): SteamSaleStatus {
  const now = referenceDate ? referenceDate.getTime() : Date.now();

  // 1. Check if any sale is currently active
  for (const event of STEAM_SALES_SCHEDULE) {
    const start = new Date(event.startDate).getTime();
    const end = new Date(event.endDate).getTime();
    if (start <= now && now <= end) {
      return {
        sale: event,
        isActive: true,
      };
    }
  }

  // 2. Resolve immediate next upcoming sale
  const upcoming = STEAM_SALES_SCHEDULE
    .filter((event) => new Date(event.startDate).getTime() > now)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  return {
    sale: upcoming[0] || null,
    isActive: false,
  };
}

/**
 * Returns a chronological slice of future confirmed sales and festivals.
 *
 * @param limit - Maximum number of upcoming events to return (default: 5).
 * @param referenceDate - Optional date override for deterministic testing.
 */
export function getUpcomingSales(limit: number = 5, referenceDate?: Date): SteamSaleEvent[] {
  const now = referenceDate ? referenceDate.getTime() : Date.now();

  return STEAM_SALES_SCHEDULE
    .filter((event) => new Date(event.endDate).getTime() > now)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .slice(0, limit);
}

/**
 * Helper to compute Unix epoch seconds from an ISO date string.
 */
function toUnix(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Helper to compute event duration in whole calendar days.
 */
function getDurationDays(startDate: string, endDate: string): number {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Builds a branded Discord embed and action row button for the Steam Sales Calendar.
 *
 * @param referenceDate - Optional date override for testing.
 */
export function buildSalesCalendarEmbed(referenceDate?: Date): {
  embed: DiscordEmbed;
  components: DiscordActionRow[];
} {
  const currentStatus = getCurrentOrNextSale(referenceDate);
  const now = referenceDate ? referenceDate.getTime() : Date.now();

  let spotlightDescription = '';
  const spotlightSale = currentStatus.sale;

  if (spotlightSale) {
    const startUnix = toUnix(spotlightSale.startDate);
    const endUnix = toUnix(spotlightSale.endDate);
    const typeTag = spotlightSale.type === 'seasonal' ? 'Seasonal Sale' : 'Festival / Next Fest';

    if (currentStatus.isActive) {
      const ansiBox = formatAnsiBlock([
        `${ANSI_CODES.BOLD_GREEN}[ ACTIVE NOW — VALVE PROMOTIONAL EVENT ]${ANSI_CODES.RESET}`,
        `  Event:  ${ANSI_CODES.BOLD_WHITE}${spotlightSale.name}${ANSI_CODES.RESET}`,
        `  Type:   ${ANSI_CODES.BOLD_YELLOW}${typeTag}${ANSI_CODES.RESET}`,
        `  Ends:   <t:${endUnix}:R>`,
        `  Dates:  <t:${startUnix}:D> – <t:${endUnix}:D>`,
      ].join('\n'));

      spotlightDescription = [
        ansiBox,
        `★ **ACTIVE NOW — Ends <t:${endUnix}:R>**`,
        `▸ **${spotlightSale.name}** \`[${typeTag}]\``,
        `  └─ ${spotlightSale.description}`,
        `  └─ **Date Range:** <t:${startUnix}:D> – <t:${endUnix}:D>`,
      ].join('\n');
    } else {
      const ansiBox = formatAnsiBlock([
        `${ANSI_CODES.BOLD_CYAN}[ NEXT CONFIRMED STEAM EVENT ]${ANSI_CODES.RESET}`,
        `  Event:  ${ANSI_CODES.BOLD_WHITE}${spotlightSale.name}${ANSI_CODES.RESET}`,
        `  Type:   ${ANSI_CODES.BOLD_YELLOW}${typeTag}${ANSI_CODES.RESET}`,
        `  Starts: <t:${startUnix}:R>`,
        `  Dates:  <t:${startUnix}:D> – <t:${endUnix}:D>`,
      ].join('\n'));

      spotlightDescription = [
        ansiBox,
        `❖ **Next Confirmed Steam Event Spotlight**`,
        `▸ **${spotlightSale.name}** \`[${typeTag}]\``,
        `  └─ ${spotlightSale.description}`,
        `  └─ **Countdown:** Starts <t:${startUnix}:R>`,
        `  └─ **Date Range:** <t:${startUnix}:D> – <t:${endUnix}:D>`,
      ].join('\n');
    }
  } else {
    spotlightDescription = '▸ No upcoming sales currently recorded in the 2026–2027 calendar.';
  }

  // Get upcoming schedule excluding currently active spotlighted sale from schedule list if already active
  const allFuture = getUpcomingSales(6, referenceDate);
  const scheduleEvents = allFuture
    .filter((e) => {
      if (currentStatus.isActive && spotlightSale && e.name === spotlightSale.name) {
        return false;
      }
      return new Date(e.startDate).getTime() > now;
    })
    .slice(0, 4);

  const scheduleLines = scheduleEvents.map((event) => {
    const sUnix = toUnix(event.startDate);
    const days = getDurationDays(event.startDate, event.endDate);
    const badge = event.type === 'seasonal' ? 'Seasonal' : 'Fest';

    return `▸ **${event.name}** \`[${badge}]\` • <t:${sUnix}:d> (${days}d) • Starts <t:${sUnix}:R>`;
  });

  const fields = [];
  if (scheduleLines.length > 0) {
    fields.push({
      name: '❖ Upcoming Steam Promotions & Major Festivals',
      value: scheduleLines.join('\n'),
      inline: false,
    });
  }

  const steamEmoji =
    CUSTOM_STORE_EMOJIS.steam_animated ||
    CUSTOM_STORE_EMOJIS.steam ||
    resolveStoreBadge('steam');

  const embed: DiscordEmbed = {
    title: `${steamEmoji} Steam Seasonal Sales & Major Fests Calendar`,
    description: spotlightDescription,
    color: BRAND_COLORS.STEAM,
    image: {
      url: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/clusters/frontpage/c2e22c95/page_bg_english.jpg',
    },
    fields,
    footer: {
      text: 'Valve Steam Official Schedule • Timestamps Synchronized with Local Discord Time',
    },
    timestamp: new Date().toISOString(),
  };

  const components: DiscordActionRow[] = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'Steam Sales History (SteamDB)',
          url: 'https://steamdb.info/sales/history/',
        },
      ],
    },
  ];

  return { embed, components };
}
