import dotenv from 'dotenv';
dotenv.config();

import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

async function resolveTableName() {
  if (process.env.TABLE_NAME) return process.env.TABLE_NAME;
  const res = await ddbClient.send(new ListTablesCommand({}));
  const table = (res.TableNames || []).find((t) => t.includes('zt-radar') || t.includes('DealsTable'));
  if (!table) throw new Error('Could not find zT Radar DynamoDB table in AWS account.');
  return table;
}

async function resetHistory() {
  try {
    const tableName = await resolveTableName();
    console.log(`Using DynamoDB table: ${tableName}`);
    console.log('Resetting guild broadcast histories in DynamoDB...');

    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
      })
    );

    const guildConfigs = (scanResult.Items || []).filter(
      (item) => item.PK?.startsWith('GUILD#') && item.SK === 'CONFIG'
    );

    console.log(`Found ${guildConfigs.length} guild configs.`);

    for (const guild of guildConfigs) {
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: guild.PK, SK: guild.SK },
          UpdateExpression: 'SET last_broadcasted_deals = :empty',
          ExpressionAttributeValues: { ':empty': [] },
        })
      );
      console.log(`Reset history for Guild: ${guild.guild_id} (Channel: ${guild.alert_channel_id})`);
    }

    console.log('History reset complete! You can now trigger deal tests again.');
  } catch (error) {
    console.error('Error resetting broadcast history:', error);
  }
}

resetHistory();