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
app.use(express.static(path.join(__dirname, "public")));

// API routes
app.use("/api", apiRoutes);

// Webhook routes
app.use("/webhooks", webhookRoutes);

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
