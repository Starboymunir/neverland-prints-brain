// Creates /pages/shipping and /pages/returns in Shopify via Admin API.
// Idempotent: updates an existing page if handle already exists.

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN || "neverland-prints.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = "2024-10";

if (!TOKEN) {
  console.error("Missing SHOPIFY_ADMIN_API_TOKEN env var");
  process.exit(1);
}

const shippingHTML = `
<p>Each Neverland print is made-to-order, hand-finished by our printing partner FinerWorks in San Antonio, Texas, and shipped directly to your door.</p>

<h3>Production time</h3>
<ul>
  <li><strong>Unframed paper prints:</strong> 1&ndash;3 business days</li>
  <li><strong>Framed prints:</strong> up to 5 business days (custom-built to order)</li>
</ul>

<h3>Shipping rates &amp; transit times</h3>
<table style="width:100%;border-collapse:collapse;">
  <thead>
    <tr><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Destination</th><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Rate</th><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Transit time</th></tr>
  </thead>
  <tbody>
    <tr><td style="padding:8px;">United States (Standard)</td><td style="padding:8px;">$11.95 flat</td><td style="padding:8px;">3&ndash;7 business days</td></tr>
    <tr><td style="padding:8px;">International (all other countries)</td><td style="padding:8px;">$26.95 flat</td><td style="padding:8px;">2&ndash;4 weeks</td></tr>
  </tbody>
</table>

<p>Add production + transit together for a realistic delivery window: <strong>1&ndash;2 weeks for US orders</strong>, <strong>3&ndash;5 weeks for international</strong>.</p>

<p>Faster US options &mdash; 2-Day Express and Overnight &mdash; will appear at checkout when available.</p>

<h3>Carriers</h3>
<p>We ship via UPS, FedEx, and USPS. You'll receive an email with a tracking number as soon as your order leaves the printer.</p>

<h3>Packaging</h3>
<p>Unframed prints ship rolled in a sturdy mailing tube. Framed pieces ship flat in custom rigid packaging designed to protect corners, glass, and finish.</p>

<h3>International orders</h3>
<p>Shipping costs to destinations outside the US are a flat $26.95. Once your order leaves the United States, transit usually takes 2&ndash;4 weeks but may be longer if there are customs delays.</p>
<p>Any duty fees, taxes, or VAT charged by the destination country are the responsibility of the recipient.</p>

<h3>Tracking</h3>
<p>For UPS shipments, tracking remains active for the entire journey. For USPS international shipments, tracking may only show progress until the package reaches the final US sort facility before it is handed off to international carriers.</p>

<h3>Questions?</h3>
<p><a href="/pages/contact">Get in touch</a> and we'll do our best to get answers within one business day.</p>
`.trim();

const returnsHTML = `
<p>We want you to love your Neverland print. Every order is backed by a 30-day satisfaction guarantee through our print partner FinerWorks.</p>

<h3>Unframed prints &mdash; 30-day satisfaction guarantee</h3>
<p>If you're not happy with the print quality of an unframed paper, canvas, or photo print, contact us within <strong>30 days of purchase</strong> for a replacement or full refund.</p>

<h3>Framed prints, matted prints &amp; custom mats</h3>
<p>Framed and matted pieces are custom-built to your specifications. They may be returned within 30 days, but a <strong>20% production fee</strong> applies and the return shipping cost is the customer's responsibility.</p>

<h3>Damaged or lost in transit</h3>
<p>If your order arrives damaged, or the carrier confirms it as lost, we will replace it <strong>free of charge</strong>. Please:</p>
<ul>
  <li>Report the issue within 30 days of the order date</li>
  <li>Include photos of the product and the outer packaging</li>
</ul>

<h3>Cancellations</h3>
<p>Because every print is made to order, please submit cancellation requests <strong>within 24 hours</strong> of placing your order. After that window, materials may already be in production and a 20% production fee may apply.</p>

<h3>After 30 days</h3>
<p>If more than 30 days have passed, a full refund may no longer be possible &mdash; but reach out anyway. Depending on the situation we may be able to offer partial credit or a discounted replacement.</p>

<h3>Image quality disclaimer</h3>
<p>We use ICC-calibrated equipment with daily color checks. We are not liable for perceived color differences caused by lighting in the room where the print is displayed.</p>

<h3>How to request a refund or replacement</h3>
<ol>
  <li><a href="/pages/contact">Contact us</a> with your order number and (for damage claims) photos</li>
  <li>We'll confirm next steps within one business day</li>
</ol>
`.trim();

async function upsertPage({ title, handle, body }) {
  const list = await fetch(
    `https://${SHOP}/admin/api/${API}/pages.json?handle=${handle}`,
    { headers: { "X-Shopify-Access-Token": TOKEN } }
  ).then((r) => r.json());

  const existing = list.pages?.[0];
  const payload = { page: { title, handle, body_html: body, published: true } };

  if (existing) {
    const res = await fetch(
      `https://${SHOP}/admin/api/${API}/pages/${existing.id}.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    const j = await res.json();
    if (!res.ok) throw new Error(`Update ${handle} failed: ${JSON.stringify(j)}`);
    console.log(`✅ Updated /pages/${handle} (id=${existing.id})`);
    return j.page;
  } else {
    const res = await fetch(`https://${SHOP}/admin/api/${API}/pages.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Create ${handle} failed: ${JSON.stringify(j)}`);
    console.log(`✅ Created /pages/${handle} (id=${j.page.id})`);
    return j.page;
  }
}

(async () => {
  await upsertPage({ title: "Shipping", handle: "shipping", body: shippingHTML });
  await upsertPage({ title: "Returns & Refunds", handle: "returns", body: returnsHTML });
  console.log("\nDone. Pages live at:");
  console.log(`  https://${SHOP.replace(".myshopify.com", "")}.com/pages/shipping`);
  console.log(`  https://${SHOP.replace(".myshopify.com", "")}.com/pages/returns`);
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
