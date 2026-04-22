/**
 * Prodigi Integration — Neverland Prints
 * ========================================
 * POD fulfillment via Prodigi Print API v4.
 *
 * Handles custom-dimension artworks by mapping to the closest available
 * Fine Art Paper (FAP) SKU and using "fitPrintArea" sizing, which preserves
 * the exact artwork aspect ratio within the print area (small white borders
 * may appear on non-matching sides — standard fine art print practice).
 *
 * Prodigi API docs: https://www.prodigi.com/print-api/docs/reference/
 * Ships worldwide, including Nigeria.
 *
 * Required env:
 *   PRODIGI_API_KEY   — from dashboard.prodigi.com > Settings > Integrations > API
 *   PRODIGI_SANDBOX   — set to "true" to use sandbox (default: live)
 */

const PRODIGI_BASE_LIVE    = "https://api.prodigi.com/v4.0";
const PRODIGI_BASE_SANDBOX = "https://api.sandbox.prodigi.com/v4.0";

/**
 * Prodigi Fine Art Paper (FAP) product catalog.
 * SKU format: GLOBAL-FAP-{W}x{H} where W/H are in inches.
 * cm values are W_in × 2.54 (rounded to 1dp for display).
 *
 * To add more sizes: verify against the Prodigi dashboard/sandbox first,
 * then append an entry to this array.
 */
const FAP_CATALOG = [
  // ── Portrait ────────────────────────────────────────────────────────────
  { sku: "GLOBAL-FAP-8x10",  wCm: 20.3, hCm: 25.4 },
  { sku: "GLOBAL-FAP-8x12",  wCm: 20.3, hCm: 30.5 },
  { sku: "GLOBAL-FAP-11x14", wCm: 27.9, hCm: 35.6 },
  { sku: "GLOBAL-FAP-12x16", wCm: 30.5, hCm: 40.6 },
  { sku: "GLOBAL-FAP-12x18", wCm: 30.5, hCm: 45.7 },
  { sku: "GLOBAL-FAP-16x20", wCm: 40.6, hCm: 50.8 },
  { sku: "GLOBAL-FAP-16x24", wCm: 40.6, hCm: 60.9 },
  { sku: "GLOBAL-FAP-18x24", wCm: 45.7, hCm: 60.9 },
  { sku: "GLOBAL-FAP-20x24", wCm: 50.8, hCm: 60.9 },
  { sku: "GLOBAL-FAP-20x30", wCm: 50.8, hCm: 76.2 },
  { sku: "GLOBAL-FAP-24x30", wCm: 60.9, hCm: 76.2 },
  { sku: "GLOBAL-FAP-24x36", wCm: 60.9, hCm: 91.4 },

  // ── Landscape ───────────────────────────────────────────────────────────
  { sku: "GLOBAL-FAP-10x8",  wCm: 25.4, hCm: 20.3 },
  { sku: "GLOBAL-FAP-12x8",  wCm: 30.5, hCm: 20.3 },
  { sku: "GLOBAL-FAP-14x11", wCm: 35.6, hCm: 27.9 },
  { sku: "GLOBAL-FAP-16x12", wCm: 40.6, hCm: 30.5 },
  { sku: "GLOBAL-FAP-18x12", wCm: 45.7, hCm: 30.5 },
  { sku: "GLOBAL-FAP-20x16", wCm: 50.8, hCm: 40.6 },
  { sku: "GLOBAL-FAP-24x16", wCm: 60.9, hCm: 40.6 },
  { sku: "GLOBAL-FAP-24x18", wCm: 60.9, hCm: 45.7 },
  { sku: "GLOBAL-FAP-24x20", wCm: 60.9, hCm: 50.8 },
  { sku: "GLOBAL-FAP-30x20", wCm: 76.2, hCm: 50.8 },
  { sku: "GLOBAL-FAP-30x24", wCm: 76.2, hCm: 60.9 },
  { sku: "GLOBAL-FAP-36x24", wCm: 91.4, hCm: 60.9 },

  // ── Square ──────────────────────────────────────────────────────────────
  { sku: "GLOBAL-FAP-8x8",   wCm: 20.3, hCm: 20.3 },
  { sku: "GLOBAL-FAP-10x10", wCm: 25.4, hCm: 25.4 },
  { sku: "GLOBAL-FAP-12x12", wCm: 30.5, hCm: 30.5 },
  { sku: "GLOBAL-FAP-16x16", wCm: 40.6, hCm: 40.6 },
  { sku: "GLOBAL-FAP-20x20", wCm: 50.8, hCm: 50.8 },
  { sku: "GLOBAL-FAP-24x24", wCm: 60.9, hCm: 60.9 },

  // ── Wide Panoramic ───────────────────────────────────────────────────────
  // For very wide/tall artwork, use portrait/landscape sizes with fitPrintArea
  // The print may have larger borders but the artwork is always shown in full
];

