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

  // ══════════════════════════════════════════════════════════
  //  MOCKUP GENERATOR
  // ══════════════════════════════════════════════════════════

  // ── Variant lookup for mockups ───────────────────────────
  // Maps { tier, frameColor } → { productId, variantId }
  // Product 268 = Enhanced Matte Paper Poster (unframed)
  // Product 304 = Enhanced Matte Paper Framed Poster
  static MOCKUP_VARIANTS = {
    // Unframed (product 268)
    "small_none":        { productId: 268, variantId: 8947  }, // 21×30cm
    "medium_none":       { productId: 268, variantId: 8948  }, // 30×40cm
    "large_none":        { productId: 268, variantId: 8952  }, // 50×70cm
    "extra_large_none":  { productId: 268, variantId: 8953  }, // 61×91cm

    // Framed — Black (product 304)
    "small_black":       { productId: 304, variantId: 9356  }, // 21×30cm
    "medium_black":      { productId: 304, variantId: 9357  }, // 30×40cm
    "large_black":       { productId: 304, variantId: 9358  }, // 50×70cm
    "extra_large_black": { productId: 304, variantId: 9359  }, // 61×91cm

    // Framed — White (product 304)
    "small_white":       { productId: 304, variantId: 10296 }, // 21×30cm
    "medium_white":      { productId: 304, variantId: 10297 }, // 30×40cm
    "large_white":       { productId: 304, variantId: 10298 }, // 50×70cm
    "extra_large_white": { productId: 304, variantId: 10299 }, // 61×91cm

    // Framed — Oak/Natural/Walnut (product 304, oak variants)
    "small_natural":       { productId: 304, variantId: 11790 }, // 21×30cm
    "medium_natural":      { productId: 304, variantId: 11791 }, // 30×40cm
    "large_natural":       { productId: 304, variantId: 11792 }, // 50×70cm
    "extra_large_natural": { productId: 304, variantId: 11793 }, // 61×91cm
    "small_walnut":        { productId: 304, variantId: 11790 }, // oak fallback
    "medium_walnut":       { productId: 304, variantId: 11791 },
    "large_walnut":        { productId: 304, variantId: 11792 },
    "extra_large_walnut":  { productId: 304, variantId: 11793 },
  };

  /**
   * Resolve a tier + frame selection to a Printful product/variant.
   * @param {string} tier - small|medium|large|extra_large
   * @param {string} frameColor - none|black|white|natural|walnut
   * @returns {{ productId: number, variantId: number }}
   */
  static resolveVariant(tier = "medium", frameColor = "none") {
    const key = `${tier}_${frameColor}`;
    return PrintfulService.MOCKUP_VARIANTS[key]
      || PrintfulService.MOCKUP_VARIANTS[`${tier}_none`]
      || { productId: 268, variantId: 8948 }; // default: medium unframed
  }

  /**
   * Create a mockup generation task.
   * Uses Printful's Mockup Generator API (v2):
   *   POST /mockup-generator/create-task/{product_id}
   *
   * @param {Object} opts
   * @param {string} opts.imageUrl  - Publicly-accessible image URL
   * @param {number} [opts.productId=268] - Printful catalog product ID
   * @param {number[]} [opts.variantIds=[8948]] - Which variants to mock up
   * @param {string} [opts.placement='default'] - File placement
   * @param {number} [opts.imageAspectRatio] - Source image width/height ratio
   * @returns {{ task_key: string }} Task key for polling
   */
  async createMockupTask(opts) {
    const {
      imageUrl,
      productId = 268,
      variantIds = [8948],
      placement = "default",
      imageAspectRatio,
    } = opts;

    // Printfile dimensions per variant (products 268 + 304)
    const PRINTFILE_DIMS = {
      // Product 268 — Enhanced Matte Paper Poster (cm)
      8947:  { w: 3544,  h: 2480  }, // 21×30cm
      8948:  { w: 4724,  h: 3544  }, // 30×40cm
      8952:  { w: 8268,  h: 5906  }, // 50×70cm
      8953:  { w: 10748, h: 7200  }, // 61×91cm
      8954:  { w: 11812, h: 8268  }, // 70×100cm
      19515: { w: 9933,  h: 7016  }, // A1
      19516: { w: 7016,  h: 4961  }, // A2
      // Product 304 — Framed Poster (Black)
      9356:  { w: 3544,  h: 2480  }, // 21×30cm
      9357:  { w: 4800,  h: 3600  }, // 30×40cm
      9358:  { w: 8268,  h: 5906  }, // 50×70cm
      9359:  { w: 10800, h: 7200  }, // 61×91cm
      // Product 304 — Framed Poster (White)
      10296: { w: 3544,  h: 2480  },
      10297: { w: 4800,  h: 3600  },
      10298: { w: 8268,  h: 5906  },
      10299: { w: 10800, h: 7200  },
      // Product 304 — Framed Poster (Oak)
      11790: { w: 3544,  h: 2480  },
      11791: { w: 4800,  h: 3600  },
      11792: { w: 8268,  h: 5906  },
      11793: { w: 10800, h: 7200  },
    };

    // Use the first variant's dimensions for position
    const dims = PRINTFILE_DIMS[variantIds[0]];
    const file = { placement, image_url: imageUrl };
    if (dims) {
      let areaW = dims.w;
      let areaH = dims.h;

      // Handle Orientation & Custom Aspect Ratio Fit
      // 1. Identify "Ideal" Orientation: Print areas are typically landscape by default.
      // If the actual art piece is portrait (AR < 1), we flip the area to portrait.
      if (imageAspectRatio && imageAspectRatio < 1 && areaW > areaH) {
        [areaW, areaH] = [areaH, areaW];
      } else if (imageAspectRatio && imageAspectRatio > 1 && areaH > areaW) {
        [areaW, areaH] = [areaH, areaW];
      }

      let imgW = areaW;
      let imgH = areaH;
      let top = 0;
      let left = 0;

      // 2. Custom Aspect Ratio Fitting (No "Squeezing"):
      // Instead of forcing the image to fill the entire square/rectangle, 
      // we shrink the image layer to match the ART'S EXACT ratio, 
      // resulting in natural white space/borders in the mockup (just like a real print).
      if (imageAspectRatio && imageAspectRatio > 0) {
        const areaAspect = areaW / areaH;
        if (imageAspectRatio >= areaAspect) {
          // Artwork is wider than the frame's printable area
          imgW = areaW;
          imgH = Math.round(areaW / imageAspectRatio);
          top = Math.round((areaH - imgH) / 2);
          left = 0;
        } else {
          // Artwork is taller than the frame's printable area
          imgH = areaH;
          imgW = Math.round(areaH * imageAspectRatio);
          top = 0;
          left = Math.round((areaW - imgW) / 2);
        }
      }

      file.position = {
        area_width: areaW,
        area_height: areaH,
        width: imgW,
        height: imgH,
        top,
        left,
      };
    }

    const body = {
      variant_ids: variantIds,
      format: "jpg",
      files: [file],
    };

    const data = await this.request(
      "POST",
      `/mockup-generator/create-task/${productId}`,
      body
    );
    return data.result; // { task_key, status }
  }

  /**
   * Poll a mockup generation task until completed or failed.
   *
   * @param {string} taskKey - The task_key from createMockupTask
   * @param {Object} [opts]
   * @param {number} [opts.pollInterval=3000] - ms between polls
   * @param {number} [opts.maxWait=120000]    - max ms to wait (2 min)
   * @returns {{ status, mockups: [{ placement, variant_ids, mockup_url, extra }] }}
   */
  async pollMockupTask(taskKey, opts = {}) {
    const { pollInterval = 3000, maxWait = 120000 } = opts;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const data = await this.request(
        "GET",
        `/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`
      );

      const { status, mockups, error } = data.result;

      if (status === "completed") {
        return { status, mockups: mockups || [] };
      }
      if (status === "failed") {
        throw new Error(`Mockup task failed: ${error || "unknown error"}`);
      }

      // status === "pending" — wait and retry
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`Mockup task timed out after ${maxWait / 1000}s`);
  }

  /**
   * Generate a mockup end-to-end: create task, poll, return URLs.
   *
   * @param {string} imageUrl - Publicly-accessible image URL
   * @param {Object} [opts]   - Options forwarded to createMockupTask
   * @returns {{ mockup_url: string, extra: Array }} The first mockup result
   */
  async generateMockup(imageUrl, opts = {}) {
    const task = await this.createMockupTask({ imageUrl, ...opts });
    const result = await this.pollMockupTask(task.task_key);

    if (!result.mockups.length) {
      throw new Error("Mockup task completed but returned no mockups");
    }

    // Return the first mockup (primary wall/room scene)
    return {
      mockup_url: result.mockups[0].mockup_url,
      extra: result.mockups.slice(1).map((m) => m.mockup_url),
      all: result.mockups,
    };
  }
}

module.exports = PrintfulService;
