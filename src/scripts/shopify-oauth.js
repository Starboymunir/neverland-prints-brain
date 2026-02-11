/**
 * One-time OAuth helper
 * ---------------------
 * Run this once to get an offline access token for the client's Shopify store.
 * The token never expires, so you only need to do this once.
 *
 * Usage:  node src/scripts/shopify-oauth.js
 */
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
require("dotenv").config();

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP = process.env.SHOPIFY_STORE_DOMAIN; // neverland-prints.myshopify.com
const SCOPES = "write_products,read_products,write_inventory,read_inventory,read_themes,write_themes,read_content,write_content,read_orders,write_orders,read_files,write_files";
const PORT = 3456; // temporary port for OAuth callback
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const nonce = crypto.randomBytes(16).toString("hex");

// Step 1: Build the authorization URL
const authUrl =
  `https://${SHOP}/admin/oauth/authorize?` +
  `client_id=${CLIENT_ID}` +
  `&scope=${SCOPES}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${nonce}` +
  `&grant_options[]=`;

console.log("\n🔐 Shopify OAuth — One-time setup\n");
console.log("1. Open this URL in your browser:\n");
console.log(`   ${authUrl}\n`);
console.log("2. Click 'Install app' on the Shopify screen");
console.log("3. You'll be redirected back here automatically\n");
console.log("Waiting for callback...\n");

// Step 2: Start a tiny server to catch the callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const shop = url.searchParams.get("shop");

  // Verify state
  if (state !== nonce) {
    res.writeHead(400);
    res.end("State mismatch — possible CSRF attack");
    console.error("❌ State mismatch!");
    server.close();
    return;
  }

  console.log(`✅ Got authorization code from ${shop}`);
  console.log("   Exchanging for access token...\n");

  // Step 3: Exchange the code for an offline access token
  // Try the callback shop first, then fall back to the configured SHOP domain
  const domainsToTry = [shop, SHOP].filter(Boolean);
  // Deduplicate
  const uniqueDomains = [...new Set(domainsToTry)];

  let tokenAcquired = false;

  for (const domain of uniqueDomains) {
    try {
      console.log(`   Trying token exchange via ${domain}...`);
      const tokenUrl = `https://${domain}/admin/oauth/access_token`;

      // Use https module for reliability (native fetch can fail on some Node versions)
      const https = require("https");
      const postData = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
      }).toString();

      const data = await new Promise((resolve, reject) => {
        const req = https.request(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(postData),
          },
        }, (response) => {
          let body = "";
          response.on("data", (chunk) => body += chunk);
          response.on("end", () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`)); }
          });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timed out")); });
        req.write(postData);
        req.end();
      });

      if (data.access_token) {
        console.log("\n🎉 SUCCESS! Here's your offline access token:\n");
        console.log(`   SHOPIFY_ADMIN_API_TOKEN=${data.access_token}\n`);
        console.log(`   Scopes: ${data.scope}`);
        if (data.expires_in) {
          console.log(`   Expires in: ${data.expires_in}s`);
        } else {
          console.log("   Expires: NEVER (offline token)");
        }
        console.log("\n📋 Paste this into your .env file on the SHOPIFY_ADMIN_API_TOKEN line.\n");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#e0e0e0">
            <h1 style="color:#4ade80">✅ Token Acquired!</h1>
            <p>Your Shopify access token has been printed in the terminal.</p>
            <p>You can close this tab now.</p>
          </body></html>
        `);
        tokenAcquired = true;
        break;
      } else {
        console.error(`   ⚠️ ${domain} responded but no token:`, JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error(`   ⚠️ Failed via ${domain}: ${err.message}`);
    }
  }

  if (!tokenAcquired) {
    console.error("\n❌ Could not exchange code via any domain.");
    console.error("   The authorization code may have expired. Please re-run this script and try again.\n");
    res.writeHead(500);
    res.end("Failed to get token — check terminal");
  }

  // Shut down after a moment so the response can be sent
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 1000);
});

server.listen(PORT, () => {
  console.log(`🌐 OAuth callback server listening on http://localhost:${PORT}\n`);
});
