import dotenv from 'dotenv';

// Load .env.dev if specified via ENV_FILE, otherwise default to standard .env
const envPath = process.env.ENV_FILE || '.env';
dotenv.config({ path: envPath });

const APPLICATION_ID = process.env.DISCORD_APP_ID || process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export const commands = [
  {
    name: 'compare',
    description: 'Compare current deals and historical low prices across verified stores',
    options: [
      {
        name: 'game',
        description: 'Game name to compare prices',
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'can-it-run',
    description: 'Check official minimum and recommended PC hardware requirements for a game',
    options: [
      {
        name: 'game',
        description: 'Game name to check hardware specifications',
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'game-news',
    description: 'Display the latest official patch notes and announcements for a game',
    options: [
      {
        name: 'game',
        description: 'Game name to check recent updates',
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'how-long-to-beat',
    description: 'Analyze average completion times and Cost-per-Hour entertainment metrics',
    options: [
      {
        name: 'game',
        description: 'Game name to inspect playtime metrics',
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'steam-trending',
    description: 'Display top 10 trending and surging titles on the Steam Storefront',
  },
  {
    name: 'steam-most-played',
    description: 'Display official top 10 most-played games on Steam by live concurrent player count',
  },
  {
    name: 'platform-status',
    description: 'Check live operational availability and latency across major gaming networks',
  },
  {
    name: 'wishlist',
    description: 'Manage your monitored game deal wishlist',
    options: [
      {
        name: 'add',
        description: 'Add a game to your monitoring wishlist',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'game',
            description: 'Game name to monitor',
            type: 3, // STRING
            required: true,
            autocomplete: true,
          },
          {
            name: 'target_price',
            description: 'Target price in your preferred currency (e.g. 15.00 or 50.00)',
            type: 10, // NUMBER
            required: false,
          },
        ],
      },
      {
        name: 'remove',
        description: 'Remove a game from your monitoring wishlist',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'game',
            description: 'Game name to remove from your tracked wishlist',
            type: 3, // STRING
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: 'clear',
        description: 'Remove all games from your monitored wishlist',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'list',
        description: 'List all games currently on your monitored wishlist',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'sync-steam',
        description: 'Import and synchronize your public Steam wishlist games into zT Radar tracking',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'target',
            description: 'Optional SteamID64 or custom vanity URL override (defaults to your linked account)',
            type: 3, // STRING
            required: false,
          },
          {
            name: 'min_discount',
            description: 'Minimum discount percentage required to trigger alerts (default: 70)',
            type: 4, // INTEGER
            min_value: 10,
            max_value: 100,
            required: false,
          },
          {
            name: 'min_rating',
            description: 'Minimum Steam review score out of 100 required to trigger alerts',
            type: 4, // INTEGER
            min_value: 0,
            max_value: 100,
            required: false,
          },
        ],
      },
    ],
  },
  {
    name: 'currency',
    description: 'Set your preferred currency for personal wishlist alerts',
    options: [
      {
        name: 'choice',
        description: 'Choose between US Dollars (USD) or Brazilian Reais (BRL)',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'USD ($) - US Dollars (Default)', value: 'USD' },
          { name: 'BRL (R$) - Brazilian Reais', value: 'BRL' },
        ],
      },
    ],
  },
  {
    name: 'config-channel',
    description: 'Configure server channel for curated Steam & Epic deal broadcasts',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        name: 'channel',
        description: 'The text channel where curated deal alerts will be published',
        type: 7, // CHANNEL
        channel_types: [0], // GUILD_TEXT
        required: true,
      },
      {
        name: 'currency',
        description: 'Preferred currency for broadcasted prices (default: USD)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'USD ($) - US Dollars (Default)', value: 'USD' },
          { name: 'BRL (R$) - Brazilian Reais', value: 'BRL' },
        ],
      },
      {
        name: 'include_third_party',
        description: 'Compare prices with GOG and Nuuvem alongside Steam & Epic (default: false)',
        type: 5, // BOOLEAN
        required: false,
      },
      {
        name: 'free_only',
        description: 'Only broadcast 100% free promotional giveaways (default: false)',
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
  {
    name: 'config-channel-experimental',
    description: '[Experimental] Override standard heuristic quality filters for server broadcasts',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        name: 'min_discount',
        description: 'Custom minimum discount percentage override (default: 70)',
        type: 4, // INTEGER
        min_value: 10,
        max_value: 100,
        required: false,
      },
      {
        name: 'min_rating',
        description: 'Custom minimum review score out of 100 override (default: 80)',
        type: 4, // INTEGER
        min_value: 0,
        max_value: 100,
        required: false,
      },
    ],
  },
  {
    name: 'config-channel-remove',
    description: 'Disable and remove the configured deals alert channel for this server',
    default_member_permissions: '32', // MANAGE_GUILD
  },
  {
    name: 'radar-status',
    description: 'Check zT Radar system health, active configurations, and telemetry',
  },
  {
    name: 'radar-help',
    description: 'Display detailed guide on how to use zT Radar commands and deal alerts',
  },
  {
    name: 'steam-link',
    description: 'Link your Steam account to zT Radar for quick profile checks and wishlist sync',
    options: [
      {
        name: 'target',
        description: 'SteamID64, profile URL, or vanity URL — omit to link via Valve OpenID',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'steam-profile',
    description: 'Inspect comprehensive Steam profile intelligence, ban records, and library statistics',
    options: [
      {
        name: 'user',
        description: 'Discord user to inspect linked Steam profile',
        type: 6, // USER
        required: false,
      },
      {
        name: 'target',
        description: 'SteamID64, profile URL, or custom vanity URL to inspect directly',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'game-match',
    description: 'Find common games and co-op titles between two Steam libraries',
    options: [
      {
        name: 'target1',
        description: 'First Steam user (mention @user, SteamID64, or vanity custom URL)',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'target2',
        description: 'Second Steam user (mention @user, SteamID64, or vanity custom URL)',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'filter',
        description: 'Filter library match mode (default: co-op games)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'Co-op & Multiplayer Only', value: 'coop' },
          { name: 'All Shared Games', value: 'all' },
        ],
      },
    ],
  },
  {
    name: 'steam-duel',
    description: 'Duel two Steam libraries comparing playtime and achievement dominance on common games',
    options: [
      {
        name: 'target1',
        description: '@user mention, SteamID64, profile URL, or custom vanity',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'target2',
        description: '@user mention, SteamID64, profile URL, or custom vanity',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'steam-backlog',
    description: 'Analyze unplayed paid games, backlog percentage, and estimated wasted library value',
    options: [
      {
        name: 'target',
        description: 'Optional @user mention, SteamID64, or profile URL (defaults to caller)',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'free-play-radar',
    description: 'Inspect all active 100% free games to keep and temporary Free Weekend events',
  },
  {
    name: 'free-radar-dm',
    description: 'Toggle automated direct message alerts for all free games and free weekends',
    options: [
      {
        name: 'enabled',
        description: 'Enable or disable global free game alerts in your DMs',
        type: 5, // BOOLEAN
        required: true,
      },
    ],
  },
];

export async function registerCommands() {
  if (!APPLICATION_ID || !BOT_TOKEN) {
    console.error(`Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN in ${envPath}`);
    process.exit(1);
  }

  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

  console.log(`Registering commands with Discord (${envPath})...`);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    console.log(`Successfully registered ${data.length} commands with Discord!`);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

const isDirectRun = process.argv[1] && (process.argv[1].endsWith('registerCommands.js') || process.argv[1].includes('registerCommands'));
if (isDirectRun) {
  registerCommands();
}