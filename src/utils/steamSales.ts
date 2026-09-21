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
  CUSTOM_STORE_EMOJIS,
} from './theme.js';

/**
 * Curated list of official Valve Steam seasonal promotions and major festivals.
 * Verified with official SteamDB schedule and chronologically indexed in UTC.
 */
export const STEAM_SALES_SCHEDULE: readonly SteamSaleEvent[] = [
  {
    name: 'Steam Spring Sale 2026',
    type: 'seasonal',
    startDate: '2026-03-19T17:00:00Z',
    endDate: '2026-03-26T17:00:00Z',
    description: 'Catalog-wide discounts celebrating the arrival of Spring.',
  },
  {
    name: 'Steam Summer Sale 2026',
    type: 'seasonal',
    startDate: '2026-06-25T17:00:00Z',
    endDate: '2026-07-09T17:00:00Z',
    description: 'Mid-year premier Steam sale featuring thousands of game discounts.',
  },
  {
    name: 'Steam Space Exploration Fest',
    type: 'fest',
    startDate: '2026-09-07T17:00:00Z',
    endDate: '2026-09-14T17:00:00Z',
    description: 'Dedicated festival celebrating space simulators, interplanetary exploration, and sci-fi sagas.',
  },
  {
    name: 'Autumn Sale 2026',
    type: 'seasonal',
    startDate: '2026-10-01T17:00:00Z',
    endDate: '2026-10-08T17:00:00Z',
    description: 'Massive storewide discounts across thousands of PC games.',
    banner: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/clusters/sale_autumn2024/0e84c9df4f71a4fdb23e9860/header_english.jpg',
  },
  {
    name: 'Cooking Fest',
    type: 'fest',
    startDate: '2026-10-12T17:00:00Z',
    endDate: '2026-10-19T17:00:00Z',
    description: 'Celebration of culinary crafts, restaurant management, and cooking games.',
  },
  {
    name: 'Steam Next Fest (October 2026)',
    type: 'fest',
    startDate: '2026-10-19T17:00:00Z',
    endDate: '2026-10-26T17:00:00Z',
    description: 'Multi-day celebration of upcoming PC games featuring hundreds of free playable demos and developer livestreams.',
  },
  {
    name: 'Steam Scream V Fest (Halloween)',
    type: 'fest',
    startDate: '2026-10-26T17:00:00Z',
    endDate: '2026-11-02T17:00:00Z',
    description: 'Annual Halloween celebration featuring discounts on survival horror, psychological thrillers, and spooky games.',
  },
  {
    name: 'Auto-Battler RPG Fest',
    type: 'fest',
    startDate: '2026-11-16T17:00:00Z',
    endDate: '2026-11-23T17:00:00Z',
    description: 'Discounts and developer spotlights on auto-battlers, tactical roguelikes, and squad strategy.',
  },
  {
    name: 'Winter Sale 2026',
    type: 'seasonal',
    startDate: '2026-12-17T17:00:00Z',
    endDate: '2027-01-07T17:00:00Z',
    description: 'The premier year-end holiday sale with platform-wide discounts, seasonal trading cards, and official Steam Awards voting.',
    banner: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/clusters/sale_autumn2024/0e84c9df4f71a4fdb23e9860/header_english.jpg',
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
 * Formats event name for timeline listing by trimming repetitive annotations.
 */
function formatTimelineName(name: string): string {
  return name
    .replace(' (Halloween)', '')
    .replace(' (October 2026)', ' (October)');
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
    const days = getDurationDays(spotlightSale.startDate, spotlightSale.endDate);
    const typeTag = spotlightSale.type === 'seasonal' ? 'Major Seasonal Sale' : 'Steam Festival';

    if (currentStatus.isActive) {
      spotlightDescription = [
        `## ❖ Active Now: ${spotlightSale.name}`,
        `▸ **Type**: ${typeTag}`,
        `▸ **Ends**: <t:${endUnix}:R> (<t:${endUnix}:D>)`,
        `▸ **Duration**: ${days} Days (Started <t:${startUnix}:D>)`,
        `└─ ${spotlightSale.description}`,
      ].join('\n');
    } else {
      spotlightDescription = [
        `## ❖ Spotlight: ${spotlightSale.name}`,
        `▸ **Type**: ${typeTag}`,
        `▸ **Starts**: <t:${startUnix}:R> (<t:${startUnix}:D>)`,
        `▸ **Duration**: ${days} Days (Ends <t:${endUnix}:D>)`,
        `└─ ${spotlightSale.description}`,
      ].join('\n');
    }
  } else {
    spotlightDescription = '▸ No upcoming sales currently recorded in the 2026–2027 calendar.';
  }

  // Get upcoming schedule excluding currently spotlighted sale to prevent redundancy
  const allFuture = getUpcomingSales(10, referenceDate);
  const scheduleEvents = allFuture
    .filter((e) => {
      if (spotlightSale && e.name === spotlightSale.name) {
        return false;
      }
      return new Date(e.startDate).getTime() > now;
    })
    .slice(0, 5);

  const scheduleLines = scheduleEvents.map((event) => {
    const sUnix = toUnix(event.startDate);
    const displayName = formatTimelineName(event.name);
    return `▸ **${displayName}** • <t:${sUnix}:d> (<t:${sUnix}:R>)`;
  });

  const fields = [];
  if (scheduleLines.length > 0) {
    fields.push({
      name: '❖ Upcoming Events Timeline',
      value: scheduleLines.join('\n'),
      inline: false,
    });
  }

  const steamEmoji =
    CUSTOM_STORE_EMOJIS.steam_animated ||
    '<a:store_steam_animated:1549480222812930099>';

  const bannerUrl =
    spotlightSale?.banner ||
    'https://shared.fastly.steamstatic.com/store_item_assets/steam/clusters/sale_autumn2024/0e84c9df4f71a4fdb23e9860/header_english.jpg';

  const embed: DiscordEmbed = {
    title: `${steamEmoji} Steam Sales & Major Events Calendar`,
    description: spotlightDescription,
    color: BRAND_COLORS.STEAM,
    image: {
      url: bannerUrl,
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
          label: 'View on SteamDB',
          url: 'https://steamdb.info/sales/history/',
        },
      ],
    },
  ];

  return { embed, components };
}
