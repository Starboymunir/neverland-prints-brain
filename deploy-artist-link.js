require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const shop = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';

function requestJson(method, requestPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request(
      { hostname: shop, path: `/admin/api/${apiVersion}${requestPath}`, method,
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 30000 },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} ${requestPath}: ${d.slice(0, 300)}`));
        try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body); req.end();
  });
}

async function main() {
  const resp = await requestJson('GET', '/themes.json');
  const main = (resp.themes || []).find((t) => t.role === 'main');
  if (!main) throw new Error('No main theme');
  console.log('Main theme:', main.id, main.name);
  const root = path.join(__dirname, 'neverland-theme');
  const targets = [
    { key: 'sections/product-page.liquid', file: path.join(root, 'sections', 'product-page.liquid') },
    { key: 'assets/neverland.css', file: path.join(root, 'assets', 'neverland.css') },
  ];
  for (const t of targets) {
    const value = fs.readFileSync(t.file, 'utf8');
    await requestJson('PUT', `/themes/${main.id}/assets.json`, { asset: { key: t.key, value } });
    console.log('Uploaded', t.key, `(${value.length} bytes)`);
  }
  console.log('Artist-link deploy complete.');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
