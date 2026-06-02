// Probe FinerWorks list_shipping_options_multiple directly to discover the
// real response shape. Run: node test-fw-rates.js
require("dotenv").config();
const FinerWorksService = require("./src/services/finerworks");

(async () => {
  const fw = new FinerWorksService();

  const recipient = {
    first_name: "Test",
    last_name: "User",
    address1: "123 Main St",
    city: "Brooklyn",
    state_code: "NY",
    zip: "11201",
    country_code: "US",
  };

  const items = [
    { product_sku: "5M6M9S12X16", product_qty: 1, product_title: "Test Print" },
  ];

  console.log("→ Calling FW listShippingOptions ...");
  try {
    const r = await fw.listShippingOptions({ recipient, items });
    console.log("✓ Top-level keys:", Object.keys(r || {}));
    const orders = r?.orders || r;
    console.log("✓ Order count:", Array.isArray(orders) ? orders.length : "n/a");
    if (Array.isArray(orders) && orders.length) {
      console.log("✓ First order keys:", Object.keys(orders[0]));
      const opts = orders[0].shipping_options || orders[0].options || [];
      console.log(`✓ ${opts.length} shipping option(s):`);
      for (const o of opts) {
        console.log("  -", { id: o.id, code: o.shipping_code, method: o.shipping_method, rate: o.rate, transit: o.transit_time, carrier: o.carrier });
      }
      console.log("✓ preferred_option:", orders[0].preferred_option);
    }
  } catch (e) {
    console.error("✗ FW error:", e.message);
    if (e.response) console.error("response:", e.response);
  }
})();
