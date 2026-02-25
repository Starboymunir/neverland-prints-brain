require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  try {
    const { count: total } = await sb.from('assets').select('id', { count: 'exact', head: true });
    const { count: withDesc } = await sb.from('assets').select('id', { count: 'exact', head: true })
      .not('description', 'is', null).neq('description', '');
    const { count: synced } = await sb.from('assets').select('id', { count: 'exact', head: true })
      .eq('shopify_status', 'synced');
    const { count: withProduct } = await sb.from('assets').select('id', { count: 'exact', head: true })
      .not('shopify_product_id', 'is', null);
    const { count: noProduct } = await sb.from('assets').select('id', { count: 'exact', head: true })
      .is('shopify_product_id', null);
    console.log('Total assets:', total);
    console.log('With description:', withDesc);
    console.log('Need description:', total - withDesc);
    console.log('---');
    console.log('Shopify synced:', synced);
    console.log('Has product ID:', withProduct);
    console.log('No product ID (need sync):', noProduct);
  } catch (e) {
    console.error('Error:', e.message);
  }
  process.exit(0);
})();
