/**
 * Scheduled Market Deal Scanner Handler
 *
 * Runs hourly via Amazon EventBridge schedule to scan wishlists and market deals,
 * dispatching Direct Messages and Server Channel broadcasts for active promotions.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  getGameDealInfo,
  getMarketOverviewDeals,
  formatExpiryAvailability,
  formatPriceComparisonDiff,
} from '../utils/itadApi.js';
import type {
  DynamoDbWishlistItem,
  GameDealInfo,
  DiscordEmbed,
  DiscordActionRow,
  DiscordButton,
  DiscordEmbedField,
} from '../types/index.js';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const ALERT_PALETTE = {
  FREE_TO_KEEP: 0x57F287,    // Emerald Green
  FREE_PLAY_DAYS: 0x9B59B6,  // Amethyst Purple
  CURATED_DEAL: 0x5865F2,    // Blurple
  ALL_TIME_LOW: 0xFEE75C,    // Gold Amber
} as const;

interface UserConfigRecord {
  PK: string;
  SK: string;
  user_id?: string;
  preferred_currency?: string;
  alert_global_free?: boolean;
  last_broadcasted_free_deals?: string[];
  last_free_alert_at?: string;
}

interface GuildConfigRecord {
  PK: string;
  SK: string;
  guild_id?: string;
  alert_channel_id?: string;
  currency?: string;
  min_discount?: number;
  free_only?: boolean;
  min_rating?: number;
  include_third_party?: boolean;
  last_broadcasted_deals?: string[];
}

function createStoreButtons(deal: GameDealInfo): DiscordActionRow[] {
  const buttons: DiscordButton[] = [];

  if (deal.primaryDeal?.url) {
    buttons.push({
      type: 2, // BUTTON
      style: 5, // LINK
      label: `Open in ${deal.primaryDeal.shopName}`,
      url: deal.primaryDeal.url,
    });
  }

  if (deal.cheaperAlternative?.url) {
    buttons.push({
      type: 2,
      style: 5,
      label: `Alternative: ${deal.cheaperAlternative.shopName}`,
      url: deal.cheaperAlternative.url,
    });
  }

  if (deal.steamAppId) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB Entry',
      url: `https://steamdb.info/app/${deal.steamAppId}/`,
    });
  } else if (deal.title) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'SteamDB Search',
      url: `https://steamdb.info/search/?a=app&q=${encodeURIComponent(deal.title)}`,
    });
  }

  if (buttons.length === 0) return [];

  return [
    {
      type: 1, // ACTION_ROW
      components: buttons.slice(0, 5),
    },
  ];
}

async function sendDiscordDm(
  userId: string,
  embed: DiscordEmbed,
  components: DiscordActionRow[] = [],
): Promise<boolean> {
  try {
    const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    });

    if (!dmChannelRes.ok) {
      const errorText = await dmChannelRes.text();
      console.warn(`Could not open DM channel for user ${userId}: ${dmChannelRes.status} - ${errorText}`);
      return false;
    }

    const dmChannel = (await dmChannelRes.json()) as { id: string };

    const messagePayload: { embeds: DiscordEmbed[]; components?: DiscordActionRow[] } = { embeds: [embed] };
    if (components.length > 0) {
      messagePayload.components = components;
    }

    const messageRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });

    if (!messageRes.ok) {
      const errorText = await messageRes.text();
      console.warn(`Could not send DM message to user ${userId}: ${messageRes.status} - ${errorText}`);
      return false;
    }

    console.log(`DM successfully sent to user ${userId}`);
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error sending DM to user ${userId}:`, msg);
    return false;
  }
}

async function sendGuildChannelAlert(
  channelId: string,
  embed: DiscordEmbed,
  components: DiscordActionRow[] = [],
): Promise<boolean> {
  try {
    const messagePayload: { embeds: DiscordEmbed[]; components?: DiscordActionRow[] } = { embeds: [embed] };
    if (components.length > 0) {
      messagePayload.components = components;
    }

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.warn(`Could not send guild alert to channel ${channelId}: ${res.status} - ${errorText}`);
      return false;
    }

    console.log(`Guild alert successfully sent to channel ${channelId}`);
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error sending alert to channel ${channelId}:`, msg);
    return false;
  }
}

export const handler = async (): Promise<{ statusCode: number; body: string }> => {
  console.log('Starting zT Radar scheduled deal scanner...');

  try {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
      })
    );

    const allItems = (scanResult.Items || []) as Array<Record<string, unknown>>;
    const wishlistItems = allItems.filter(
      (item) => typeof item.SK === 'string' && item.SK.startsWith('GAME#')
    ) as unknown as DynamoDbWishlistItem[];

    const guildConfigs = allItems.filter(
      (item) => typeof item.PK === 'string' && item.PK.startsWith('GUILD#') && item.SK === 'CONFIG'
    ) as unknown as GuildConfigRecord[];

    const userConfigs = allItems.filter(
      (item) => typeof item.PK === 'string' && item.PK.startsWith('USER#') && item.SK === 'CONFIG'
    ) as unknown as UserConfigRecord[];

    const userCurrencyMap = new Map<string, string>();
    userConfigs.forEach((cfg) => {
      const uid = cfg.PK.replace('USER#', '');
      userCurrencyMap.set(uid, cfg.preferred_currency || 'USD');
    });

    console.log(`Retrieved ${wishlistItems.length} wishlist items and ${guildConfigs.length} guild configs.`);

    const userDmCountMap = new Map<string, number>();
    const MAX_DM_PER_USER = 3;

    // 1. Process Individual Wishlists (DMs)
    if (wishlistItems.length > 0) {
      for (const item of wishlistItems) {
        const userId = item.user_id || item.PK?.replace('USER#', '');
        const currentDmCount = userDmCountMap.get(userId) || 0;
        if (currentDmCount >= MAX_DM_PER_USER) {
          continue;
        }

        const preferredCurrency = userCurrencyMap.get(userId) || 'USD';
        const deal = await getGameDealInfo(item.external_game_id, preferredCurrency, item.game_title);
        if (!deal) continue;

        // Auto-heal & clean resolved display title
        const resolvedTitle = deal.title && !deal.title.startsWith('Steam App #') ? deal.title : item.game_title;

        if (item.game_title?.startsWith('Steam App #') && deal.title && !deal.title.startsWith('Steam App #')) {
          try {
            await docClient.send(
              new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: item.PK, SK: item.SK },
                UpdateExpression: 'SET game_title = :title, updated_at = :now',
                ExpressionAttributeValues: {
                  ':title': deal.title,
                  ':now': new Date().toISOString(),
                },
              })
            );
            item.game_title = deal.title;
            console.log(`Auto-healed generic title for ${item.SK} -> "${deal.title}"`);
          } catch (autoHealErr: unknown) {
            const msg = autoHealErr instanceof Error ? autoHealErr.message : String(autoHealErr);
            console.error(`Failed to auto-heal generic title for ${item.SK}:`, msg);
          }
        }

        const effectivePrice = deal.cheaperAlternative?.salePrice ?? deal.primaryDeal?.salePrice ?? 0;
        const effectiveCut = deal.cheaperAlternative?.cutPercent ?? deal.primaryDeal?.cutPercent ?? 0;
        const regularPrice = deal.cheaperAlternative?.regularPrice ?? deal.primaryDeal?.regularPrice ?? 0;
        const sym = deal.primaryDeal?.currencySymbol || (preferredCurrency === 'BRL' ? 'R$' : '$');

        // Enforce that promotional alerts strictly require an active discount
        const hasActiveDiscount = effectiveCut > 0 && effectivePrice < regularPrice;

        const minDiscount = item.min_discount ?? 70;
        const minRating = item.min_rating ?? null;

        // Skip title if it fails the user's minimum review score requirement
        if (minRating !== null && deal.reviewScore !== null && deal.reviewScore !== undefined && deal.reviewScore < minRating) {
          continue;
        }

        let shouldAlert = false;
        let alertReason = '';
        let embedColor: number = ALERT_PALETTE.CURATED_DEAL;

        if (deal.dealType === 'FREE_TO_KEEP' || (item.alert_free && effectivePrice === 0 && (effectiveCut > 0 || regularPrice > 0))) {
          shouldAlert = true;
          alertReason = '100% FREE TO KEEP (Permanent Ownership)';
          embedColor = ALERT_PALETTE.FREE_TO_KEEP;
        } else if (deal.dealType === 'FREE_PLAY_DAYS') {
          shouldAlert = true;
          alertReason = 'FREE PLAY EVENT (Play For Free This Weekend)';
          embedColor = ALERT_PALETTE.FREE_PLAY_DAYS;
        } else if (hasActiveDiscount && item.target_price && effectivePrice <= Number(item.target_price)) {
          shouldAlert = true;
          alertReason = `TARGET PRICE REACHED (≤ ${sym} ${Number(item.target_price).toFixed(2)})`;
          embedColor = ALERT_PALETTE.ALL_TIME_LOW;
        } else if (hasActiveDiscount && effectiveCut >= minDiscount) {
          if (deal.isAllTimeLow && item.alert_all_time_low) {
            shouldAlert = true;
            alertReason = `HISTORICAL ALL-TIME LOW PRICE HIT (-${effectiveCut}% OFF)`;
            embedColor = ALERT_PALETTE.ALL_TIME_LOW;
          } else if (item.alert_steep_discount) {
            shouldAlert = true;
            alertReason = `MAJOR PROMOTION: -${effectiveCut}% OFF`;
            embedColor = ALERT_PALETTE.CURATED_DEAL;
          }
        }

        const lastNotifiedPrice = item.last_notified_price != null ? Number(item.last_notified_price) : null;
        const lastNotifiedAt = item.last_notified_at ? new Date(item.last_notified_at).getTime() : 0;
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        const isNewAlert =
          lastNotifiedPrice === null ||
          effectivePrice < lastNotifiedPrice ||
          (Date.now() - lastNotifiedAt >= ONE_DAY_MS && effectivePrice <= lastNotifiedPrice);

        if (shouldAlert && isNewAlert) {
          console.log(`DM Alert triggered for user ${userId} on ${resolvedTitle}: ${alertReason}`);

          const primarySym = deal.primaryDeal.currencySymbol || sym;
          const diffPricing = formatPriceComparisonDiff(deal.primaryDeal, deal.cheaperAlternative, primarySym);
          const fieldName = deal.cheaperAlternative
            ? `Storefront Comparison ❖ ${deal.primaryDeal.shopName} vs ${deal.cheaperAlternative.shopName}`
            : `Storefront Offer ❖ ${deal.primaryDeal.shopName}`;

          const fields: DiscordEmbedField[] = [
            {
              name: fieldName,
              value: diffPricing,
              inline: false,
            },
          ];

          if (deal.allTimeLowPrice !== null && deal.allTimeLowPrice !== undefined) {
            const atlText =
              deal.isAllTimeLow && hasActiveDiscount
                ? `**${primarySym} ${deal.allTimeLowPrice.toFixed(2)}** (★ Matches ATL)`
                : `**${primarySym} ${deal.allTimeLowPrice.toFixed(2)}**`;
            fields.push({
              name: 'Historical Low',
              value: atlText,
              inline: true,
            });
          }

          if (deal.reviewScore) {
            fields.push({
              name: 'Community Score',
              value: `▸ **${deal.reviewScore}/100** approval`,
              inline: true,
            });
          }

          const embed: DiscordEmbed = {
            title: `zT Radar ❖ Wishlist Alert: ${resolvedTitle}`,
            description: `**${alertReason}**`,
            color: embedColor,
            fields,
            footer: {
              text: 'zT Radar • Direct Wishlist Dispatch',
            },
            timestamp: new Date().toISOString(),
          };

          if (deal.imageUrl) {
            embed.image = { url: deal.imageUrl };
          }

          const components = createStoreButtons(deal);
          const sent = await sendDiscordDm(userId, embed, components);

          if (sent) {
            userDmCountMap.set(userId, currentDmCount + 1);
            try {
              await docClient.send(
                new UpdateCommand({
                  TableName: TABLE_NAME,
                  Key: { PK: item.PK, SK: item.SK },
                  UpdateExpression: 'SET last_notified_price = :price, last_notified_at = :now, game_title = :title',
                  ExpressionAttributeValues: {
                    ':price': effectivePrice,
                    ':now': new Date().toISOString(),
                    ':title': resolvedTitle,
                  },
                })
              );
            } catch (dbError) {
              console.error(`Failed to update notification state for ${item.SK}:`, dbError);
            }
          }
        }
      }
    }

    // 2. Process Global Free Game Alerts (Opted-in Users)
    const freeAlertUsers = userConfigs.filter((cfg) => cfg.alert_global_free === true);
    if (freeAlertUsers.length > 0) {
      console.log(`Processing global free game alerts for ${freeAlertUsers.length} opted-in users.`);

      const freeDealsByCurrency = new Map<string, GameDealInfo[]>();
      const neededCurrencies = new Set(freeAlertUsers.map((u) => u.preferred_currency || 'USD'));

      for (const cur of neededCurrencies) {
        try {
          const overviewDeals = await getMarketOverviewDeals(false, cur);
          const activeFree = overviewDeals.filter(
            (d) => d.dealType === 'FREE_TO_KEEP' || d.dealType === 'FREE_PLAY_DAYS'
          );
          freeDealsByCurrency.set(cur, activeFree);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to fetch overview free deals for currency ${cur}:`, msg);
          freeDealsByCurrency.set(cur, []);
        }
      }

      for (const userConfig of freeAlertUsers) {
        const userId = userConfig.user_id || userConfig.PK?.replace('USER#', '');
        const currentDmCount = userDmCountMap.get(userId) || 0;
        if (currentDmCount >= MAX_DM_PER_USER) {
          continue;
        }

        const userCurrency = userConfig.preferred_currency || 'USD';
        const deals = freeDealsByCurrency.get(userCurrency) || [];
        if (deals.length === 0) continue;

        const broadcastedHistory = Array.isArray(userConfig.last_broadcasted_free_deals)
          ? userConfig.last_broadcasted_free_deals
          : [];

        const newlySentDeals: string[] = [];

        for (const deal of deals) {
          if ((userDmCountMap.get(userId) || 0) >= MAX_DM_PER_USER) break;

          const uniqueKey = `${deal.gameId}_${deal.dealType}`;
          if (broadcastedHistory.includes(uniqueKey) || newlySentDeals.includes(uniqueKey)) {
            continue;
          }

          const isFreeToKeep = deal.dealType === 'FREE_TO_KEEP';
          const alertReason = isFreeToKeep
            ? '100% FREE TO KEEP (Permanent Ownership)'
            : 'FREE PLAY EVENT (Play For Free This Weekend)';
          const embedColor: number = isFreeToKeep ? ALERT_PALETTE.FREE_TO_KEEP : ALERT_PALETTE.FREE_PLAY_DAYS;
          const sym = deal.primaryDeal?.currencySymbol || (userCurrency === 'BRL' ? 'R$' : '$');

          const diffPricing = [
            '```diff',
            `- Regular Price:     ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
            `+ Promotional Price: ${sym} 0.00 (-100%)`,
            '```',
          ].join('\n');

          const fields: DiscordEmbedField[] = [
            {
              name: `Storefront Offer ❖ ${deal.primaryDeal.shopName}`,
              value: diffPricing,
              inline: false,
            },
          ];

          if (deal.steamAppId) {
            fields.push({
              name: 'Platform Availability',
              value: `▸ Steam AppID: \`${deal.steamAppId}\`\n▸ Claim via: **${deal.primaryDeal.shopName}**`,
              inline: true,
            });
          }

          const expiryText = formatExpiryAvailability(deal.expiry || deal.primaryDeal?.expiry);
          const embed: DiscordEmbed = {
            title: `zT Radar ❖ Free Game Alert: ${deal.title}`,
            description: `**${alertReason}**\nThis promotion was detected live on ${deal.primaryDeal.shopName}.\n${expiryText}`,
            color: embedColor,
            fields,
            footer: {
              text: 'zT Radar • Global Free Play Radar Dispatch',
            },
            timestamp: new Date().toISOString(),
          };

          if (deal.imageUrl) {
            embed.image = { url: deal.imageUrl };
          }

          const components = createStoreButtons(deal);
          const sent = await sendDiscordDm(userId, embed, components);

          if (sent) {
            const newCount = (userDmCountMap.get(userId) || 0) + 1;
            userDmCountMap.set(userId, newCount);
            newlySentDeals.push(uniqueKey);
          }
        }

        if (newlySentDeals.length > 0) {
          const updatedHistory = [...broadcastedHistory, ...newlySentDeals].slice(-50);
          try {
            await docClient.send(
              new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: userConfig.PK, SK: userConfig.SK },
                UpdateExpression: 'SET last_broadcasted_free_deals = :deals, last_free_alert_at = :now',
                ExpressionAttributeValues: {
                  ':deals': updatedHistory,
                  ':now': new Date().toISOString(),
                },
              })
            );
          } catch (dbErr) {
            console.error(`Failed to update free deal history for ${userConfig.PK}:`, dbErr);
          }
        }
      }
    }

    // 3. Process Curated Server Channel Radar
    if (guildConfigs.length > 0) {
      for (const config of guildConfigs) {
        if (!config.alert_channel_id) continue;

        const targetCurrency = config.currency || 'USD';
        const targetMinDiscount = config.min_discount ?? 70;
        const targetFreeOnly = config.free_only ?? false;
        const targetMinRating = config.min_rating ?? 80;
        const includeThirdParty = config.include_third_party ?? false;
        const broadcastedHistory = config.last_broadcasted_deals || [];

        const marketDeals = await getMarketOverviewDeals(includeThirdParty, targetCurrency);

        let sentThisRun = 0;
        const newlyBroadcastedKeys: string[] = [];

        for (const deal of marketDeals) {
          if (sentThisRun >= 3) break;

          const isFree = deal.primaryDeal?.salePrice === 0;
          const cut = deal.primaryDeal?.cutPercent ?? 0;
          const isFreeWeekend = deal.dealType === 'FREE_PLAY_DAYS';
          const isFreeToKeep = deal.dealType === 'FREE_TO_KEEP';
          const uniqueDealKey = `${deal.gameId}_${deal.primaryDeal.salePrice}_${deal.dealType}`;

          if (broadcastedHistory.includes(uniqueDealKey) || newlyBroadcastedKeys.includes(uniqueDealKey)) {
            continue;
          }

          if (targetFreeOnly && !isFree) continue;
          if (!targetFreeOnly && !isFree && cut < targetMinDiscount) continue;

          if (!isFree && deal.reviewScore && deal.reviewScore < targetMinRating) {
            continue;
          }

          const sym = deal.primaryDeal.currencySymbol || (targetCurrency === 'BRL' ? 'R$' : '$');

          let embedColor: number = ALERT_PALETTE.CURATED_DEAL;
          let bannerHeadline = `High-value promotion detected (**-${cut}%**)!`;

          let expiryNotice = '';
          if (isFreeToKeep || isFreeWeekend || deal.expiry || deal.primaryDeal?.expiry) {
            expiryNotice = `\n${formatExpiryAvailability(deal.expiry || deal.primaryDeal?.expiry)}`;
          }

          let diffPricing: string;
          if (isFreeToKeep) {
            embedColor = ALERT_PALETTE.FREE_TO_KEEP;
            bannerHeadline = 'Claim this game for **FREE** to keep permanently in your library!';
            diffPricing = [
              '```diff',
              `- Regular Price: ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
              '+ Promotional:   100% FREE TO KEEP (Permanent Ownership)',
              '```',
            ].join('\n');
          } else if (isFreeWeekend) {
            embedColor = ALERT_PALETTE.FREE_PLAY_DAYS;
            bannerHeadline = 'Limited-time **Free Weekend / Play For Free** event active!';
            diffPricing = [
              '```diff',
              `- Regular Price: ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
              '+ Temporary:     FREE PLAY EVENT (Active Weekend Access)',
              '```',
            ].join('\n');
          } else if (deal.cheaperAlternative) {
            diffPricing = formatPriceComparisonDiff(deal.primaryDeal, deal.cheaperAlternative, sym);
          } else {
            diffPricing = [
              '```diff',
              `- Regular Price: ${sym} ${deal.primaryDeal.regularPrice.toFixed(2)}`,
              `+ Sale Price:    ${sym} ${deal.primaryDeal.salePrice.toFixed(2)} (-${deal.primaryDeal.cutPercent}%)`,
              '```',
            ].join('\n');
          }

          const fieldName = !isFree && deal.cheaperAlternative
            ? `Storefront Comparison ❖ ${deal.primaryDeal.shopName} vs ${deal.cheaperAlternative.shopName}`
            : `Store Offer ❖ ${deal.primaryDeal.shopName}`;

          const fields: DiscordEmbedField[] = [
            {
              name: fieldName,
              value: diffPricing,
              inline: false,
            },
          ];

          if (deal.reviewScore) {
            fields.push({
              name: 'Community Evaluation',
              value: `▸ Score: **${deal.reviewScore}/100** approval rating`,
              inline: true,
            });
          }

          const embed: DiscordEmbed = {
            title: `zT Radar ❖ ${deal.title}`,
            description: `${bannerHeadline}${expiryNotice}`,
            color: embedColor,
            fields,
            footer: {
              text: `zT Radar • Curated Deal Broadcast (${targetCurrency})`,
            },
            timestamp: new Date().toISOString(),
          };

          if (deal.imageUrl) {
            embed.image = { url: deal.imageUrl };
          }

          const components = createStoreButtons(deal);
          const sent = await sendGuildChannelAlert(config.alert_channel_id, embed, components);

          if (sent) {
            sentThisRun++;
            newlyBroadcastedKeys.push(uniqueDealKey);
          }
        }

        if (newlyBroadcastedKeys.length > 0) {
          const updatedHistory = [...broadcastedHistory, ...newlyBroadcastedKeys].slice(-50);
          try {
            await docClient.send(
              new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: config.PK, SK: config.SK },
                UpdateExpression: 'SET last_broadcasted_deals = :history, updated_at = :now',
                ExpressionAttributeValues: {
                  ':history': updatedHistory,
                  ':now': new Date().toISOString(),
                },
              })
            );
          } catch (dbError) {
            console.error(`Failed to update broadcast history for guild ${config.guild_id}:`, dbError);
          }
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Scan and notifications processed successfully.' }),
    };
  } catch (error) {
    console.error('Fatal error during scheduled deal scanner execution:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
