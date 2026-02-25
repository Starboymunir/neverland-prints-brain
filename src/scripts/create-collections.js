/**
 * Neverland Prints — Smart Collection Generator v2
 * ==================================================
 * Creates Shopify smart collections from enriched AI metadata.
 * Collections are tag-based so products auto-join when tagged.
 *
 * Creates collections for:
 *   - Art Styles (Impressionism, Abstract, etc.)
 *   - Subjects (Landscape, Portrait, Still Life, etc.)
 *   - Moods (Romantic, Serene, Dramatic, etc.)
 *   - Eras (Renaissance, 19th Century, etc.)
 *   - Room/Use (Living Room, Bedroom, Office, etc.)
 *   - Format (Portrait, Landscape, Square, Panoramic)
 *   - Quality (Museum Grade, Gallery Grade)
 *
 * Usage:
 *   node src/scripts/create-collections.js              # create from tags
 *   node src/scripts/create-collections.js --dry-run    # preview only
 *   node src/scripts/create-collections.js --delete-first  # delete+recreate
 */

require("dotenv").config();

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;
const DELETE_FIRST = process.argv.includes("--delete-first");
const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopifyREST(method, endpoint, body = null, retries = 3) {
  const url = `${BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (res.status === 429) {
    const wait = parseFloat(res.headers.get("Retry-After") || "2");
    console.log(`   ⏳ Rate limited — waiting ${wait}s`);
    await sleep(wait * 1000);
    return shopifyREST(method, endpoint, body, retries);
  }

  if ((res.status === 502 || res.status === 503) && retries > 0) {
    await sleep(3000);
    return shopifyREST(method, endpoint, body, retries - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${method} ${endpoint} → ${res.status}: ${text}`);
  }

  const ct = res.headers.get("Content-Type") || "";
  return ct.includes("json") ? res.json() : null;
}

