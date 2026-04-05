/**
 * Printful Background Cache
 * =========================
 * Fetches Printful data in the background on server boot and
 * refreshes every 10 minutes. Dashboard reads from this cache
 * so pages load instantly instead of hanging on live API calls.
 */

const PrintfulService = require("./printful");

class PrintfulCache {
  constructor() {
    this.printful = new PrintfulService();
    this.cache = {
      status: null,
      products: null,
      orders: null,
    };
    this.lastSync = null;
    this.syncing = false;
    this.errors = {};
    this.refreshInterval = null;
  }

  /** Start background sync — call once at server boot */
  start(intervalMs = 10 * 60 * 1000) {
    console.log("🔄 Printful cache: starting background sync...");
    // First sync immediately (don't await — let server start)
    this.sync();
    // Then refresh on interval
    this.refreshInterval = setInterval(() => this.sync(), intervalMs);
  }

  stop() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  /** Run a full sync of all Printful data */
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    const start = Date.now();

    // Sync each piece independently so one failure doesn't block others
    await Promise.allSettled([
      this._syncStatus(),
      this._syncProducts(),
      this._syncOrders(),
    ]);

    this.lastSync = new Date().toISOString();
    this.syncing = false;
    console.log(`✅ Printful cache synced in ${Date.now() - start}ms`);
  }

  async _syncStatus() {
    try {
      const status = await this.printful.verifyConnection();
      this.cache.status = status;
      delete this.errors.status;
    } catch (e) {
      this.errors.status = e.message;
      console.error("❌ Printful cache: status sync failed:", e.message);
    }
  }

  async _syncProducts() {
    try {
      const products = await this.printful.getProducts();
      this.cache.products = products;
      delete this.errors.products;
    } catch (e) {
      this.errors.products = e.message;
      console.error("❌ Printful cache: products sync failed:", e.message);
    }
  }

  async _syncOrders() {
    try {
      const orders = await this.printful.listOrders(0, 50);
      this.cache.orders = orders;
      delete this.errors.orders;
    } catch (e) {
      this.errors.orders = e.message;
      console.error("❌ Printful cache: orders sync failed:", e.message);
    }
  }

  /** Get cached data — returns instantly */
  getStatus() {
    if (this.cache.status) return this.cache.status;
    if (this.errors.status) return { connected: false, error: this.errors.status };
    return { connected: false, error: "Syncing — data will appear shortly" };
  }

  getProducts() {
    if (this.cache.products) return this.cache.products;
    return [];
  }

  getOrders() {
    if (this.cache.orders) return this.cache.orders;
    return [];
  }

  /** Cache metadata for the dashboard */
  getMeta() {
    return {
      lastSync: this.lastSync,
      syncing: this.syncing,
      errors: this.errors,
      cached: {
        status: !!this.cache.status,
        products: this.cache.products?.length ?? 0,
        orders: this.cache.orders?.length ?? 0,
      },
    };
  }
}

// Singleton
module.exports = new PrintfulCache();
