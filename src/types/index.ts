/**
 * zT Radar — Canonical Domain Type Definitions
 *
 * Shared TypeScript interfaces for Discord interactions, DynamoDB entities,
 * Steam/ITAD telemetry models, and platform status. All types are derived
 * from the actual runtime shapes observed in the live handlers and utilities.
 */

// ---------------------------------------------------------------------------
// Discord Interaction Payload
// ---------------------------------------------------------------------------

/** A single resolved option value from a Discord application command. */
export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: any;
  options?: DiscordInteractionOption[];
  focused?: boolean;
}

/** Partial user object as returned inside a Discord interaction. */
export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar?: string | null;
}

/** Guild member partial included in guild-scoped interactions. */
export interface DiscordMember {
  user?: DiscordUser;
  nick?: string | null;
  roles: string[];
  permissions?: string;
}

/** Data payload nested inside an APPLICATION_COMMAND or AUTOCOMPLETE interaction. */
export interface DiscordInteractionData {
  id: string;
  name: string;
  type: number;
  options?: DiscordInteractionOption[];
  /** Present on component interactions (button custom_id). */
  custom_id?: string;
  /** Component type for message component interactions. */
  component_type?: number;
}

/**
 * Shape of the raw JSON body delivered by Discord to the interactions webhook.
 * Covers ping (type 1), slash commands (type 2), message components (type 3),
 * autocomplete (type 4), and modal submits (type 5).
 */
export interface DiscordInteractionPayload {
  /** Interaction type: 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT, 4=APPLICATION_COMMAND_AUTOCOMPLETE */
  type: number;
  id: string;
  application_id: string;
  token: string;
  version: number;
  data?: DiscordInteractionData;
  guild_id?: string;
  channel_id?: string;
  member?: DiscordMember;
  user?: DiscordUser;
}

// ---------------------------------------------------------------------------
// Steam Owned Game (IPlayerService/GetOwnedGames)
// ---------------------------------------------------------------------------

/**
 * A single game entry as returned by the Steam Web API
 * IPlayerService/GetOwnedGames/v1 with include_appinfo=1.
 */
export interface SteamOwnedGame {
  /** Steam Application ID. */
  appid: number;
  /** Display name of the game. */
  name: string;
  /** Total playtime in minutes across all sessions. */
  playtime_forever: number;
  /** Icon hash used to construct CDN URLs. May be null for unlisted titles. */
  img_icon_url: string | null;
  /** Whether this is a Free-to-Play title (not always present). */
  is_free?: boolean;
  /** Whether this is a Free-to-Play title (Steam API alias). */
  is_free_to_play?: boolean;
  /** Playtime in the last two weeks, in minutes. */
  playtime_2weeks?: number;
  /** Steam categories array, if populated. */
  categories?: Array<{ id?: number | string; description?: string }>;
}

// ---------------------------------------------------------------------------
// Store Deal — Primary and Alternative Offer
// ---------------------------------------------------------------------------

/** A resolved, normalized price offer from a single authorized storefront. */
export interface StoreDeal {
  /** Display name of the storefront (Steam, Epic Games Store, GOG, Nuuvem). */
  shopName: string;
  /** Current promotional sale price in the user's preferred currency. */
  salePrice: number;
  /** Full undiscounted retail price. */
  regularPrice: number;
  /** Integer percentage discount (0–100). */
  cutPercent: number;
  /** Canonical deep-link URL to the store page. */
  url: string;
  /** ISO 8601 string or Unix timestamp of promotion expiry. Null if perpetual. */
  expiry: string | number | null;
  /** ISO 4217 currency code (USD, BRL). */
  currency: string;
  /** Localized currency symbol ($ or R$). */
  currencySymbol: string;
}

/**
 * Fully resolved game deal info returned by getGameDealInfo().
 * Aggregates Steam Store data, ITAD multi-store comparison, and historical low.
 */
