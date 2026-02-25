require("dotenv").config();
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

(async () => {
  const query = `{
    collections(first: 56, query: "collection_type:smart") {
      edges {
        node {
          title
          productsCount { count }
        }
      }
    }
  }`;

  const r = await fetch(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  const cols = j.data.collections.edges.map(e => ({
    title: e.node.title,
    count: e.node.productsCount.count,
  })).sort((a, b) => b.count - a.count);

  cols.forEach(c => console.log(`  ${String(c.count).padStart(5)} | ${c.title}`));
  console.log(`\n  Total collections: ${cols.length}`);
  console.log(`  With products: ${cols.filter(c => c.count > 0).length}`);
})();
