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
      const { result } = await this.request("GET", "/store");
      return {
        connected: true,
        storeId: result.id,
        storeName: result.name,
        type: result.type,
      };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  }

  // ── Map our size labels to Printful variant IDs ────────
  // Fine Art Print sizes (Printful product 486 — Enhanced Matte Paper Poster as fallback)
  // Printful uses inches; we'll map our cm sizes to nearest Printful size
  static SIZE_MAP = {
    // Our sizes (cm) → Printful variant info
    // Using "Enhanced Matte Paper Poster" (product 1) since it's widely available
    "20×20": { variantId: 10163, size: '8"×8"' },
    "30×30": { variantId: 994, size: '12"×12"' },
    "50×50": { variantId: 995, size: '18"×18"' },
    "70×70": { variantId: null, size: null }, // custom quote

    // Portrait
    "20×30": { variantId: 10163, size: '8"×12"' },
    "30×40": { variantId: 994, size: '12"×16"' },
    "40×60": { variantId: 10075, size: '16"×24"' },
    "60×80": { variantId: 10076, size: '24"×36"' },

    // Landscape (same but flipped)
    "30×20": { variantId: 10163, size: '12"×8"' },
    "40×30": { variantId: 994, size: '16"×12"' },
    "60×40": { variantId: 10075, size: '24"×16"' },
    "80×60": { variantId: 10076, size: '36"×24"' },
  };

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
