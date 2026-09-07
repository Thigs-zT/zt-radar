import dotenv from 'dotenv';
dotenv.config();

import { getMarketOverviewDeals } from '../src/utils/itadApi.js';

async function testFinal() {
  console.log('=== TESTING GET_MARKET_OVERVIEW_DEALS ===\n');
  const deals = await getMarketOverviewDeals(false);
  console.log(`Total curated games discovered: ${deals.length}\n`);

  deals.slice(0, 10).forEach((d, i) => {
    console.log(`[#${i + 1}] ${d.title} (${d.primaryDeal.shopName})`);
    console.log(`     Discount: -${d.primaryDeal.cutPercent}% | Price: $ ${d.primaryDeal.salePrice}`);
    console.log(`     Review Score: ${d.reviewScore ? d.reviewScore + '/100' : 'Unrated'}`);
  });
}

testFinal();