export interface GameDealInfo {
  /** Composite game ID: "steam_<appId>" or ITAD UUID. */
  gameId: string;
  /** Resolved display title. */
  title: string;
  /** CDN URL of the game's header banner image. Null if unavailable. */
  imageUrl: string | null;
  /** Metacritic or community review score (0–100). Null if not available. */
  reviewScore: number | null;
  /** Steam Application ID as a string. Null for ITAD-only (Epic exclusives). */
  steamAppId: string | null;
  /** Deal classification: FREE_TO_KEEP, FREE_PLAY_DAYS, or CURATED_DEAL. */
  dealType: 'FREE_TO_KEEP' | 'FREE_PLAY_DAYS' | 'CURATED_DEAL';
  /** Whether the effective price matches the historical all-time low. */
  isAllTimeLow?: boolean;
  /** Historical all-time low price. Null if ITAD data is unavailable. */
  allTimeLowPrice?: number | null;
  /** Promotion expiry timestamp or null if perpetual. */
  expiry?: string | number | null;
  /** The primary monitored storefront offer (Steam by default). */
  primaryDeal: StoreDeal;
  /** A cheaper alternative offer from another authorized store, if present. */
  cheaperAlternative?: StoreDeal | null;
  /** Raw per-store breakdown keyed by store name. */
  storeBreakdown?: Record<string, StoreDeal>;
}

// ---------------------------------------------------------------------------
// Backlog Telemetry
// ---------------------------------------------------------------------------

/**
 * Backlog analysis metrics produced by filterBacklogData() and
 * calculateBacklogTelemetry() in steamWeb.js.
 */
export interface BacklogTelemetry {
  /** Total number of paid (non-F2P) games in the library. */
  totalPaidCount: number;
  /** Alias for totalPaidCount. */
  totalPaidGames: number;
  /** Number of paid games with less than 60 minutes of playtime (backlog). */
  unplayedCount: number;
  /** Alias for unplayedCount. */
  unplayedPaidCount: number;
  /** Number of paid games with 60+ minutes of playtime. */
  playedCount: number;
  /** Number of backlog games with exactly 0 minutes played. */
  neverPlayedCount: number;
  /** Alias for neverPlayedCount. */
  neverOpenedCount: number;
  /** Number of backlog games with 1–59 minutes played. */
  startedCount: number;
  /** Alias for startedCount. */
  abandonedCount: number;
  /** Backlog ratio as a percentage (unplayed / total paid * 100). */
  backlogRatio: number;
  /** Alias for backlogRatio. */
  backlogRatioPercent: number;
  /** ISO 4217 currency symbol ($ or R$). */
  currencySymbol: string;
  /** Preferred currency code used for MSRP calculation. */
  preferredCurrency: string;
  /** Sorted list of unplayed paid games (ascending by playtime). */
  backlogGames: SteamOwnedGame[];
  /** Computed total MSRP for unplayed titles with known store prices. */
  totalMsrp?: number;
  /** Count of backlog titles for which a store price was resolved. */
  pricedCount?: number;
  /** Human-readable MSRP string: "$ 123.45". */
  msrpFormatted?: string;
  /** MSRP summary string including priced fraction: "$ 123.45 (30/50 priced)". */
  msrpSummary?: string;
  /** Map of appId → formatted store price label (present in full telemetry). */
  storePricesMap?: Record<number, string>;
}

// ---------------------------------------------------------------------------
// DynamoDB Single-Table Wishlist Item
// ---------------------------------------------------------------------------

/**
 * Shape of a monitored game record stored in the DynamoDB single-table design.
 * Partition key: USER#<discordUserId>, Sort key: GAME#<external_game_id>.
 */
