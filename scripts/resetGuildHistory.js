import dotenv from 'dotenv';
dotenv.config();

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const TABLE_NAME = process.env.TABLE_NAME || 'zt-radar-table';

async function resetHistory() {
  console.log('Resetting guild broadcast histories in DynamoDB...');

  try {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
      })
    );

    const guildConfigs = (scanResult.Items || []).filter(
      (item) => item.PK?.startsWith('GUILD#') && item.SK === 'CONFIG'
    );

    for (const guild of guildConfigs) {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: guild.PK, SK: guild.SK },
          UpdateExpression: 'SET last_broadcasted_deals = :empty',
          ExpressionAttributeValues: { ':empty': [] },
        })
      );
      console.log(`Reset history for Guild: ${guild.guild_id}`);
    }

    console.log('History reset complete! You can now trigger deal tests again.');
  } catch (error) {
    console.error('Error resetting broadcast history:', error);
  }
}

resetHistory();