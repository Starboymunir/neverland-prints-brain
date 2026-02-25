require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { analyzeArtwork } = require('./src/services/resolution-engine');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const { data } = await sb.from('assets')
    .select('id, title, description, artist, width_px, height_px, drive_file_id, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, aspect_ratio')
    .is('shopify_product_id', null)
    .not('description', 'is', null)
    .limit(1);
  
  const a = data[0];
  console.log('Title:', a.title);
  console.log('Artist:', a.artist);
  console.log('Desc:', (a.description || '').slice(0, 100));
  console.log('Dimensions:', a.width_px, 'x', a.height_px);

  // Build the product input exactly like the sync script does
  const aiDesc = a.description || '';
  const artistName = a.artist || 'Unknown Artist';
  
  let variants = [];
  if (a.width_px && a.height_px) {
    const analysis = analyzeArtwork(a.width_px, a.height_px);
    variants = analysis.variants || [];
  }
  if (variants.length === 0) {
    variants = [{ label: 'Standard', width_cm: 30, height_cm: 40 }];
  }

  const sizes = variants.map(v => v.label + ': ' + v.width_cm + '×' + v.height_cm + ' cm').join(' · ');
  
  const bodyHtml = aiDesc
    ? '<div class="np-desc"><p class="np-ai">' + aiDesc + '</p><p>A museum-quality fine art print by <strong>' + artistName + '</strong>.</p><p><strong>Available sizes:</strong> ' + sizes + '</p></div>'
    : '<p>A museum-quality fine art print by <strong>' + artistName + '</strong>.</p><p><strong>Available sizes:</strong> ' + sizes + '</p>';

  console.log('\nbodyHtml length:', bodyHtml.length);
  console.log('bodyHtml:', bodyHtml.slice(0, 300));
  
  // Check for problematic characters
  const hasNullBytes = bodyHtml.includes('\0');
  const hasWeirdChars = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(bodyHtml);
  console.log('\nHas null bytes:', hasNullBytes);
  console.log('Has control chars:', hasWeirdChars);

  // Test actual GraphQL call
  const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const GQL_URL = 'https://' + SHOP + '/admin/api/2024-10/graphql.json';

  const mutation = `mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { id legacyResourceId }
      userErrors { field message }
    }
  }`;

  const input = {
    title: a.title,
    bodyHtml: bodyHtml,
    vendor: artistName,
    productType: 'Art Print',
    tags: ['art print', 'fine art'],
    status: 'ACTIVE',
    options: ['Size'],
    variants: variants.slice(0, 1).map(v => ({
      options: [v.label + ' — ' + v.width_cm + '×' + v.height_cm + ' cm'],
      price: '29.99',
      sku: 'NP-TEST-' + a.id.slice(0, 8),
      requiresShipping: true,
      taxable: true,
    })),
    metafields: [{
      namespace: 'neverland',
      key: 'drive_file_id',
      value: a.drive_file_id,
      type: 'single_line_text_field',
    }],
  };

  console.log('\nSending GraphQL mutation...');
  console.log('Input keys:', Object.keys(input));
  
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query: mutation, variables: { input } }),
  });

  const json = await res.json();
  console.log('\nResponse:', JSON.stringify(json, null, 2).slice(0, 500));
  
  process.exit(0);
})();
