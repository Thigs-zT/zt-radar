import 'dotenv/config';
import axios from 'axios';

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!appId || !token) {
  console.error('Error: DISCORD_APP_ID and DISCORD_BOT_TOKEN must be set in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'wishlist',
    description: 'Manage your tracked games wishlist',
    options: [
      {
        name: 'add',
        description: 'Add a game to your wishlist for deal monitoring',
        type: 1,
        options: [
          {
            name: 'game',
            description: 'Start typing to search for a game',
            type: 3,
            required: true,
            autocomplete: true
          },
          {
            name: 'target_price',
            description: 'Optional maximum target price in USD (e.g., 20)', // Updated label
            type: 10,
            required: false
          }
        ]
      },
      {
        name: 'remove', // NEW SUBCOMMAND
        description: 'Remove a game from your tracked wishlist',
        type: 1,
        options: [
          {
            name: 'game',
            description: 'Start typing to search for a game to remove',
            type: 3,
            required: true,
            autocomplete: true // We can use autocomplete here too!
          }
        ]
      },
      {
        name: 'list',
        description: 'List all games saved in your wishlist',
        type: 1
      }
    ]
  }
];

async function registerSlashCommands() {
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;

  try {
    console.log('Registering slash commands with Discord API...');
    const response = await axios.put(url, commands, {
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('Slash commands registered successfully with remove and clarified pricing!');
    console.log('Active commands:', response.data.map(c => `/${c.name}`).join(', '));
  } catch (error) {
    console.error('Failed to register commands:', error.response?.data || error.message);
  }
}

registerSlashCommands();