/**
 * Image Proxy / CDN Service
 * --------------------------
 * Provides reliable, fast image delivery from Google Drive.
 *
 * Strategy:
 *   1. Google Drive images via lh3 URLs (primary — fast, resizable)
 *   2. Google Drive API direct stream (fallback — always works)
 *   3. In-memory LRU cache for hot images (prevents repeat Drive hits)
 *
 * Why a proxy?
 *   - lh3 URLs can be throttled by Google at high traffic
 *   - We control cache headers (browser caching, CDN-friendly)
 *   - We can add watermarks, transformations later
 *   - If Google blocks direct hotlinking, the store still works
 *   - We can serve WebP/AVIF for smaller payloads
 *
 * URL Pattern:
 *   /img/{driveFileId}?w=800&q=85&fmt=webp
 */

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const config = require("../config");

class ImageProxy {
  constructor() {
    this.drive = null;
    this.cache = new Map();           // driveId:size → { buffer, contentType, timestamp }
    this.maxCacheSize = 200;          // max images in memory cache
    this.cacheTTL = 60 * 60 * 1000;  // 1 hour TTL
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  async init() {
    const keyPath = path.resolve(config.google.serviceAccountKeyPath);
    if (fs.existsSync(keyPath)) {
      const auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
      this.drive = google.drive({ version: "v3", auth });
      console.log("✅ Image Proxy initialized (with Drive API fallback)");
    } else {
      console.log("⚠️  Image Proxy initialized (lh3 only — no Drive API fallback)");
    }
    return this;
  }

  /**
   * Build the best image URL for a given Drive file ID and size.
   * This is what the theme should use — either a direct lh3 URL
   * or our proxy URL if running behind the brain server.
   *
   * @param {string} driveFileId
   * @param {number} width - desired width in pixels
   * @returns {string} image URL
   */
  getImageUrl(driveFileId, width = 800) {
    // lh3 URL is the fastest path — Google serves resized images
    // =s{N} sets the longest edge to N pixels
    // =w{N} sets width, =h{N} sets height
    // =s0 returns the original size
    return `https://lh3.googleusercontent.com/d/${driveFileId}=s${width}`;
  }

  /**
   * Get multiple image URLs for srcset (responsive images).
   * Returns object with URLs for different sizes.
   */
  getResponsiveUrls(driveFileId) {
    return {
      thumbnail: this.getImageUrl(driveFileId, 200),
      small: this.getImageUrl(driveFileId, 400),
      medium: this.getImageUrl(driveFileId, 800),
      large: this.getImageUrl(driveFileId, 1200),
      xl: this.getImageUrl(driveFileId, 1600),
      original: this.getImageUrl(driveFileId, 0), // =s0 is original
      srcset: [
        `https://lh3.googleusercontent.com/d/${driveFileId}=s400 400w`,
        `https://lh3.googleusercontent.com/d/${driveFileId}=s800 800w`,
        `https://lh3.googleusercontent.com/d/${driveFileId}=s1200 1200w`,
        `https://lh3.googleusercontent.com/d/${driveFileId}=s1600 1600w`,
      ].join(", "),
    };
  }

  /**
   * Stream image from Drive API (fallback when lh3 fails).
   * Used by the proxy endpoint.
   */
  async streamFromDrive(driveFileId) {
    if (!this.drive) {
      throw new Error("Drive API not available — cannot stream");
    }

    const res = await this.drive.files.get(
      { fileId: driveFileId, alt: "media" },
      { responseType: "stream" }
    );

    return {
      stream: res.data,
      contentType: res.headers["content-type"] || "image/jpeg",
    };
  }

  /**
   * Get image as buffer with caching.
   * Used by the proxy endpoint for cache + transform.
   */
  async getImageBuffer(driveFileId, size = 800) {
    const cacheKey = `${driveFileId}:${size}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      this.cacheHits++;
      return cached;
    }
    this.cacheMisses++;

    // Try lh3 first (fastest)
    try {
      const url = this.getImageUrl(driveFileId, size);
      const res = await fetch(url);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") || "image/jpeg";
        const entry = { buffer, contentType, timestamp: Date.now() };
        this._putCache(cacheKey, entry);
        return entry;
      }
    } catch (e) {
      // lh3 failed, try Drive API
    }

    // Fallback: Drive API
    if (this.drive) {
      const res = await this.drive.files.get(
        { fileId: driveFileId, alt: "media" },
        { responseType: "arraybuffer" }
      );
      const buffer = Buffer.from(res.data);
      const contentType = res.headers["content-type"] || "image/jpeg";
      const entry = { buffer, contentType, timestamp: Date.now() };
      this._putCache(cacheKey, entry);
      return entry;
    }

    throw new Error(`Cannot fetch image ${driveFileId}`);
  }

  /**
   * Get image dimensions from Drive without downloading the full file.
   * Uses the Drive API to get file metadata.
   */
  async getImageMetadata(driveFileId) {
    if (!this.drive) {
      throw new Error("Drive API not available");
    }

    const res = await this.drive.files.get({
      fileId: driveFileId,
      fields: "id, name, mimeType, size, imageMediaMetadata",
    });

    const meta = res.data.imageMediaMetadata;
    return {
      id: res.data.id,
      name: res.data.name,
      mimeType: res.data.mimeType,
      size: parseInt(res.data.size || "0", 10),
      width: meta?.width || 0,
      height: meta?.height || 0,
      rotation: meta?.rotation || 0,
    };
  }

  /**
   * Batch get image dimensions for multiple files.
   * Uses parallel requests with concurrency limit.
   */
  async batchGetMetadata(driveFileIds, concurrency = 10) {
    const pLimit = require("p-limit");
    const limit = pLimit(concurrency);

    const results = await Promise.all(
      driveFileIds.map((id) =>
        limit(async () => {
          try {
            return await this.getImageMetadata(id);
          } catch (e) {
            return { id, error: e.message };
          }
        })
      )
    );

    return results;
  }

  /**
   * Simple LRU cache put with eviction.
   */
  _putCache(key, value) {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest entry
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }

  /**
   * Get cache stats for monitoring.
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: this.cacheHits + this.cacheMisses > 0
        ? ((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100).toFixed(1) + "%"
        : "n/a",
    };
  }
}

module.exports = ImageProxy;
