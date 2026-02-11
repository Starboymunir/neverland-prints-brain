/**
 * Shopify Service
 * ---------------
 * Handles product creation, variant management, metafield writing,
 * and image uploads via the Shopify Admin REST API.
 *
 * Supports TWO auth modes:
 *   1. Static Admin API token  → set SHOPIFY_ADMIN_API_TOKEN in .env
 *      (created by store owner via Settings > Apps > Develop apps)
 *   2. Client credentials grant → set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *      (tokens expire every 24h, auto-refreshed)
 */
const config = require("../config");

const SHOPIFY_BASE = `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`;

class ShopifyService {
  constructor() {
    // If a static token is provided, use it directly (no expiry)
    this.useStaticToken = !!config.shopify.adminApiToken;
    this.accessToken = config.shopify.adminApiToken || null;
    this.tokenExpiresAt = this.useStaticToken ? Infinity : 0;
  }

  /**
   * Get a valid access token, refreshing if expired.
   */
  async _getToken() {
    // Static token never expires
    if (this.useStaticToken) {
      return this.accessToken;
    }

    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken;
    }

    console.log("🔑 Fetching new Shopify access token via client credentials...");

    const res = await fetch(
      `https://${config.shopify.storeDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.shopify.clientId,
          client_secret: config.shopify.clientSecret,
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get Shopify access token: ${res.status} ${text}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    // Expires in ~24h, refresh 5 min early
    this.tokenExpiresAt = now + (data.expires_in - 300) * 1000;

    console.log(`✅ Shopify token acquired (expires in ~${Math.round(data.expires_in / 3600)}h)`);
    return this.accessToken;
  }

  /**
   * Generic fetch wrapper for the Shopify Admin API.
   */
  async _request(method, endpoint, body = null) {
    const token = await this._getToken();
    const url = `${SHOPIFY_BASE}${endpoint}`;
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);

    // Handle rate limiting (Shopify 429)
    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "2");
      console.log(`⏳ Shopify rate limited — waiting ${retryAfter}s...`);
      await this._sleep(retryAfter * 1000);
      return this._request(method, endpoint, body);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify ${method} ${endpoint} → ${res.status}: ${text}`);
    }

    // Some responses (e.g. DELETE 200) may not have JSON
    const contentType = res.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return null;
  }

  /**
   * Create a product with variants.
   * @param {object} asset - asset record from DB
   * @param {array} variants - variant objects from resolution engine
   * @param {string} imageUrl - public URL to the artwork image (or base64)
   */
  async createProduct(asset, variants, imageUrl = null) {
    const shopifyVariants = variants.map((v, i) => ({
      option1: `${v.width_cm} × ${v.height_cm} cm`,
      price: v.base_price || this._calcPrice(v),
      sku: `NP-${asset.id.slice(0, 8)}-${v.label.toLowerCase().replace(/\s+/g, "")}`,
      requires_shipping: true,
      inventory_management: null, // POD = no tracking
      weight: this._estimateWeight(v),
      weight_unit: "g",
    }));

    const tags = [
      asset.style,
      asset.era,
      asset.palette,
      asset.mood,
      asset.subject,
      asset.ratio_class,
      ...(asset.ai_tags || []),
    ]
      .filter(Boolean)
      .join(", ");

    const productPayload = {
      product: {
        title: asset.title || "Untitled Artwork",
        body_html: `<p>${asset.description || ""}</p>`,
        vendor: "Neverland Prints",
        product_type: "Art Print",
        tags,
        status: "draft", // Start as draft; publish when ready
        options: [{ name: "Size" }],
        variants: shopifyVariants,
        metafields: [
          {
            namespace: "neverland",
            key: "ratio_class",
            value: asset.ratio_class || "",
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "style",
            value: asset.style || "",
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "era",
            value: asset.era || "",
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "palette",
            value: asset.palette || "",
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "mood",
            value: asset.mood || "",
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "subject",
            value: asset.subject || "",
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "aspect_ratio",
            value: String(asset.aspect_ratio || ""),
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "max_print_cm",
            value: `${asset.max_print_width_cm} × ${asset.max_print_height_cm}`,
            type: "single_line_text_field",
          },
          {
            namespace: "neverland",
            key: "ai_tags",
            value: JSON.stringify(asset.ai_tags || []),
            type: "json",
          },
        ],
      },
    };

    // Attach image if we have a URL
    if (imageUrl) {
      productPayload.product.images = [{ src: imageUrl }];
    }

    const result = await this._request("POST", "/products.json", productPayload);
    return result.product;
  }

  /**
   * Upload an image to an existing product.
   */
  async addProductImage(productId, imageUrl, altText = "") {
    const payload = {
      image: { src: imageUrl, alt: altText },
    };
    const result = await this._request("POST", `/products/${productId}/images.json`, payload);
    return result.image;
  }

  /**
   * Get product count.
   */
  async getProductCount() {
    const result = await this._request("GET", "/products/count.json");
    return result.count;
  }

  /**
   * List products (paginated).
   */
  async listProducts(limit = 50, pageInfo = null) {
    let endpoint = `/products.json?limit=${limit}`;
    if (pageInfo) endpoint += `&page_info=${pageInfo}`;
    return this._request("GET", endpoint);
  }

  /**
   * Simple pricing logic based on print size.
   */
  _calcPrice(variant) {
    const area = variant.width_cm * variant.height_cm;
    if (area <= 600)  return "29.99";  // Small
    if (area <= 1800) return "49.99";  // Medium
    if (area <= 4000) return "79.99";  // Large
    return "119.99";                   // X-Large
  }

  /**
   * Estimate weight in grams based on size.
   */
  _estimateWeight(variant) {
    const area = variant.width_cm * variant.height_cm;
    return Math.round(area * 0.15 + 50); // rough estimate
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = ShopifyService;
