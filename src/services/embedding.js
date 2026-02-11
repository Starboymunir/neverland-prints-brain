/**
 * Embedding Service — Vector Search for "Similar Artworks"
 * ========================================================
 * Uses Gemini's text embedding model to create vector embeddings
 * from artwork metadata (title, tags, style, mood, etc.).
 *
 * Stored in Supabase with pgvector for fast similarity search.
 *
 * Why text embeddings (not image)?
 *   - Image embeddings need full image download → expensive for 90k files
 *   - Text embeddings from metadata are fast, cheap, and surprisingly good
 *   - "abstract warm calm landscape" → similar to "impressionist warm serene nature"
 *   - Later: can add image embeddings as a premium feature
 *
 * Flow:
 *   1. Asset metadata → text string → Gemini embedding → 768d vector
 *   2. Store in Supabase `asset_embeddings` table (pgvector)
 *   3. Query: find K nearest neighbors by cosine similarity
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config");
const supabase = require("../db/supabase");

class EmbeddingService {
  constructor() {
    this.genAI = null;
    this.model = null;
    this.dimension = 768; // Gemini text-embedding-004 output size
  }

  async init() {
    if (!config.gemini.apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "text-embedding-004" });
    console.log("✅ Embedding Service initialized");
    return this;
  }

  /**
   * Build a rich text description from asset metadata for embedding.
   * The quality of this text directly affects search quality.
   */
  _buildEmbeddingText(asset) {
    const parts = [];

    if (asset.title && asset.title !== "Untitled") parts.push(asset.title);
    if (asset.artist) parts.push(`by ${asset.artist}`);
    if (asset.style) parts.push(asset.style);
    if (asset.era) parts.push(asset.era);
    if (asset.mood) parts.push(asset.mood);
    if (asset.palette) parts.push(`${asset.palette} palette`);
    if (asset.subject) parts.push(asset.subject);
    if (asset.ratio_class) parts.push(asset.ratio_class.replace(/_/g, " "));
    if (asset.description) parts.push(asset.description);
    if (Array.isArray(asset.ai_tags) && asset.ai_tags.length > 0) {
      parts.push(asset.ai_tags.join(", "));
    }

    return parts.join(". ").slice(0, 1000); // Gemini has token limits
  }

  /**
   * Generate embedding for a single text.
   * @returns {number[]} 768-dimensional vector
   */
  async embed(text) {
    const result = await this.model.embedContent(text);
    return result.embedding.values;
  }

  /**
   * Generate embeddings for multiple texts in batch.
   * Gemini supports batch embedding for efficiency.
   * @param {string[]} texts
   * @returns {number[][]} array of vectors
   */
  async embedBatch(texts) {
    const result = await this.model.batchEmbedContents({
      requests: texts.map((content) => ({
        content: { parts: [{ text: content }] },
      })),
    });
    return result.embeddings.map((e) => e.values);
  }

  /**
   * Generate and store embedding for a single asset.
   */
  async embedAsset(asset) {
    const text = this._buildEmbeddingText(asset);
    if (!text || text.length < 5) return null;

    const vector = await this.embed(text);

    const { error } = await supabase.from("asset_embeddings").upsert(
      {
        asset_id: asset.id,
        embedding: JSON.stringify(vector),
        embedding_text: text,
      },
      { onConflict: "asset_id" }
    );

    if (error) throw error;
    return vector;
  }

  /**
   * Batch embed multiple assets efficiently.
   * Processes in chunks of 100 (Gemini batch limit).
   */
  async embedAssets(assets, { onProgress } = {}) {
    const chunkSize = 100;
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < assets.length; i += chunkSize) {
      const chunk = assets.slice(i, i + chunkSize);
      const texts = chunk.map((a) => this._buildEmbeddingText(a));

      try {
        const vectors = await this.embedBatch(texts);

        // Upsert all embeddings in batch
        const rows = chunk.map((asset, idx) => ({
          asset_id: asset.id,
          embedding: JSON.stringify(vectors[idx]),
          embedding_text: texts[idx],
        }));

        const { error } = await supabase
          .from("asset_embeddings")
          .upsert(rows, { onConflict: "asset_id" });

        if (error) {
          console.error(`Batch upsert error: ${error.message}`);
          errors += chunk.length;
        } else {
          processed += chunk.length;
        }
      } catch (err) {
        console.error(`Embedding batch error: ${err.message}`);
        errors += chunk.length;

        // Handle rate limits
        if (err.message.includes("429")) {
          console.log("⏳ Gemini rate limited — waiting 60s...");
          await new Promise((r) => setTimeout(r, 60000));
          i -= chunkSize; // retry this chunk
          continue;
        }
      }

      if (onProgress) onProgress(processed, errors, assets.length);
      await new Promise((r) => setTimeout(r, 200)); // gentle rate limiting
    }

    return { processed, errors };
  }

  /**
   * Find similar assets using vector similarity search.
   * Requires pgvector extension + the match_assets RPC function.
   *
   * @param {string} assetId - source asset UUID
   * @param {number} limit - max results
   * @returns {object[]} similar assets with similarity scores
   */
  async findSimilar(assetId, limit = 8) {
    // Get the source embedding
    const { data: source } = await supabase
      .from("asset_embeddings")
      .select("embedding")
      .eq("asset_id", assetId)
      .single();

    if (!source) {
      // Fallback: tag-based similarity (no embeddings needed)
      return this._fallbackSimilar(assetId, limit);
    }

    // Use Supabase RPC for vector similarity
    const { data, error } = await supabase.rpc("match_assets", {
      query_embedding: source.embedding,
      match_threshold: 0.5,
      match_count: limit + 1, // +1 because source will match itself
    });

    if (error) {
      console.error("Vector search error:", error.message);
      return this._fallbackSimilar(assetId, limit);
    }

    // Filter out source and return
    return (data || [])
      .filter((r) => r.asset_id !== assetId)
      .slice(0, limit);
  }

  /**
   * Find similar by text query (e.g., "warm abstract landscape").
   * Useful for search-by-description features.
   */
  async searchByText(queryText, limit = 12) {
    const queryVector = await this.embed(queryText);

    const { data, error } = await supabase.rpc("match_assets", {
      query_embedding: JSON.stringify(queryVector),
      match_threshold: 0.3,
      match_count: limit,
    });

    if (error) {
      console.error("Text search error:", error.message);
      return [];
    }

    return data || [];
  }

  /**
   * Fallback similarity: match by shared tags/metadata.
   * Works even without embeddings.
   */
  async _fallbackSimilar(assetId, limit) {
    const { data: asset } = await supabase
      .from("assets")
      .select("style, mood, palette, subject, artist, ratio_class")
      .eq("id", assetId)
      .single();

    if (!asset) return [];

    // Find by same style + mood
    const { data: similar } = await supabase
      .from("assets")
      .select("id, shopify_product_id, title, drive_file_id, artist, style, mood")
      .neq("id", assetId)
      .eq("shopify_status", "synced")
      .eq("style", asset.style || "other")
      .limit(limit * 2);

    // Score and sort
    const scored = (similar || []).map((s) => {
      let score = 0;
      if (s.mood === asset.mood) score += 2;
      if (s.artist !== asset.artist) score += 1; // diversity
      return { ...s, similarity: 0.5 + score * 0.1 };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }
}

module.exports = EmbeddingService;
