/**
 * Express Server — Neverland Prints Brain
 * ----------------------------------------
 * Serves:
 *   - API routes (/api/*)
 *   - Image proxy (/api/img/*)
 *   - Storefront API (/api/storefront/*)
 *   - Catalog API (/api/storefront/catalog, /api/storefront/asset/*)
 *   - Webhooks (/webhooks/*)
 *   - Verification Dashboard (/)
 *   - Cron jobs (daily Shopify sync)
 */
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const config = require("./config");
const apiRoutes = require("./routes/api");
const webhookRoutes = require("./routes/webhooks");
const { startCronJobs } = require("./scripts/cron");

const app = express();

// Raw body middleware for webhook signature verification
app.use("/webhooks", express.raw({ type: "application/json" }), (req, res, next) => {
  req.rawBody = req.body;
  if (Buffer.isBuffer(req.body)) {
    req.body = JSON.parse(req.body.toString());
  }
  next();
});

// Middleware
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Allow Shopify admin to embed this app in an iframe
app.use((req, res, next) => {
  const shop = "neverland-prints.myshopify.com";
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://admin.shopify.com https://${shop}`
  );
  res.removeHeader("X-Frame-Options");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// API routes
app.use("/api", apiRoutes);

// Webhook routes
app.use("/webhooks", webhookRoutes);

// Printful dashboard
app.get("/printful", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "printful.html"));
});

// ── Shopify OAuth callback ──────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, shop, hmac } = req.query;
  if (!code || !shop) {
    return res.status(400).send("Missing code or shop parameter");
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    const data = await tokenRes.json();

    if (data.access_token) {
      // Store in env for this process
      process.env.SHOPIFY_ADMIN_API_TOKEN = data.access_token;
      console.log("\n✅ New Shopify access token obtained!");
      console.log("   Scopes:", data.scope);
      console.log("   Token:", data.access_token.slice(0, 12) + "...");
      console.log("\n⚠️  Update SHOPIFY_ADMIN_API_TOKEN in Render env vars:");
      console.log("   ", data.access_token);

      res.send(`
        <h2>✅ Shopify Connected!</h2>
        <p><strong>Scopes:</strong> ${data.scope}</p>
        <p><strong>Access Token:</strong> <code>${data.access_token}</code></p>
        <p>⚠️ Copy this token and update it in Render environment variables as SHOPIFY_ADMIN_API_TOKEN.</p>
      `);
    } else {
      console.error("Token exchange failed:", data);
      res.status(400).send(`<h2>❌ Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send(`<h2>❌ Error</h2><pre>${err.message}</pre>`);
  }
});

// Dashboard (serve index.html for all non-API routes)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(config.port, () => {
  console.log(`\n🧠 Neverland Prints Brain running at http://localhost:${config.port}`);
  console.log(`📊 Dashboard: http://localhost:${config.port}`);
  console.log(`📡 API: http://localhost:${config.port}/api/stats`);
  console.log(`🖼️  Image Proxy: http://localhost:${config.port}/api/img/{driveFileId}?w=800`);
  console.log(`🏥 Health: http://localhost:${config.port}/api/health\n`);

  // Start cron jobs (daily sync, health checks)
  if (config.env !== "test") {
    startCronJobs();
  }
});
