/**
 * Create Shopify Pages
 * ====================
 * Creates all required pages so footer links don't 404.
 *
 * Usage:
 *   node src/scripts/create-pages.js
 *   node src/scripts/create-pages.js --delete-first   # delete existing pages first
 */

require("dotenv").config();
const config = require("../config");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;
const DELETE_FIRST = process.argv.includes("--delete-first");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopifyREST(method, endpoint, body = null, retries = 3) {
  const url = `${BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      const wait = parseFloat(res.headers.get("Retry-After") || "2") * 1000;
      console.log(`  ⏳ Rate limited, waiting ${wait}ms...`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      if (attempt === retries) throw new Error(`${method} ${endpoint}: ${res.status} — ${txt}`);
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

// ── Page definitions ──
const PAGES = [
  {
    handle: "about",
    title: "About Us",
    body_html: `
<div class="page-content">
  <h2>Our Story</h2>
  <p>Neverland Prints was born from a simple belief: <strong>everyone deserves to live with beautiful art</strong>. We source museum-quality works from over 300 artists around the world and make them accessible to art lovers everywhere.</p>

  <h3>What Makes Us Different</h3>
  <ul>
    <li><strong>101,000+ Artworks</strong> — One of the largest curated art print catalogs online</li>
    <li><strong>Museum-Grade Printing</strong> — 12-colour giclée on archival paper rated for 200+ years</li>
    <li><strong>Gallery & Museum Grades</strong> — Choose the quality tier that fits your space and budget</li>
    <li><strong>AI-Powered Curation</strong> — Intelligent tagging helps you discover the perfect piece</li>
  </ul>

  <h3>Our Promise</h3>
  <p>Every print that leaves our studio is quality-checked and carefully packaged. We stand behind our work with a satisfaction guarantee — if your print arrives damaged or you're not happy, we'll make it right.</p>

  <p><em>Our pieces never grow old.</em></p>
</div>`,
  },
  {
    handle: "shipping",
    title: "Shipping & Returns",
    body_html: `
<div class="page-content">
  <h2>Shipping Information</h2>
  <p>We ship worldwide from our professional printing studio. Every print is made to order with care.</p>

  <h3>Processing Time</h3>
  <p>Orders are typically printed and dispatched within <strong>3-5 business days</strong>. During busy periods, processing may take up to 7 business days.</p>

  <h3>Delivery Times</h3>
  <ul>
    <li><strong>United Kingdom:</strong> 3-5 business days</li>
    <li><strong>Europe:</strong> 5-10 business days</li>
    <li><strong>United States & Canada:</strong> 7-14 business days</li>
    <li><strong>Rest of World:</strong> 10-21 business days</li>
  </ul>

  <h3>Returns & Exchanges</h3>
  <p>We want you to love your art. If your print arrives damaged or defective, please contact us within 14 days of delivery and we'll send a replacement or issue a full refund.</p>
  <p>Since every print is made to order, we cannot accept returns for change of mind. However, if you're unsatisfied with the quality, please reach out — we're always ready to help.</p>

  <h3>Packaging</h3>
  <p>All prints are packaged flat or rolled in sturdy, protective tubes to prevent damage during transit.</p>
</div>`,
  },
  {
    handle: "faq",
    title: "FAQ",
    body_html: `
<div class="page-content">
  <h2>Frequently Asked Questions</h2>

  <h3>What sizes do you offer?</h3>
  <p>We offer a wide range of sizes from A5 (14.8 × 21 cm) up to A0 (84.1 × 118.9 cm) and custom panoramic formats. Size availability depends on the resolution of the original artwork — we never upscale beyond what looks great.</p>

  <h3>What paper do you use?</h3>
  <p>Our prints use premium archival paper with a matte or satin finish, rated for 200+ years of fade resistance. Museum Grade prints use heavier 310gsm cotton rag paper; Gallery Grade uses 230gsm enhanced matte.</p>

  <h3>Do prints come framed?</h3>
  <p>Currently we sell unframed prints only. This lets you choose the perfect frame that suits your space and style. We recommend a standard off-the-shelf frame or a custom framing service.</p>

  <h3>How is the quality of the print determined?</h3>
  <p>We use an AI-powered quality grading system that analyses each artwork's resolution. Prints rated "Museum Grade" are 300+ DPI at print size — the highest clarity possible. "Gallery Grade" prints are 200+ DPI, still excellent for most viewing distances.</p>

  <h3>Can I return my order?</h3>
  <p>Because every print is made to order, we can't accept returns for change of mind. But if there's any issue with quality or damage in transit, we'll replace it or refund you. See our <a href="/pages/shipping">Shipping & Returns</a> page for details.</p>

  <h3>How do I track my order?</h3>
  <p>Once your order ships, you'll receive a tracking number via email. You can also check your order status from your account page.</p>

  <h3>Do you ship internationally?</h3>
  <p>Yes! We ship to most countries worldwide. Delivery times vary by destination — check our <a href="/pages/shipping">Shipping</a> page for estimated times.</p>
</div>`,
  },
  {
    handle: "contact",
    title: "Contact Us",
    body_html: `
<div class="page-content">
  <h2>Get In Touch</h2>
  <p>We'd love to hear from you. Whether you have a question about an order, need help choosing the perfect print, or just want to say hello — we're here for you.</p>

  <h3>Email</h3>
  <p>The fastest way to reach us: <strong>hello@neverlandprints.com</strong></p>
  <p>We aim to respond within 24 hours on business days.</p>

  <h3>Before You Contact Us</h3>
  <p>You might find your answer quickly on our <a href="/pages/faq">FAQ page</a> or <a href="/pages/shipping">Shipping & Returns</a> page.</p>

  <h3>Business Enquiries</h3>
  <p>For wholesale, partnerships, or press enquiries, please email us with the subject line "Business Enquiry" and we'll get back to you promptly.</p>
</div>`,
  },
  {
    handle: "terms",
    title: "Terms & Conditions",
    body_html: `
<div class="page-content">
  <h2>Terms & Conditions</h2>
  <p>By using the Neverland Prints website and placing an order, you agree to the following terms.</p>

  <h3>Orders & Payment</h3>
  <p>All prices are displayed in the currency selected at checkout and include applicable taxes unless otherwise stated. Payment is processed securely at checkout via Shopify Payments.</p>

  <h3>Made to Order</h3>
  <p>All prints are made to order. Once production begins, orders cannot be cancelled. Please double-check your size and artwork selection before placing your order.</p>

  <h3>Intellectual Property</h3>
  <p>All artwork reproductions sold on Neverland Prints are sourced from public domain collections or properly licensed material. Prints are for personal use only and may not be reproduced or resold commercially.</p>

  <h3>Limitation of Liability</h3>
  <p>Neverland Prints is not liable for delays caused by shipping carriers or customs. We will do our best to resolve any issues promptly.</p>

  <h3>Changes to Terms</h3>
  <p>We reserve the right to update these terms at any time. Continued use of the website constitutes acceptance of updated terms.</p>
</div>`,
  },
  {
    handle: "privacy",
    title: "Privacy Policy",
    body_html: `
<div class="page-content">
  <h2>Privacy Policy</h2>
  <p>Your privacy matters to us. This page explains how Neverland Prints collects, uses, and protects your personal information.</p>

  <h3>Information We Collect</h3>
  <ul>
    <li><strong>Order Information:</strong> Name, email, shipping address, and payment details when you make a purchase.</li>
    <li><strong>Browsing Data:</strong> We may collect anonymised analytics data (pages visited, device type) to improve the site experience.</li>
    <li><strong>Newsletter:</strong> Your email address if you voluntarily subscribe to our mailing list.</li>
  </ul>

  <h3>How We Use Your Data</h3>
  <p>We use your data only to fulfil orders, communicate with you about your purchase, and (if opted in) send art inspiration and offers. We never sell your personal data to third parties.</p>

  <h3>Cookies</h3>
  <p>We use essential cookies to keep the site functioning and analytics cookies to understand how visitors use the site. You can manage cookie preferences in your browser settings.</p>

  <h3>Your Rights</h3>
  <p>You may request access to, correction of, or deletion of your personal data at any time by contacting us at <strong>hello@neverlandprints.com</strong>.</p>

  <h3>Data Security</h3>
  <p>All transactions are encrypted via SSL. We use Shopify's secure infrastructure to process payments and store order data.</p>
</div>`,
  },
  {
    handle: "quality",
    title: "Print Quality",
    body_html: `
<div class="page-content">
  <h2>Print Quality</h2>
  <p>At Neverland Prints, quality isn't just a feature — it's our foundation. Every print is produced using professional giclée technology for gallery-worthy results.</p>

  <h3>12-Colour Giclée Printing</h3>
  <p>We use 12-colour pigment ink systems (not basic CMYK) that produce a wider colour gamut, smoother gradients, and richer tones than standard printing. The result is a print that truly captures the depth and emotion of the original artwork.</p>

  <h3>Quality Grades</h3>
  <ul>
    <li><strong>Museum Grade (300+ DPI):</strong> The finest quality. Reproduced on 310gsm 100% cotton rag archival paper with a soft matte finish. Rated for 200+ years of fade resistance. Perfect for collectors and gifting.</li>
    <li><strong>Gallery Grade (200+ DPI):</strong> Excellent quality for everyday display. Printed on 230gsm enhanced matte archival paper. Beautiful results at a more accessible price point.</li>
  </ul>

  <h3>AI-Powered Resolution Analysis</h3>
  <p>Every artwork in our catalog is analysed by our AI system, which calculates the maximum print size at optimal DPI. This means we never upscale beyond what will look sharp — every size option we offer will look great on your wall.</p>

  <h3>Colour Accuracy</h3>
  <p>Our printers are professionally calibrated and profiled for each paper type. Combined with ICC colour management, the prints you receive closely match what you see on screen (on a calibrated display).</p>
</div>`,
  },
];

async function deletePagesWithHandles(handles) {
  console.log("🗑️  Checking for existing pages to delete...");
  const res = await shopifyREST("GET", "/pages.json?limit=250");
  const pages = res?.pages || [];
  const toDelete = pages.filter((p) => handles.includes(p.handle));

  if (toDelete.length === 0) {
    console.log("  No matching pages found to delete.");
    return;
  }

  for (const p of toDelete) {
    await shopifyREST("DELETE", `/pages/${p.id}.json`);
    console.log(`  ✅ Deleted: ${p.title} (${p.handle})`);
    await sleep(300);
  }
}

async function createPages() {
  console.log("\n📄 Creating pages...\n");

  for (const page of PAGES) {
    try {
      const res = await shopifyREST("POST", "/pages.json", {
        page: {
          title: page.title,
          handle: page.handle,
          body_html: page.body_html,
          published: true,
        },
      });
      const created = res?.page;
      console.log(
        `  ✅ ${created.title} → /pages/${created.handle} (ID: ${created.id})`
      );
      await sleep(400);
    } catch (err) {
      console.error(`  ❌ Failed to create "${page.title}": ${err.message}`);
    }
  }
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Neverland Prints — Create Pages");
  console.log("═══════════════════════════════════════\n");

  if (!SHOP || !TOKEN) {
    console.error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_TOKEN in .env");
    process.exit(1);
  }

  const handles = PAGES.map((p) => p.handle);

  if (DELETE_FIRST) {
    await deletePagesWithHandles(handles);
  }

  await createPages();

  console.log("\n✨ Done! All pages created.\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
