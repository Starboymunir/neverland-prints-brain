/**
 * Printful Integration — Neverland Prints
 * ========================================
 * Connects to Printful's API for print-on-demand fulfillment.
 * When a customer orders a print, we:
 *   1. Receive Shopify order webhook
 *   2. Look up the artwork's Drive image URL
 *   3. Submit a Printful order with the high-res image
 *   4. Printful prints, packs, and ships directly to customer
 *
 * Printful product mapping:
 *   - Enhanced Matte Paper Poster (product ID: 1)
 *   - Museum-Quality Poster (product ID: 171)
 *   - Fine Art Print (product ID: 486)  ← preferred
 *
 * Printful API: https://developers.printful.com/docs/
 *
 * Required env: PRINTFUL_API_KEY
 */

const PRINTFUL_BASE = "https://api.printful.com";

class PrintfulService {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.PRINTFUL_API_KEY;
    if (!this.apiKey) {
      console.warn("⚠️  PRINTFUL_API_KEY not set — print fulfillment disabled");
    }
  }

  // ── API helper ─────────────────────────────────────────
  async request(method, endpoint, body = null) {
    if (!this.apiKey) throw new Error("Printful API key not configured");

    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${PRINTFUL_BASE}${endpoint}`, opts);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Printful ${method} ${endpoint}: ${res.status} — ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── Check connection ───────────────────────────────────
  async verifyConnection() {
    try {
      // Use catalog endpoint — doesn't require store scope
      const { result } = await this.request("GET", "/products/268");
      return {
        connected: true,
        product: result.product.title,
        variants: result.variants.length,
      };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  }

  // ── Map our size labels to Printful variant IDs ────────
  // Enhanced Matte Paper Poster (cm) — Product 268
  // These are the actual Printful variant IDs for poster sizes
  static SIZE_MAP = {
    // Exact cm matches → Printful variant IDs
    "21×30":  { variantId: 8947,  size: "21×30 cm",  product: 268 },
    "30×40":  { variantId: 8948,  size: "30×40 cm",  product: 268 },
    "30×42":  { variantId: 19516, size: "A2 (42×59.4 cm)", product: 268 },
    "50×70":  { variantId: 8952,  size: "50×70 cm",  product: 268 },
    "59×84":  { variantId: 19515, size: "A1 (59.4×84.1 cm)", product: 268 },
    "61×91":  { variantId: 8953,  size: "61×91 cm",  product: 268 },
    "70×100": { variantId: 8954,  size: "70×100 cm", product: 268 },

    // Common resolution-engine output sizes → nearest Printful match
    "20×20":  { variantId: 8947,  size: "21×30 cm",  product: 268 },
    "30×30":  { variantId: 8948,  size: "30×40 cm",  product: 268 },
    "50×50":  { variantId: 8952,  size: "50×70 cm",  product: 268 },
    "20×30":  { variantId: 8947,  size: "21×30 cm",  product: 268 },
    "40×60":  { variantId: 8952,  size: "50×70 cm",  product: 268 },
    "60×80":  { variantId: 8953,  size: "61×91 cm",  product: 268 },
    "30×20":  { variantId: 8947,  size: "21×30 cm",  product: 268 },
    "40×30":  { variantId: 8948,  size: "30×40 cm",  product: 268 },
    "60×40":  { variantId: 8952,  size: "50×70 cm",  product: 268 },
    "80×60":  { variantId: 8953,  size: "61×91 cm",  product: 268 },
    "90×60":  { variantId: 8953,  size: "61×91 cm",  product: 268 },
  };

  // Default fallback: 30×40 cm poster
  static DEFAULT_VARIANT = { variantId: 8948, size: "30×40 cm", product: 268 };

  // ── Get available products ─────────────────────────────
  async getProducts() {
    const { result } = await this.request("GET", "/products");
    // Filter to poster/print products
    return result.filter(
      (p) =>
        p.title.toLowerCase().includes("poster") ||
        p.title.toLowerCase().includes("print") ||
        p.title.toLowerCase().includes("canvas")
    );
  }

  // ── Get product variants ───────────────────────────────
  async getProductVariants(productId) {
    const { result } = await this.request("GET", `/products/${productId}`);
    return result.variants;
  }

  // ── Create fulfillment order ───────────────────────────
  /**
   * @param {Object} params
   * @param {Object} params.recipient - { name, address1, city, state_code, country_code, zip }
   * @param {string} params.imageUrl  - High-res image URL (Drive lh3 URL)
   * @param {string} params.size      - Our size label e.g. "30×40"
   * @param {string} params.title     - Artwork title (for packing slip)
   * @param {string} params.externalId - Shopify order ID for tracking
   */
  async createOrder(params) {
    const {
      recipient,
      imageUrl,
      size,
      title,
      externalId,
      variantId,
    } = params;

    // Build the order
    const order = {
      external_id: externalId,
      shipping: "STANDARD",
      recipient: {
        name: recipient.name,
        address1: recipient.address1,
        address2: recipient.address2 || "",
        city: recipient.city,
        state_code: recipient.state_code || "",
        country_code: recipient.country_code,
        zip: recipient.zip,
      },
      items: [
        {
          variant_id: variantId,
          quantity: 1,
          name: title || "Art Print",
          files: [
            {
              type: "default",
              url: imageUrl,
            },
          ],
        },
      ],
      packing_slip: {
        email: "hello@neverlandprints.com",
        phone: "",
        message: `Thank you for your purchase from Neverland Prints! "${title}"`,
        logo_url: "",
      },
    };

    const { result } = await this.request("POST", "/orders", order);
    return result;
  }

  // ── Confirm (pay for) an order ─────────────────────────
  async confirmOrder(orderId) {
    const { result } = await this.request(
      "POST",
      `/orders/${orderId}/confirm`
    );
    return result;
  }

  // ── Get order status ───────────────────────────────────
  async getOrder(orderId) {
    const { result } = await this.request("GET", `/orders/${orderId}`);
    return result;
  }

  // ── Estimate cost ──────────────────────────────────────
  async estimateCost(params) {
    const { recipient, imageUrl, variantId } = params;
    const order = {
      recipient: {
        address1: recipient.address1,
        city: recipient.city,
        country_code: recipient.country_code,
        state_code: recipient.state_code || "",
        zip: recipient.zip,
      },
      items: [
        {
          variant_id: variantId,
          quantity: 1,
          files: [{ type: "default", url: imageUrl }],
        },
      ],
    };
    const { result } = await this.request("POST", "/orders/estimate-costs", order);
    return result;
  }

  // ── List existing orders ───────────────────────────────
  async listOrders(offset = 0, limit = 20) {
    const { result } = await this.request(
      "GET",
      `/orders?offset=${offset}&limit=${limit}`
    );
    return result;
  }

  // ── Shipping rates ─────────────────────────────────────
  async getShippingRates(recipient, variantId) {
    const { result } = await this.request("POST", "/shipping/rates", {
      recipient: {
        address1: recipient.address1,
        city: recipient.city,
        country_code: recipient.country_code,
        state_code: recipient.state_code || "",
        zip: recipient.zip,
      },
      items: [{ variant_id: variantId, quantity: 1 }],
    });
    return result;
  }
}

module.exports = PrintfulService;