// ── All collections to create ────────────────────────────
const COLLECTIONS = [
  // ─── Original format/quality collections ───────────────
  {
    title: "All Art Prints",
    body_html: "<p>Browse our complete collection of over 131,000 museum-quality art prints, spanning centuries of artistic mastery.</p>",
    rules: [{ column: "type", relation: "equals", condition: "Art Print" }],
    sort_order: "best-selling",
  },
  {
    title: "New Arrivals",
    body_html: "<p>The latest additions to our collection — freshly digitised masterworks ready for your walls.</p>",
    rules: [{ column: "type", relation: "equals", condition: "Art Print" }],
    sort_order: "created-desc",
  },
  {
    title: "Museum Grade",
    body_html: "<p>Our highest resolution artworks — exceeding 300 DPI at maximum print size. The pinnacle of print quality.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "museum grade" }],
    sort_order: "best-selling",
  },
  {
    title: "Gallery Grade",
    body_html: "<p>Beautiful prints at gallery-standard quality. Outstanding value without compromising on materials.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "gallery grade" }],
    sort_order: "best-selling",
  },
  {
    title: "Portrait Format Prints",
    body_html: "<p>Vertical compositions perfect for narrow walls, hallways, and intimate spaces.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "portrait_2_3" },
      { column: "tag", relation: "equals", condition: "portrait_3_4" },
      { column: "tag", relation: "equals", condition: "portrait_4_5" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Landscape Format Prints",
    body_html: "<p>Wide-format masterpieces ideal for living rooms and offices.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "landscape_3_2" },
      { column: "tag", relation: "equals", condition: "landscape_4_3" },
      { column: "tag", relation: "equals", condition: "landscape_16_9" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Square Prints",
    body_html: "<p>Perfectly balanced square-format artworks. Versatile for any room.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "square" }],
    sort_order: "best-selling",
  },
  {
    title: "Panoramic Prints",
    body_html: "<p>Ultra-wide or ultra-tall prints for dramatic visual impact.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "panoramic_wide" },
      { column: "tag", relation: "equals", condition: "panoramic_tall" },
    ],
    sort_order: "best-selling",
  },

  // ─── Art Style collections ─────────────────────────────
  {
    title: "Impressionist Art",
    body_html: "<p>Light, color, and movement — from Monet to Renoir to Cézanne. The most beloved art movement, now on your walls.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Impressionism" },
      { column: "tag", relation: "equals", condition: "Post-Impressionism" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Abstract Art",
    body_html: "<p>Pure color, form, and emotion beyond literal representation. Bold statement pieces for modern interiors.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Abstract" }],
    sort_order: "best-selling",
  },
  {
    title: "Renaissance Art",
    body_html: "<p>Classical beauty and mastery from the Renaissance masters — Botticelli, Leonardo, Raphael, and more.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Renaissance" }],
    sort_order: "best-selling",
  },
  {
    title: "Baroque Art",
    body_html: "<p>Drama, grandeur, and emotional intensity — Caravaggio, Rembrandt, Vermeer, and the masters of light.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Baroque" }],
    sort_order: "best-selling",
  },
  {
    title: "Romantic Art",
    body_html: "<p>Emotion, nature, and the sublime. The passion and beauty of the Romantic movement.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Romanticism" }],
    sort_order: "best-selling",
  },
  {
    title: "Realist Art",
    body_html: "<p>True-to-life depictions of the world — honest, detailed, and deeply human.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Realism" },
      { column: "tag", relation: "equals", condition: "Naturalism" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Art Nouveau & Art Deco",
    body_html: "<p>Elegant curves and bold geometry of decorative art movements. Mucha, Klimt, and the golden age of design.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Art Nouveau" },
      { column: "tag", relation: "equals", condition: "Art Deco" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Expressionist Art",
    body_html: "<p>Raw emotion through bold colors and distorted forms. Munch, Kirchner, Kandinsky, and more.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Expressionism" },
      { column: "tag", relation: "equals", condition: "Fauvism" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Surrealist Art",
    body_html: "<p>Dreams, the unconscious, and fantastical imagery — the art of the impossible.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Surrealism" }],
    sort_order: "best-selling",
  },
  {
    title: "Japanese Art (Ukiyo-e)",
    body_html: "<p>Iconic woodblock prints from Japan's floating world — Hokusai, Hiroshige, and the masters of ukiyo-e.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Ukiyo-e" }],
    sort_order: "best-selling",
  },
  {
    title: "Minimalist Art",
    body_html: "<p>Less is more — clean lines, pure compositions, and serene simplicity.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Minimalism" }],
    sort_order: "best-selling",
  },
  {
    title: "Symbolist Art",
    body_html: "<p>Hidden meanings, mystical imagery, and spiritual symbolism in art.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Symbolism" }],
    sort_order: "best-selling",
  },
  {
    title: "Neoclassical Art",
    body_html: "<p>Classical ideals revived with elegance and restraint. David, Ingres, and the beauty of reason.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Neoclassicism" }],
    sort_order: "best-selling",
  },
  {
    title: "Pre-Raphaelite Art",
    body_html: "<p>Vivid detail, jewel-like color, and medieval romance from the Pre-Raphaelite Brotherhood.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Pre-Raphaelite" }],
    sort_order: "best-selling",
  },
  {
    title: "Cubist Art",
    body_html: "<p>Multiple perspectives in fragmented geometric forms — Picasso, Braque, and more.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Cubism" }],
    sort_order: "best-selling",
  },
  {
    title: "Folk & Naive Art",
    body_html: "<p>Charming, authentic art from cultural traditions around the world.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Folk Art" },
      { column: "tag", relation: "equals", condition: "Naive Art" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Drawings & Sketches",
    body_html: "<p>Works on paper — pencil, ink, charcoal, and printmaking. The raw art of the hand.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Drawing" },
      { column: "tag", relation: "equals", condition: "Sketch" },
      { column: "tag", relation: "equals", condition: "Engraving" },
      { column: "tag", relation: "equals", condition: "Lithograph" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Watercolor Paintings",
    body_html: "<p>The luminous transparency of watercolor on paper — airy, light, and beautiful.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Watercolor" }],
    sort_order: "best-selling",
  },
  {
    title: "Vintage Photography",
    body_html: "<p>Captured moments from history — from daguerreotypes to artistic photography.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Photography" }],
    sort_order: "best-selling",
  },

  // ─── Subject collections ───────────────────────────────
  {
    title: "Landscape Paintings",
    body_html: "<p>Rolling hills, distant horizons, and the beauty of the natural world. Perfect for bringing the outdoors in.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Landscape" }],
    sort_order: "best-selling",
  },
  {
    title: "Portrait Art",
    body_html: "<p>The human face captured through centuries of artistic tradition. From royals to everyday people.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Portrait" },
      { column: "tag", relation: "equals", condition: "Self-Portrait" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Still Life Art",
    body_html: "<p>Flowers, fruit, and objects arranged with timeless beauty. Classic elegance for any room.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Still Life" }],
    sort_order: "best-selling",
  },
  {
    title: "Seascapes & Maritime Art",
    body_html: "<p>Ocean waves, coastal scenes, and maritime adventures. Bring the sea home.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Seascape" },
      { column: "tag", relation: "equals", condition: "Maritime" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Cityscapes & Architecture",
    body_html: "<p>Urban skylines, grand buildings, and architectural wonders from around the world.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Cityscape" },
      { column: "tag", relation: "equals", condition: "Architecture" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Botanical Art",
    body_html: "<p>Flowers, plants, and botanical illustrations in exquisite detail. Nature's beauty for your walls.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Botanical" },
      { column: "tag", relation: "equals", condition: "Garden" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Animal Art",
    body_html: "<p>Wildlife, pets, and creatures of every kind — beautifully captured in art.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Animal" }],
    sort_order: "best-selling",
  },
  {
    title: "Religious Art",
    body_html: "<p>Sacred scenes and spiritual devotion across cultures and centuries.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Religious" }],
    sort_order: "best-selling",
  },
  {
    title: "Mythology & Allegory",
    body_html: "<p>Gods, heroes, and symbolic narratives from world mythology.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Mythology" },
      { column: "tag", relation: "equals", condition: "Allegory" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Figure Studies & Nudes",
    body_html: "<p>The human form celebrated through centuries of artistic tradition and academic study.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Figure Study" },
      { column: "tag", relation: "equals", condition: "Nude" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Night Scenes",
    body_html: "<p>Moonlit mysteries, starry skies, and the quiet beauty of darkness.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Night Scene" }],
    sort_order: "best-selling",
  },
  {
    title: "Winter Scenes",
    body_html: "<p>Snowy landscapes and the peaceful beauty of winter.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Winter Scene" }],
    sort_order: "best-selling",
  },
  {
    title: "Rural & Country Life",
    body_html: "<p>Charming scenes of countryside and everyday life.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Rural Life" },
      { column: "tag", relation: "equals", condition: "Genre Scene" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Fantasy Art",
    body_html: "<p>Imaginary worlds, mythical creatures, and dreamlike visions.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Fantasy" }],
    sort_order: "best-selling",
  },

  // ─── Mood collections ─────────────────────────────────
  {
    title: "Serene & Peaceful Art",
    body_html: "<p>Calm, tranquil artworks perfect for creating a relaxing atmosphere. Ideal for bedrooms and meditation spaces.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Serene" },
      { column: "tag", relation: "equals", condition: "Peaceful" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Dramatic Art",
    body_html: "<p>Bold, intense, and emotionally charged artworks that command attention.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Dramatic" },
      { column: "tag", relation: "equals", condition: "Powerful" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Romantic Art Collection",
    body_html: "<p>Love, passion, and tender moments — art that speaks to the heart.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Romantic" }],
    sort_order: "best-selling",
  },
  {
    title: "Dark & Moody Art",
    body_html: "<p>Atmospheric works with depth and emotional intensity. Rich shadows and contemplative beauty.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Dark" },
      { column: "tag", relation: "equals", condition: "Melancholic" },
      { column: "tag", relation: "equals", condition: "Somber" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Joyful & Vibrant Art",
    body_html: "<p>Bright, energetic art that uplifts any space. Color, life, and happiness.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Joyful" },
      { column: "tag", relation: "equals", condition: "Vibrant" },
      { column: "tag", relation: "equals", condition: "Playful" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Ethereal & Spiritual Art",
    body_html: "<p>Otherworldly beauty and spiritual depth. Art that transcends the material.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Ethereal" },
      { column: "tag", relation: "equals", condition: "Spiritual" },
      { column: "tag", relation: "equals", condition: "Mysterious" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Nostalgic Art",
    body_html: "<p>Art that evokes memories of times past. Warm sentiment and wistful beauty.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Nostalgic" }],
    sort_order: "best-selling",
  },
  {
    title: "Elegant Art",
    body_html: "<p>Refined, sophisticated art for distinguished spaces.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "Elegant" }],
    sort_order: "best-selling",
  },

  // ─── Era collections ──────────────────────────────────
  {
    title: "Old Masters (pre-1800)",
    body_html: "<p>Masterworks from antiquity through the 18th century. The foundations of Western art.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "15th Century" },
      { column: "tag", relation: "equals", condition: "16th Century" },
      { column: "tag", relation: "equals", condition: "17th Century" },
      { column: "tag", relation: "equals", condition: "18th Century" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "19th Century Art",
    body_html: "<p>From Romanticism to Impressionism — the golden age of painting.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Early 19th Century" },
      { column: "tag", relation: "equals", condition: "Late 19th Century" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Modern Art (1900-1960)",
    body_html: "<p>Revolutionary art that shattered conventions and defined the modern era.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "Early 20th Century" },
      { column: "tag", relation: "equals", condition: "Mid 20th Century" },
    ],
    sort_order: "best-selling",
  },

  // ─── Room/Gift collections (from ai_tags) ─────────────
  {
    title: "Living Room Wall Art",
    body_html: "<p>Statement pieces perfect for your living room — the heart of your home.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "living room wall art" }],
    sort_order: "best-selling",
  },
  {
    title: "Bedroom Art",
    body_html: "<p>Calming, romantic, and personal art for the bedroom.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "bedroom wall art" }],
    sort_order: "best-selling",
  },
  {
    title: "Office Wall Art",
    body_html: "<p>Professional and inspiring art that elevates workspaces.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "office wall art" }],
    sort_order: "best-selling",
  },
  {
    title: "Gifts for Art Lovers",
    body_html: "<p>Perfect gifts for art enthusiasts and home decorators. Timeless pieces they'll treasure.</p>",
    rules: [{ column: "tag", relation: "equals", condition: "gift for art lover" }],
    sort_order: "best-selling",
  },
];