export interface DynamoDbWishlistItem {
  /** Partition key: "USER#<discordUserId>" */
  PK: string;
  /** Sort key: "GAME#<externalGameId>" (e.g. "GAME#steam_1086940") */
  SK: string;
  /** Display title of the tracked game. */
  game_title: string;
  /** Composite game identifier (e.g. "steam:1086940" or ITAD UUID). */
  external_game_id: string;
  /** Discord user ID of the owner. */
  user_id: string;
  /** Target price threshold in the user's currency. Null if not set. */
  target_price?: number | null;
  /** Minimum discount percentage to trigger an alert (default: 70). */
  min_discount?: number;
  /** Minimum review score required to trigger an alert. */
  min_rating?: number | null;
  /** Whether to alert when the game is offered 100% free to keep. */
  alert_free?: boolean;
  /** Whether to alert when the game hits its historical all-time low. */
  alert_all_time_low?: boolean;
  /** Whether to alert on any major promotional discount above threshold. */
  alert_steep_discount?: boolean;
  /** Price at the time of the last sent notification. */
  last_notified_price?: number | null;
  /** ISO 8601 timestamp of the last sent notification. */
  last_notified_at?: string | null;
  /** ISO 8601 creation timestamp. */
  created_at?: string;
  /** ISO 8601 last-update timestamp. */
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Steam Player Profile Types
// ---------------------------------------------------------------------------

/** Normalized player summary from IPlayerService/GetPlayerSummaries. */
export interface SteamPlayerSummary {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarUrl: string | null;
  visibilityState: number;
  isPrivate: boolean;
  personaState: number;
  personaStateLabel: string;
  currentlyPlaying: string | null;
  currentlyPlayingId: string | null;
  timeCreated: string | null;
  countryCode: string | null;
  realName: string | null;
}

/** VAC and community ban record from IPlayerService/GetPlayerBans. */
export interface SteamPlayerBans {
  communityBanned: boolean;
  vacBanned: boolean;
  vacBansCount: number;
  gameBansCount: number;
  daysSinceLastBan: number;
  economyBan: string;
}

/** Compact top-games result from getPlayerOwnedGames. */
export interface SteamTopGamesResult {
  isPrivate: boolean;
  gameCount: number;
  totalPlaytimeHours: string;
  topGames: Array<{
    appId: number;
    name: string;
    playtimeHours: string;
    playtimeMinutes: number;
  }>;
}

/** Detailed library result from getPlayerLibraryDetailed. */
export interface SteamDetailedLibrary {
  isPrivate: boolean;
  gameCount: number;
  games: SteamOwnedGame[];
}

/** Full result from getCompletePlayerProfile. */
export type SteamCompleteProfile =
  | { success: false; error: string; steamId?: string }
  | { success: true; steamId: string; summary: SteamPlayerSummary; bans: SteamPlayerBans | null; games: SteamTopGamesResult | null };

/** Steam wishlist resolution result. */
export type SteamWishlistResult =
  | { success: false; error: string }
  | { success: true; items: Array<{ appId: string; priority: number; dateAdded: number }> };

// ---------------------------------------------------------------------------
// Steam Price Info
// ---------------------------------------------------------------------------

/** Per-app price record produced by batchFetchSteamAppPrices. */
export interface SteamAppPriceInfo {
  initial?: number;
  final?: number;
  initialFormatted?: string;
  finalFormatted?: string;
  isFree?: boolean;
  isDelisted?: boolean;
  price?: number;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Library Comparison (compareLibraryData / compareLibraries)
// ---------------------------------------------------------------------------

/** A single game entry from the library intersection comparison. */
export interface CommonGame {
  appid: number;
  name: string;
  playtimeA: number;
  playtimeB: number;
  totalPlaytime: number;
  winner: 'A' | 'B' | 'TIE';
  diffMinutes: number;
  hoursA: string;
  hoursB: string;
  diffHours: string;
}

/** Pure comparison analytics from compareLibraryData. */
export interface LibraryComparisonResult {
  commonCount: number;
  totalCommon: number;
  winsA: number;
  winsB: number;
  ties: number;
  overallWinner: 'A' | 'B' | 'TIE';
  totalHoursA: string;
  totalHoursB: string;
  commonGames: CommonGame[];
}

/** Achievement record for a specific game. */
export interface AchievementResult {
  total: number;
  unlocked: number;
  percent: number;
  gameName: string | null;
}

/** Top-game achievement record within compareLibraries output. */
export interface TopAchievements {
  appId: number;
  gameName: string;
  achA: AchievementResult;
  achB: AchievementResult;
}

/** Full result from compareLibraries. */
export type LibraryCompareResult =
  | { success: false; error: string; privatePlayer?: string; countA?: number; countB?: number }
  | (LibraryComparisonResult & { success: true; countA: number; countB: number; topAchievements: TopAchievements | null });

// ---------------------------------------------------------------------------
// Game Match (findMatchingGames / matchLibraryData)
// ---------------------------------------------------------------------------

/** A game entry produced by matchLibraryData with multiplayer badge resolution. */
export interface MatchedGame {
  appid: number;
  name: string;
  playtimeA: number;
  playtimeB: number;
  totalPlaytime: number;
  hoursA: string;
  hoursB: string;
  totalHours: string;
  badges: string[];
  isCoop: boolean;
  isCoopOrMultiplayer: boolean;
  img_icon_url: string | null;
}

/** Result from matchLibraryData. */
export interface MatchLibraryResult {
  success?: boolean;
  totalCommon: number;
  matchedCount: number;
  filterMode: string;
  games: MatchedGame[];
  matchingGames: MatchedGame[];
}

/** Full result from findMatchingGames. */
export type FindMatchingGamesResult =
  | { success: false; error: string; privatePlayer?: string; countA?: number; countB?: number }
  | (MatchLibraryResult & { success: true; steamIdA: string; steamIdB: string; countA: number; countB: number });

// ---------------------------------------------------------------------------
// Backlog MSRP Result
// ---------------------------------------------------------------------------

/** MSRP calculation result from calculateBacklogMsrp. */
export interface BacklogMsrpResult {
  totalMsrp: number;
  pricedCount: number;
  totalUnplayed: number;
  totalBacklog: number;
  currencySymbol: string;
  msrpFormatted: string;
  formattedTotalMsrp: string;
  msrpSummary: string;
}

/** Full telemetry result from calculateBacklogTelemetry. */
export type BacklogTelemetryResult =
  | { success: false; error: string; gameCount?: number }
  | (BacklogTelemetry & BacklogMsrpResult & { success: true; storePricesMap: Record<number, string> });

// ---------------------------------------------------------------------------
// Platform Status
// ---------------------------------------------------------------------------

/** Possible platform health status values. */
export type PlatformStatusValue = 'ONLINE' | 'DEGRADED' | 'OUTAGE' | 'OFFLINE' | 'UNKNOWN';

/** Status record for a single platform endpoint. */
export interface PlatformStatusEntry {
  name: string;
  status: PlatformStatusValue;
  latencyMs: number;
}

/** Aggregate result from checkPlatformStatuses(). */
export interface PlatformStatusResult {
  steam: PlatformStatusEntry;
  epic: PlatformStatusEntry;
  psn: PlatformStatusEntry;
  xbox: PlatformStatusEntry;
}

/** A single ranked entry from getSteamMostPlayedGames(). */
export interface SteamMostPlayedEntry {
  rank: number;
  appId: number;
  name: string;
  currentPlayers: number;
  peakToday: number | null;
}

/** A single ranked entry from getSteamTrendingGames(). */
export interface SteamTrendingEntry {
  rank: number;
  appId: number;
  name: string;
  currentPlayers: number | null;
  priceText: string;
  headerImage: string | null;
}

// ---------------------------------------------------------------------------
// Discord Embed Components
// ---------------------------------------------------------------------------

/** A generic Discord embed field. */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/** A Discord embed object. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name: string; icon_url?: string };
}

/** A Discord button component. */
export interface DiscordButton {
  type: 2;
  style: number;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

/** A Discord action row containing buttons. */
export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

/** Paginated embed payload returned by embed builder functions. */
export interface EmbedPayload {
  embed: DiscordEmbed;
  embeds: DiscordEmbed[];
  components: DiscordActionRow[];
}

// ---------------------------------------------------------------------------
// HowLongToBeat Stats
// ---------------------------------------------------------------------------

/** Playtime completion stats returned by getHowLongToBeatStats. */
export interface HltbStatsResult {
  success: boolean;
  error?: string;
  gameId?: number;
  gameTitle?: string;
  mainStoryHours?: number;
  mainExtraHours?: number;
  completionistHours?: number;
  allPlayStylesHours?: number;
  imageUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Steam Intelligence (News & System Requirements)
// ---------------------------------------------------------------------------

/** News announcement item returned by fetchGameNews. */
export interface SteamNewsItem {
  title: string;
  url: string;
  author: string;
  date: string;
  snippet: string;
}

/** Hardware specifications record returned by fetchSystemRequirements. */
export interface SystemRequirementsInfo {
  title: string;
  headerImage: string | null;
  minimum: string;
  recommended: string;
}

// ---------------------------------------------------------------------------
// Discord Application Command Autocomplete
// ---------------------------------------------------------------------------

/** Single autocomplete choice item for Discord interactions. */
export interface AutocompleteChoice {
  name: string;
  value: string;
}

// ---------------------------------------------------------------------------
// DynamoDB Guild Configuration Item
// ---------------------------------------------------------------------------

/** Single-table guild configuration record (PK: GUILD#<guildId>, SK: CONFIG). */
export interface GuildConfigItem {
  PK: string;
  SK: string;
  channel_id?: string;
  min_discount?: number;
  created_at?: string;
  updated_at?: string;
}

