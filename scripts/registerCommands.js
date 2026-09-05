import dotenv from 'dotenv';
dotenv.config();

const APPLICATION_ID = process.env.DISCORD_APP_ID || process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

const commands = [
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
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

  console.log('Registering slash commands including /compare with Discord...');

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

registerCommands();