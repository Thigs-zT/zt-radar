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
            description: 'Target price in BRL (e.g. 50.00)',
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
            description: 'Game name to remove',
            type: 3, // STRING
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: 'list',
        description: 'List all games currently on your monitored wishlist',
        type: 1, // SUB_COMMAND
      },
    ],
  },
  {
    name: 'config-channel',
    description: 'Configure a server channel to receive public game deal alerts',
    default_member_permissions: '32', // MANAGE_GUILD
    options: [
      {
        name: 'channel',
        description: 'The text channel where alerts will be published',
        type: 7, // CHANNEL
        channel_types: [0], // GUILD_TEXT
        required: true,
      },
    ],
  },
  {
    name: 'radar-help',
    description: 'Display detailed guide on how to use zT Radar commands and deal alerts',
  },
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

  console.log('Registering global slash commands with Discord...');

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