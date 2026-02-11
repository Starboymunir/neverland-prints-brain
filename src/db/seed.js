/**
 * Seed Script
 * -----------
 * Insert default print profiles into the DB.
 *
 * Usage: npm run db:seed
 */
const supabase = require("./supabase");
const { DEFAULT_PROFILES } = require("../services/print-spec");

async function seed() {
  console.log("🌱 Seeding database...\n");

  // Insert print profiles
  const profiles = Object.entries(DEFAULT_PROFILES).map(([key, profile]) => ({
    name: profile.name,
    provider: "generic",
    material_type: profile.material_type,
    bleed_mm: profile.bleed_mm,
    min_dpi: profile.min_dpi,
    max_long_edge_cm: profile.max_long_edge_cm || null,
    file_format: profile.file_format,
    color_profile: profile.color_profile,
  }));

  const { data, error } = await supabase
    .from("print_profiles")
    .upsert(profiles, { onConflict: "name" })
    .select();

  if (error) {
    console.error("❌ Error seeding print profiles:", error.message);
  } else {
    console.log(`✅ Inserted ${data.length} print profiles`);
  }

  console.log("\n🌱 Seed complete!");
}

seed().catch(console.error);
