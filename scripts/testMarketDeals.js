import dotenv from 'dotenv';
dotenv.config();

import { getMarketOverviewDeals } from '../src/utils/itadApi.js';

async function testFinal() {
  console.log('=== TESTANDO GET_MARKET_OVERVIEW_DEALS ===\n');
  const deals = await getMarketOverviewDeals(false);
  console.log(`Total de jogos curados encontrados: ${deals.length}\n`);

  deals.slice(0, 10).forEach((d, i) => {
    console.log(`[#${i + 1}] ${d.title} (${d.primaryDeal.shopName})`);
    console.log(`     Desconto: -${d.primaryDeal.cutPercent}% | Preço: $ ${d.primaryDeal.salePrice}`);
    console.log(`     Nota: ${d.reviewScore ? d.reviewScore + '/100' : 'Sem nota'}`);
  });
}

testFinal();