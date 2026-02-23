/**
 * Google Drive Service
 * -------------------
 * Connects to a Google Drive folder, lists files, downloads images,
 * and handles pagination + deduplication.
 */
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");

/**
 * Retry wrapper with exponential backoff for Drive API calls.
 * Retries on ETIMEDOUT, ECONNRESET, 429, 500, 503 errors.
 */
async function withRetry(fn, maxRetries = 5, label = "API call") {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || err.errors?.[0]?.code || "";
      const status = err.response?.status || err.status || 0;
      const retryable =
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        status === 429 ||
        status === 500 ||
        status === 503;

      if (!retryable || attempt === maxRetries) {
        console.error(`   ❌ ${label} failed after ${attempt} attempts: ${err.message || err.code}`);
        throw err;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
      console.warn(`   ⚠️ ${label} attempt ${attempt} failed (${code || status}), retrying in ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

class DriveService {
  constructor() {
    this.drive = null;
    this.downloadDir = path.join(process.cwd(), "downloads");
  }

  /**
   * Initialize the Google Drive API client using a service account.
   */
  async init() {
    let auth;

    // Support GOOGLE_SERVICE_ACCOUNT_KEY as JSON string env var (for Render/cloud)
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
    } else {
      // Fallback: read from key file on disk (local dev)
      const keyPath = path.resolve(config.google.serviceAccountKeyPath);
      if (!fs.existsSync(keyPath)) {
        throw new Error(
          `Google service account key not found at: ${keyPath}\n` +
            "Create one in Google Cloud Console → IAM → Service Accounts → Keys → Add Key → JSON.\n" +
            "Then share your Drive folder with the service account email.\n" +
            "Or set GOOGLE_SERVICE_ACCOUNT_KEY env var with the JSON contents."
        );
      }
      auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
    }

    this.drive = google.drive({ version: "v3", auth });

    // Ensure download directory exists
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    console.log("✅ Google Drive API initialized");
    return this;
  }

  /**
   * List all image files in the configured Drive folder (recursive).
   * Returns an array of { id, name, mimeType, size, parents, path, artist, qualityTier }.
   *
   * Folder structure:
   *   Root / Artist Name / Above 2900x4060 / image.jpg
   *   Root / Artist Name / Below 2900x4060 / image.jpg
   *
   * @param {string} folderId - Drive folder ID (defaults to config)
   * @param {string} folderPath - For building display paths
   * @param {string} artist - Current artist (from folder name)
   * @param {string} qualityTier - "high" or "standard" (from subfolder)
   * @param {number} maxFiles - Stop scanning once we have this many files (0 = no limit)
   * @param {object} _collector - Internal: shared array + counter across recursion
   */
  async listAllImages(folderId = null, folderPath = "", artist = "", qualityTier = "", maxFiles = 0, _collector = null) {
    const isRoot = _collector === null;
    const collector = _collector || { files: [], done: false };
    const targetFolder = folderId || config.google.driveFolderId;
    let pageToken = null;

    do {
      // Early exit if we've collected enough
      if (maxFiles > 0 && collector.files.length >= maxFiles) {
        collector.done = true;
        break;
      }

      const res = await this.drive.files.list({
        q: `'${targetFolder}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, parents, md5Checksum)",
        pageSize: maxFiles > 0 ? Math.min(1000, maxFiles * 2) : 1000,
        pageToken,
      });

      for (const file of res.data.files || []) {
        if (collector.done) break;

        // Skip macOS resource fork files
        if (file.name.startsWith("._")) continue;
        // Skip CSV files (client said they're unreliable)
        if (file.name.toLowerCase().endsWith(".csv")) continue;

        if (this._isImageFile(file)) {
          // Parse title and dimensions from filename like "Midnight Sun 1930_10057x12926.jpg"
          const parsed = this._parseFilename(file.name);

          collector.files.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: parseInt(file.size || "0", 10),
            md5: file.md5Checksum || null,
            path: folderPath ? `${folderPath}/${file.name}` : file.name,
            artist: artist || "",
            qualityTier: qualityTier || "",
            parsedTitle: parsed.title,
            parsedWidth: parsed.width,
            parsedHeight: parsed.height,
          });

          if (maxFiles > 0 && collector.files.length >= maxFiles) {
            collector.done = true;
            break;
          }
        } else if (file.mimeType === "application/vnd.google-apps.folder") {
          const subPath = folderPath ? `${folderPath}/${file.name}` : file.name;

          // Determine context from folder depth
          let nextArtist = artist;
          let nextTier = qualityTier;

          if (!artist) {
            // This is an artist folder (first level)
            nextArtist = file.name;
          } else if (!qualityTier) {
            // This is a quality tier folder (second level)
            nextTier = file.name.toLowerCase().includes("above") ? "high" : "standard";
          }

          await this.listAllImages(file.id, subPath, nextArtist, nextTier, maxFiles, collector);
          if (collector.done) break;
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken && !collector.done);

    return isRoot ? collector.files : collector.files;
  }

  /**
   * FAST: Get images by batching artist folders in parallel.
   * Instead of walking 19k folders one by one, we grab a page of artist folders
   * and then scan their subfolders concurrently.
   */
  async listImagesFast(maxFiles = 100) {
    const pLimit = require("p-limit");
    const limit = pLimit(30); // 30 concurrent Drive API calls for speed
    const collected = [];
    const ROOT = config.google.driveFolderId;

    // Step 1: Fetch ALL artist folders first (paginated)
    console.log("   🔍 Fetching all artist folders...");
    const allArtistFolders = [];
    let folderPageToken = null;
    do {
      const foldersRes = await withRetry(() => this.drive.files.list({
        q: `'${ROOT}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: "nextPageToken, files(id, name)",
        pageSize: 1000,
        pageToken: folderPageToken,
      }), 5, "list artist folders");
      const batch = foldersRes.data.files || [];
      allArtistFolders.push(...batch);
      folderPageToken = foldersRes.data.nextPageToken;
      console.log(`   📁 Fetched ${allArtistFolders.length} artist folders...`);
    } while (folderPageToken);
    console.log(`   ✅ Total artist folders: ${allArtistFolders.length}`);

    // Apply limit to artists if maxFiles is small (for testing)
    let artistsToProcess = allArtistFolders;
    if (maxFiles > 0 && maxFiles < 100) {
      artistsToProcess = allArtistFolders.slice(0, Math.ceil(maxFiles / 5));
    }

    // Step 2: Process all artists concurrently with high parallelism
    console.log(`   🚀 Scanning images from ${artistsToProcess.length} artists (concurrency: 30)...`);
    let artistsDone = 0;
    const startScan = Date.now();

    const tasks = artistsToProcess.map(artist => limit(async () => {
      if (maxFiles > 0 && collected.length >= maxFiles) return;

      try {
        // Get sub-folders (Above/Below)
        const subRes = await withRetry(() => this.drive.files.list({
          q: `'${artist.id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
          fields: "files(id, name)",
          pageSize: 10,
        }), 5, `list subfolders for ${artist.name}`);

        for (const tier of (subRes.data.files || [])) {
          if (maxFiles > 0 && collected.length >= maxFiles) return;

          const qualityTier = tier.name.toLowerCase().includes("above") ? "high" : "standard";

          // Get ALL images in this tier folder (paginated)
          let imgPageToken = null;
          do {
            const imgRes = await withRetry(() => this.drive.files.list({
              q: `'${tier.id}' in parents and trashed = false`,
              fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum)",
              pageSize: 1000,
              pageToken: imgPageToken,
            }), 5, `list images for ${artist.name}/${tier.name}`);

            for (const file of (imgRes.data.files || [])) {
              if (maxFiles > 0 && collected.length >= maxFiles) return;
              if (file.name.startsWith("._")) continue;
              if (file.name.toLowerCase().endsWith(".csv")) continue;
              if (!this._isImageFile(file)) continue;

              const parsed = this._parseFilename(file.name);
              collected.push({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                size: parseInt(file.size || "0", 10),
                md5: file.md5Checksum || null,
                path: `${artist.name}/${tier.name}/${file.name}`,
                artist: artist.name,
                qualityTier,
                parsedTitle: parsed.title,
                parsedWidth: parsed.width,
                parsedHeight: parsed.height,
              });
            }

            imgPageToken = imgRes.data.nextPageToken;
          } while (imgPageToken);
        }
      } catch (err) {
        console.error(`   ⚠️ Error scanning ${artist.name}: ${err.message}`);
      }

      artistsDone++;
      if (artistsDone % 500 === 0) {
        const elapsed = ((Date.now() - startScan) / 1000).toFixed(0);
        console.log(`   📊 ${artistsDone}/${artistsToProcess.length} artists scanned | ${collected.length} images | ${elapsed}s`);
      }
    }));

    await Promise.all(tasks);

    const totalElapsed = ((Date.now() - startScan) / 1000).toFixed(0);
    console.log(`   ✅ Scan complete: ${collected.length} images from ${artistsDone} artists in ${totalElapsed}s`);

    // Trim to exact limit
    if (maxFiles > 0 && collected.length > maxFiles) {
      collected.length = maxFiles;
    }

    return collected;
  }
  async listArtistFolders() {
    const folders = [];
    let pageToken = null;

    do {
      const res = await this.drive.files.list({
        q: `'${config.google.driveFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: "nextPageToken, files(id, name)",
        pageSize: 1000,
        pageToken,
      });
      folders.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    return folders;
  }

  /**
   * Parse artwork title and pixel dimensions from filename.
   * e.g. "Midnight Sun 1930_10057x12926.jpg" → { title: "Midnight Sun 1930", width: 10057, height: 12926 }
   */
  _parseFilename(filename) {
    const nameWithoutExt = path.basename(filename, path.extname(filename));
    // Match pattern: "Title_WIDTHxHEIGHT" at the end
    const match = nameWithoutExt.match(/^(.+?)_(\d+)x(\d+)$/);
    if (match) {
      return {
        title: match[1].replace(/[-_]+/g, " ").trim(),
        width: parseInt(match[2], 10),
        height: parseInt(match[3], 10),
      };
    }
    // Fallback: no dimensions in filename
    return {
      title: nameWithoutExt.replace(/[-_]+/g, " ").trim(),
      width: 0,
      height: 0,
    };
  }

  /**
   * Download a single file from Drive to local disk.
   * Returns { localPath, hash }.
   */
  async downloadFile(fileId, filename) {
    const localPath = path.join(this.downloadDir, fileId + "_" + filename);

    // Skip if already downloaded
    if (fs.existsSync(localPath)) {
      const hash = await this._hashFile(localPath);
      return { localPath, hash };
    }

    const res = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(localPath);
      const hashStream = crypto.createHash("sha256");

      res.data
        .on("data", (chunk) => hashStream.update(chunk))
        .on("error", reject)
        .pipe(dest)
        .on("finish", () => {
          const hash = hashStream.digest("hex");
          resolve({ localPath, hash });
        })
        .on("error", reject);
    });
  }

  /**
   * Check if a file object is an image.
   */
  _isImageFile(file) {
    const imageTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/tiff",
      "image/bmp",
      "image/gif",
    ];
    if (imageTypes.includes(file.mimeType)) return true;

    // Also check extension
    const ext = path.extname(file.name).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".tif", ".bmp", ".gif"].includes(ext);
  }

  /**
   * SHA-256 hash of a local file (for dedup).
   */
  async _hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }
}

module.exports = DriveService;
