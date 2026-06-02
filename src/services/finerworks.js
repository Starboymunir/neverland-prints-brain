/**
 * FinerWorks Integration — Neverland Prints
 * =========================================
 * POD fulfillment via FinerWorks API v2/v3.
 *
 * Uses product codes (or virtual-inventory SKU) on order submission.
 * If no explicit product code is provided, we build a simple archival matte
 * product code from print dimensions using the documented pattern:
 *   5M6M9S{W}X{H}
 *
 * Docs:
 * - GET  /v3/test_my_credentials
 * - POST /v3/get_prices
 * - POST /v3/submit_orders_v2
 */

const FINERWORKS_BASE = "https://v2.api.finerworks.com";

class FinerWorksService {
  constructor({ webApiKey, appKey } = {}) {
    this.webApiKey = webApiKey || process.env.FINERWORKS_WEB_API_KEY;
    this.appKey = appKey || process.env.FINERWORKS_APP_KEY;
    this.baseUrl = process.env.FINERWORKS_BASE_URL || FINERWORKS_BASE;
    this.testMode = process.env.FINERWORKS_TEST_MODE !== "false";
    this.defaultShippingCode = process.env.FINERWORKS_DEFAULT_SHIPPING_CODE || "SD";
    this.paymentToken = process.env.FINERWORKS_PAYMENT_TOKEN || "xxxx";

    if (!this.webApiKey || !this.appKey) {
      console.warn("⚠️  FINERWORKS credentials not set — FinerWorks fulfillment disabled");
    }
  }

  async _request(method, endpoint, body = null) {
    if (!this.webApiKey || !this.appKey) {
      throw new Error("FinerWorks credentials not configured");
    }

    const headers = {
      "Content-Type": "application/json",
      web_api_key: this.webApiKey,
      app_key: this.appKey,
    };

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${endpoint}`, opts);
    const text = await res.text();

    let data = text;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // Keep plain text response if not JSON
    }

    if (!res.ok) {
      throw new Error(`FinerWorks ${method} ${endpoint}: ${res.status} — ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
    }

