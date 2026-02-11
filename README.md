# Neverland Prints — "Brain" Layer

The automated pipeline + ranking engine behind Neverland Prints Shopify store.

## What This Does

1. **Ingests** artwork images from Google Drive
2. **Analyzes** each image (dimensions, aspect ratio, resolution)
3. **Tags** each artwork with AI (style, era, palette, subject)
4. **Maps** each artwork to valid print size variants based on its aspect ratio
5. **Syncs** products → Shopify with correct variants + metafields
6. **Generates** print-ready specs for fulfillment providers (Printful, Gelato)
7. **Dashboard** to monitor the whole pipeline

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in your credentials
cp .env.example .env

# 3. Initialize the database tables (Supabase)
npm run db:init

# 4. Run the dev server (dashboard + API)
npm run dev

# 5. Test with 100 assets
npm run ingest:test
```

## Architecture

```
Google Drive (1.5TB raw images)
        │
        ▼
┌──────────────────┐
│  Ingestion Layer  │  ← downloads, deduplicates, extracts metadata
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Resolution Engine │  ← calculates print sizes, ratio-to-variant mapping
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   AI Tagger       │  ← Gemini Flash: style, era, palette, subject
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Supabase (DB)    │  ← canonical asset records + metadata
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Shopify Sync     │  ← products, variants, metafields via Admin API
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Print Spec Gen   │  ← provider-agnostic print job specs
└──────────────────┘
```

## Environment Variables

See `.env.example` for the full list.

## Milestone 1 Deliverables

- [x] Process 100 test assets through Resolution Engine
- [x] Verification Dashboard
- [x] Ratio-to-variant mapping
- [x] Smart AI tagging
