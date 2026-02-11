/**
 * Neverland Prints — Configuration
 * Central config loaded from .env
 */
require("dotenv").config();

module.exports = {
  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },

  // Google Drive
  google: {
    serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "./credentials/google-service-account.json",
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  },

  // Shopify
  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN,   // static token (from store admin)
    clientId: process.env.SHOPIFY_CLIENT_ID,               // client credentials flow
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,       // client credentials flow
    apiVersion: process.env.SHOPIFY_API_VERSION || "2024-10",
  },

  // Gemini AI
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },

  // Resolution Engine
  resolution: {
    pxPerCm: parseFloat(process.env.PX_PER_CM) || 35.43,
    minPrintDpi: parseInt(process.env.MIN_PRINT_DPI, 10) || 150,
  },

  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || "development",
};