async function deleteExistingCollections() {
  console.log("\n🗑️  Deleting existing smart collections...");
  const all = [];
  let url = "/smart_collections.json?limit=250";
  while (url) {
    const res = await fetch(`${BASE}${url}`, {
      headers: { "X-Shopify-Access-Token": TOKEN },
    });
    const data = await res.json();
    all.push(...(data.smart_collections || []));
    const link = res.headers.get("link");
    if (link && link.includes('rel="next"')) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        const nextUrl = new URL(match[1]);
        url = nextUrl.pathname.replace(`/admin/api/${API_VER}`, "") + nextUrl.search;
      } else url = null;
    } else url = null;
    await sleep(400);
  }

  for (const col of all) {
    try {
      await shopifyREST("DELETE", `/smart_collections/${col.id}.json`);
      console.log(`   Deleted: ${col.title} (${col.id})`);
      await sleep(300);
    } catch (e) {
      console.log(`   ⚠️ Failed to delete ${col.title}: ${e.message.slice(0, 60)}`);
    }
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  NEVERLAND PRINTS — Smart Collection Generator v2");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Store: ${SHOP}`);
  console.log(`  Collections: ${COLLECTIONS.length}`);
  console.log(`  Delete first: ${DELETE_FIRST}`);
  console.log(`  Dry run: ${DRY_RUN}`);
  console.log("═══════════════════════════════════════════════════\n");

  if (DRY_RUN) {
    for (const col of COLLECTIONS) {
      const tags = col.rules.map(r => r.condition).join(" | ");
      console.log(`   📦 "${col.title}" → [${tags}]`);
    }
    console.log(`\n  ✅ DRY RUN — ${COLLECTIONS.length} collections would be created.\n`);
    return;
  }

  if (DELETE_FIRST) {
    await deleteExistingCollections();
  }

  let created = 0;
  let errors = 0;
  let skipped = 0;

  for (const col of COLLECTIONS) {
    try {
      const result = await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: col.title,
          body_html: col.body_html,
          rules: col.rules,
          sort_order: col.sort_order || "best-selling",
          disjunctive: col.disjunctive || false,
          published: true,
        },
      });

      if (result.smart_collection) {
        console.log(`   ✅ "${col.title}" — ID: ${result.smart_collection.id}`);
        created++;
      } else {
        console.log(`   ⚠️ "${col.title}": ${JSON.stringify(result.errors || result)}`);
        errors++;
      }
    } catch (e) {
      if (e.message.includes("422") && e.message.includes("has already been taken")) {
        console.log(`   ⏭️  "${col.title}" already exists`);
        skipped++;
      } else {
        console.log(`   ❌ "${col.title}": ${e.message.slice(0, 100)}`);
        errors++;
      }
    }
    await sleep(500);
  }

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  ✅ Created: ${created} | ⏭️ Skipped: ${skipped} | ❌ Errors: ${errors}`);
  console.log(`═══════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err);
  process.exit(1);
});