    return data;
  }

  static parseSizeCm(sizeStr) {
    if (!sizeStr) return null;
    const match = sizeStr.match(/(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    return {
      widthCm: parseFloat(match[1]),
      heightCm: parseFloat(match[2]),
    };
  }

  static cmToInchesRounded(cm) {
    return Math.max(4, Math.round(cm / 2.54));
  }

  /**
   * Builds a default archival matte paper product code.
   * Pattern source from FinerWorks docs examples:
   *   5M6M9S16X20
   */
  static buildDefaultProductCode(widthCm, heightCm) {
    const wIn = FinerWorksService.cmToInchesRounded(widthCm);
    const hIn = FinerWorksService.cmToInchesRounded(heightCm);
    const w = Math.min(wIn, hIn);
    const h = Math.max(wIn, hIn);
    return `5M6M9S${w}X${h}`;
  }

  _splitName(fullName) {
    const clean = (fullName || "").trim();
    if (!clean) return { first: "Customer", last: "" };
    const parts = clean.split(/\s+/);
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  async verifyConnection() {
    try {
      const result = await this._request("GET", "/v3/test_my_credentials");
      return {
        connected: true,
        testMode: this.testMode,
        result,
      };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  async getPrices({ productCodes }) {
    if (!Array.isArray(productCodes) || productCodes.length === 0) {
      throw new Error("productCodes is required");
    }

    const body = {
      products: productCodes.map((code) => ({
        product_qty: 1,
        product_sku: code,
      })),
      account_key: null,
    };

    return this._request("POST", "/v3/get_prices", body);
  }

  /**
   * Get live shipping options + costs from FinerWorks for a preview order.
   * Used by the Shopify CarrierService callback at checkout.
   *
   * recipient: { first_name?, last_name?, address1, city, state_code?, zip, country_code }
   * items:     [{ product_sku, product_qty, product_title? }]   ← FW product codes
   *
   * Returns the raw FinerWorks response. The shape we care about per order is
   * an array of shipping options: { shipping_code, shipping_name|service_name,
   * shipping_cost|total_cost, currency?, expected_delivery_days? }.
   */
  async listShippingOptions({ recipient, items }) {
    if (!recipient || !recipient.country_code) {
      throw new Error("recipient.country_code is required");
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("items[] is required");
    }

    const orderPo = `RATE-${Date.now()}`;
    const order = {
      order_po: orderPo,
      order_key: null,
      recipient: {
        first_name: recipient.first_name || "Customer",
        last_name: recipient.last_name || "Estimate",
        company_name: null,
        address_1: recipient.address1 || "N/A",
        address_2: recipient.address2 || null,
        address_3: null,
        city: recipient.city || "N/A",
        state_code: recipient.state_code || null,
        province: null,
        zip_postal_code: recipient.zip || "",
        country_code: (recipient.country_code || "US").toLowerCase(),
        phone: null,
        email: null,
        address_order_po: orderPo,
      },
      order_items: items.map((it, idx) => ({
        product_order_po: `${orderPo}-${idx}`,
        product_qty: it.product_qty || 1,
        product_sku: it.product_sku,
        product_image: null,
        product_title: it.product_title || "Print",
        template: null,
        product_guid: "00000000-0000-0000-0000-000000000000",
      })),
      shipping_code: null,
      ship_by_date: null,
      customs_tax_info: null,
      gift_message: null,
      test_mode: this.testMode,
      source: "neverland-prints-rates",
    };

    const body = {
      orders: [order],
      payment_token: this.paymentToken,
      account_key: null,
    };

    return this._request("POST", "/v3/list_shipping_options_multiple", body);
  }

  /**
   * Create a FinerWorks order.
   * productCode can be either a FinerWorks product code or a virtual inventory SKU.
   */
  async createOrder({
    recipient,
    imageUrl,
    thumbnailUrl,
    pixelWidth,
    pixelHeight,
    productCode,
    quantity = 1,
    title,
    externalId,
    shippingCode,
  }) {
    const { first, last } = this._splitName(recipient.name);

    // product_image is required as an object (schema: product_image_file)
    // when not submitting a virtual-inventory SKU. Build it from the supplied
    // image URL plus pixel dimensions (FinerWorks rejects with "missing or
    // invalid info" if dims aren't provided).
    let productImage = null;
    if (imageUrl) {
      productImage = {
        pixel_width: pixelWidth || 0,
        pixel_height: pixelHeight || 0,
        product_url_file: imageUrl,
        product_url_thumbnail: thumbnailUrl || imageUrl,
        library_file: null,
      };
    }

    const order = {
      order_po: externalId,
      order_key: null,
      recipient: {
        first_name: first,
        last_name: last,
        company_name: null,
        address_1: recipient.address1,
        address_2: recipient.address2 || null,
        address_3: null,
        city: recipient.city,
        state_code: recipient.state_code || null,
        province: null,
        zip_postal_code: recipient.zip,
        country_code: (recipient.country_code || "US").toLowerCase(),
        phone: recipient.phone || null,
        email: recipient.email || null,
        address_order_po: externalId,
      },
      order_items: [
        {
          product_order_po: externalId,
          product_qty: quantity,
          product_sku: productCode,
          product_image: productImage,
          product_title: title || "Artwork Print",
          template: null,
          product_guid: "00000000-0000-0000-0000-000000000000",
          custom_data_1: null,
          custom_data_2: null,
          custom_data_3: null,
        },
      ],
      shipping_code: shippingCode || this.defaultShippingCode,
      ship_by_date: null,
      customs_tax_info: null,
      gift_message: null,
      test_mode: this.testMode,
      webhook_order_status_url: process.env.FINERWORKS_WEBHOOK_URL || null,
      document_url: null,
      acct_number_ups: null,
      acct_number_fedex: null,
      custom_data_1: null,
      custom_data_2: null,
      custom_data_3: null,
      source: "neverland-prints",
    };

    const body = {
      orders: [order],
      validate_only: false,
      payment_token: this.paymentToken,
      account_key: null,
    };

    const response = await this._request("POST", "/v3/submit_orders_v2", body);

    return {
      id: externalId,
      productCode,
      response,
    };
  }
}

module.exports = FinerWorksService;