class ProdigiService {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.PRODIGI_API_KEY;
    const sandbox = process.env.PRODIGI_SANDBOX === "true";
    this.baseUrl = sandbox ? PRODIGI_BASE_SANDBOX : PRODIGI_BASE_LIVE;
    if (!this.apiKey) {
      console.warn("⚠️  PRODIGI_API_KEY not set — Prodigi fulfillment disabled");
    }
  }

  // ── Internal API helper ────────────────────────────────────────────────

  async _request(method, endpoint, body = null) {
    if (!this.apiKey) throw new Error("Prodigi API key not configured");

    const opts = {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${endpoint}`, opts);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Prodigi ${method} ${endpoint}: ${res.status} — ${text.slice(0, 400)}`);
    }

    return res.json();
  }

  // ── Static helpers ─────────────────────────────────────────────────────

  /**
   * Parse a Neverland size string like "40 × 28.57 cm" into { widthCm, heightCm }.
   * Handles both the Unicode × character and ASCII x.
   * Returns null if the format is unrecognised.
   *
   * @param {string} sizeStr
   * @returns {{ widthCm: number, heightCm: number } | null}
   */
  static parseSizeCm(sizeStr) {
    if (!sizeStr) return null;
    const match = sizeStr.match(/(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    return {
      widthCm: parseFloat(match[1]),
      heightCm: parseFloat(match[2]),
    };
  }

  /**
   * Find the best-fit Prodigi FAP SKU for the given artwork print dimensions.
   *
   * Strategy:
   *  1. Determine orientation from width/height ratio.
   *  2. Filter catalog to same orientation.
   *  3. Among SKUs at least as large (dominant dimension ≥ artwork dominant),
   *     pick the one with smallest total area (minimises white border waste).
   *  4. Fall back to the largest same-orientation SKU if none are large enough.
   *
   * Because Prodigi's "fitPrintArea" mode ensures the image always fits at
   * the correct aspect ratio, small size mismatches produce only thin borders.
   *
   * @param {number} widthCm
   * @param {number} heightCm
   * @returns {{ sku: string, wCm: number, hCm: number }}
   */
  static findClosestSku(widthCm, heightCm) {
    const ratio = widthCm / heightCm;
    const isSquare    = ratio >= 0.93 && ratio <= 1.07;
    const isLandscape = !isSquare && widthCm > heightCm;
    const isPortrait  = !isSquare && heightCm > widthCm;

    // Filter by orientation
    let candidates;
    if (isSquare) {
      candidates = FAP_CATALOG.filter(s => {
        const r = s.wCm / s.hCm;
        return r >= 0.93 && r <= 1.07;
      });
    } else if (isLandscape) {
      candidates = FAP_CATALOG.filter(s => s.wCm > s.hCm);
    } else {
      candidates = FAP_CATALOG.filter(s => s.hCm > s.wCm);
    }

    if (candidates.length === 0) {
      // Should never happen; fallback to full catalog
      candidates = FAP_CATALOG;
    }

    // Find candidates at least as large in the dominant dimension (within 5% tolerance)
    const dominantArtwork = isLandscape ? widthCm : heightCm;
    const qualifying = candidates.filter(s => {
      const skuDominant = isLandscape ? s.wCm : s.hCm;
      return skuDominant >= dominantArtwork * 0.95;
    });

    if (qualifying.length === 0) {
      // Artwork is larger than anything in catalog — use the largest available
      candidates.sort((a, b) => (b.wCm * b.hCm) - (a.wCm * a.hCm));
      return candidates[0];
    }

    // Pick smallest qualifying by total area (least wasted paper)
    qualifying.sort((a, b) => (a.wCm * a.hCm) - (b.wCm * b.hCm));
    return qualifying[0];
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Create a Prodigi order for a single artwork print.
   *
   * @param {object} params
   * @param {object} params.recipient     - Shipping recipient details
   * @param {string} params.recipient.name
   * @param {string} [params.recipient.email]
   * @param {string} [params.recipient.phone]
   * @param {string} params.recipient.address1
   * @param {string} [params.recipient.address2]
   * @param {string} params.recipient.city
   * @param {string} [params.recipient.state_code]
   * @param {string} params.recipient.country_code  - ISO 2-letter code
   * @param {string} params.recipient.zip
   * @param {string} params.imageUrl       - Publicly accessible full-res image URL
   * @param {number} params.widthCm        - Ordered print width in cm
   * @param {number} params.heightCm       - Ordered print height in cm
   * @param {string} params.title          - Artwork title (for reference)
   * @param {string} params.externalId     - Your order/line-item reference
   * @param {string} [params.shippingMethod] - Budget|Standard|StandardPlus|Express|Overnight
   *
   * @returns {{ id: string, sku: string, outcome: string }}
   */
  async createOrder({
    recipient,
    imageUrl,
    widthCm,
    heightCm,
    title,
    externalId,
    shippingMethod = "Standard",
  }) {
    const skuInfo = ProdigiService.findClosestSku(widthCm, heightCm);

    console.log(
      `   📐 Prodigi SKU: ${skuInfo.sku} (${skuInfo.wCm}×${skuInfo.hCm}cm paper)` +
      ` for ${widthCm}×${heightCm}cm artwork`
    );

    const orderPayload = {
      merchantReference: externalId,
      shippingMethod,
      recipient: {
        name: recipient.name,
        ...(recipient.email    ? { email:       recipient.email }    : {}),
        ...(recipient.phone    ? { phoneNumber: recipient.phone }    : {}),
        address: {
          line1:          recipient.address1,
          ...(recipient.address2 ? { line2: recipient.address2 } : {}),
          postalOrZipCode: recipient.zip,
          countryCode:    recipient.country_code,
          townOrCity:     recipient.city,
          ...(recipient.state_code ? { stateOrCounty: recipient.state_code } : {}),
        },
      },
      items: [
        {
          merchantReference: `${externalId}-print`,
          sku:               skuInfo.sku,
          copies:            1,
          sizing:            "fitPrintArea",  // preserves artwork aspect ratio
          assets: [
            {
              printArea: "default",
              url:       imageUrl,
            },
          ],
        },
      ],
      metadata: {
        title,
        artworkWidthCm:  String(widthCm),
        artworkHeightCm: String(heightCm),
        externalId,
      },
    };

    const data = await this._request("POST", "/Orders", orderPayload);

    return {
      id:      data.order?.id,
      sku:     skuInfo.sku,
      outcome: data.outcome,
    };
  }

  /**
   * Get a cost quote without creating an order.
   *
   * @param {object} params
   * @param {string} params.countryCode   - Destination ISO country code
   * @param {number} params.widthCm
   * @param {number} params.heightCm
   * @param {string} [params.currencyCode] - Default: USD
   * @param {string} [params.shippingMethod]
   *
   * @returns {{ quotes: Array, sku: string }}
   */
  async getQuote({ countryCode, widthCm, heightCm, currencyCode = "USD", shippingMethod }) {
    const skuInfo = ProdigiService.findClosestSku(widthCm, heightCm);

    const payload = {
      destinationCountryCode: countryCode,
      currencyCode,
      items: [
        {
          sku:    skuInfo.sku,
          copies: 1,
          assets: [{ printArea: "default" }],
        },
      ],
    };
    if (shippingMethod) payload.shippingMethod = shippingMethod;

    const data = await this._request("POST", "/Quotes", payload);

    return { quotes: data.quotes, sku: skuInfo.sku, outcome: data.outcome };
  }

  /**
   * Get an existing Prodigi order by ID.
   */
  async getOrder(prodigiOrderId) {
    return this._request("GET", `/Orders/${prodigiOrderId}`);
  }

  /**
   * Cancel a Prodigi order (only before fulfilment begins).
   */
  async cancelOrder(prodigiOrderId) {
    return this._request("POST", `/Orders/${prodigiOrderId}/actions/cancel`);
  }

  /**
   * Verify API connectivity.
   */
  async verifyConnection() {
    try {
      const data = await this._request("GET", "/Orders?top=1");
      return { connected: true, environment: this.baseUrl.includes("sandbox") ? "sandbox" : "live" };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  }
}

module.exports = ProdigiService;
