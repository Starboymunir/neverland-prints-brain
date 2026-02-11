/**
 * AI Tagger — Gemini Flash
 * -------------------------
 * Analyzes artwork images and generates structured metadata:
 *   - Title, description
 *   - Style, era, palette, mood, subject
 *   - Tags array
 *
 * Supports TWO modes:
 *   1. URL-based (preferred) — sends lh3 image URL to Gemini, NO download needed
 *   2. File-based (fallback) — reads local file and sends as base64
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const config = require("../config");

const TAG_PROMPT = `You are an expert art curator and metadata specialist. Analyze this artwork image and return a JSON object with the following fields. Be concise and specific. Do NOT wrap in markdown code blocks, just return raw JSON.

{
  "title": "A short, evocative title for this artwork (3-8 words)",
  "description": "A brief description of the artwork for an online gallery (1-2 sentences, max 200 chars)",
  "style": "One primary style from: minimalist, abstract, pop-art, impressionist, realism, surrealism, geometric, line-art, watercolor, digital-art, photography, mixed-media, vintage, modern, contemporary, illustrative, graffiti, collage, typographic, other",
  "era": "Estimated era or decade from: classical, renaissance, 1920s, 1930s, 1940s, 1950s, 1960s, 1970s, 1980s, 1990s, 2000s, 2010s, 2020s, timeless, unknown",
  "palette": "One from: warm, cool, neutral, vivid, muted, monochrome, pastel, dark, bright, earth-tones, neon",
  "mood": "One from: calm, energetic, melancholic, joyful, mysterious, dramatic, serene, playful, intense, romantic, nostalgic, futuristic, dark, whimsical",
  "subject": "Primary subject from: portrait, landscape, cityscape, nature, animal, abstract-shapes, still-life, architecture, seascape, space, botanical, figure, pattern, text-based, vehicle, food, music, sport, mythology, other",
  "tags": ["array", "of", "5-10", "descriptive", "tags", "for", "search"]
}`;

class AiTagger {
  constructor() {
    this.genAI = null;
    this.model = null;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  async init() {
    if (!config.gemini.apiKey) {
      throw new Error("GEMINI_API_KEY is not set in .env");
    }
    this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    console.log("✅ Gemini AI Tagger initialized");
    return this;
  }

  /**
   * Tag an artwork using its Google Drive file ID — NO download needed.
   * Fetches a small preview (800px) from lh3 and sends to Gemini.
   *
   * @param {string} driveFileId - Google Drive file ID
   * @param {string} filename - original filename (for context)
   * @returns structured metadata object
   */
  async tagByDriveId(driveFileId, filename = "") {
    // Fetch a small preview from Google Drive's lh3 CDN
    const imageUrl = `https://lh3.googleusercontent.com/d/${driveFileId}=s800`;

    try {
      const res = await fetch(imageUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch image preview: ${res.status}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "image/jpeg";

      return await this._analyzeImage(buffer, contentType, filename);
    } catch (err) {
      // If lh3 fails, return filename-based fallback
      console.error(`⚠️  AI tag-by-URL failed for ${filename}: ${err.message}`);
      return this._fallbackResult(filename, err.message);
    }
  }

  /**
   * Tag a single artwork from a local file (original method).
   * @param {string} imagePath - local file path
   * @param {string} filename - original filename (for context)
   * @returns structured metadata object
   */
  async tagImage(imagePath, filename = "") {
    const imageData = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".png": "image/png", ".webp": "image/webp",
      ".gif": "image/gif", ".bmp": "image/bmp",
      ".tiff": "image/tiff", ".tif": "image/tiff",
    };
    const mimeType = mimeMap[ext] || "image/jpeg";

    return await this._analyzeImage(imageData, mimeType, filename);
  }

  /**
   * Core analysis: send image buffer to Gemini and parse response.
   */
  async _analyzeImage(imageBuffer, mimeType, filename = "") {
    const base64 = imageBuffer.toString("base64");
    const prompt = `${TAG_PROMPT}\n\nFilename for context: "${filename}"`;

    this.requestCount++;

    try {
      const result = await this.model.generateContent([
        prompt,
        { inlineData: { data: base64, mimeType } },
      ]);

      const responseText = result.response.text().trim();
      const cleaned = responseText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const metadata = JSON.parse(cleaned);

      return {
        title: metadata.title || "Untitled",
        description: metadata.description || "",
        style: metadata.style || "other",
        era: metadata.era || "unknown",
        palette: metadata.palette || "neutral",
        mood: metadata.mood || "calm",
        subject: metadata.subject || "other",
        tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      };
    } catch (err) {
      this.errorCount++;
      console.error(`⚠️  AI tagging failed for ${filename}:`, err.message);

      // Handle Gemini rate limits — wait and retry once
      if (err.message.includes("429") || err.message.includes("RATE_LIMIT")) {
        console.log("   ⏳ Gemini rate limited — waiting 30s and retrying...");
        await new Promise((r) => setTimeout(r, 30000));
        try {
          const result = await this.model.generateContent([
            `${TAG_PROMPT}\n\nFilename for context: "${filename}"`,
            { inlineData: { data: base64, mimeType } },
          ]);
          const responseText = result.response.text().trim();
          const cleaned = responseText
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();
          const metadata = JSON.parse(cleaned);
          return {
            title: metadata.title || "Untitled",
            description: metadata.description || "",
            style: metadata.style || "other",
            era: metadata.era || "unknown",
            palette: metadata.palette || "neutral",
            mood: metadata.mood || "calm",
            subject: metadata.subject || "other",
            tags: Array.isArray(metadata.tags) ? metadata.tags : [],
          };
        } catch (retryErr) {
          return this._fallbackResult(filename, retryErr.message);
        }
      }

      return this._fallbackResult(filename, err.message);
    }
  }

  /**
   * Fallback: generate basic metadata from filename when AI fails.
   */
  _fallbackResult(filename, errorMsg) {
    return {
      title: this._titleFromFilename(filename),
      description: "",
      style: "other",
      era: "unknown",
      palette: "neutral",
      mood: "calm",
      subject: "other",
      tags: [],
      _error: errorMsg,
    };
  }

  /**
   * Generate a title from the filename.
   */
  _titleFromFilename(filename) {
    if (!filename) return "Untitled";
    return path
      .basename(filename, path.extname(filename))
      .replace(/[-_]+/g, " ")
      .replace(/\d+x\d+$/, "")  // strip dimension suffix like "10057x12926"
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || "Untitled";
  }

  /**
   * Get tagger stats for monitoring.
   */
  getStats() {
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      successRate: this.requestCount > 0
        ? (((this.requestCount - this.errorCount) / this.requestCount) * 100).toFixed(1) + "%"
        : "n/a",
    };
  }
}

module.exports = AiTagger;
