/**
 * Print Spec Generator
 * --------------------
 * Generates provider-agnostic print specifications for fulfillment.
 * Designed so switching between Printful, Gelato, etc. is just
 * swapping an adapter — the core spec stays the same.
 */
const { PX_PER_CM } = require("./resolution-engine");

/**
 * Default print profiles.
 */
const DEFAULT_PROFILES = {
  matte_paper: {
    name: "Premium Matte Paper",
    material_type: "paper_matte",
    bleed_mm: 3,
    min_dpi: 150,
    max_long_edge_cm: 120,
    file_format: "PNG",
    color_profile: "sRGB",
  },
  glossy_paper: {
    name: "Glossy Photo Paper",
    material_type: "paper_glossy",
    bleed_mm: 3,
    min_dpi: 200,
    max_long_edge_cm: 100,
    file_format: "PNG",
    color_profile: "sRGB",
  },
  canvas_wrap: {
    name: "Canvas Wrap",
    material_type: "canvas",
    bleed_mm: 40, // wrap edge
    min_dpi: 150,
    max_long_edge_cm: 150,
    file_format: "PNG",
    color_profile: "sRGB",
  },
  metal_print: {
    name: "Metal Print",
    material_type: "metal",
    bleed_mm: 0,
    min_dpi: 200,
    max_long_edge_cm: 90,
    file_format: "PNG",
    color_profile: "sRGB",
  },
};

/**
 * Generate a print spec for a specific order.
 *
 * @param {object} asset - asset record (with dimensions, file location)
 * @param {object} variant - the chosen size variant
 * @param {string} profileKey - which material profile to use
 * @returns {object} print job spec
 */
function generatePrintSpec(asset, variant, profileKey = "matte_paper") {
  const profile = DEFAULT_PROFILES[profileKey] || DEFAULT_PROFILES.matte_paper;

  // Calculate bleed dimensions
  const bleedCm = profile.bleed_mm / 10;
  const totalWidthCm = variant.width_cm + bleedCm * 2;
  const totalHeightCm = variant.height_cm + bleedCm * 2;

  // Required pixels for the production file
  const requiredWidthPx = Math.ceil(totalWidthCm * PX_PER_CM);
  const requiredHeightPx = Math.ceil(totalHeightCm * PX_PER_CM);

  // Check if the source image is large enough
  const canProduce = asset.width_px >= requiredWidthPx && asset.height_px >= requiredHeightPx;

  return {
    // Job identification
    asset_id: asset.id,
    order_variant: `${variant.width_cm}×${variant.height_cm}cm`,

    // Cut dimensions (what the customer receives)
    cut: {
      width_cm: variant.width_cm,
      height_cm: variant.height_cm,
      width_inches: variant.width_inches,
      height_inches: variant.height_inches,
    },

    // Production dimensions (including bleed)
    production: {
      width_cm: +totalWidthCm.toFixed(2),
      height_cm: +totalHeightCm.toFixed(2),
      width_px: requiredWidthPx,
      height_px: requiredHeightPx,
    },

    // Material / profile
    material: {
      name: profile.name,
      type: profile.material_type,
      bleed_mm: profile.bleed_mm,
      file_format: profile.file_format,
      color_profile: profile.color_profile,
    },

    // Quality check
    quality: {
      effective_dpi: variant.effective_dpi,
      quality_grade: variant.quality_grade,
      source_sufficient: canProduce,
    },

    // Source file info
    source: {
      drive_file_id: asset.drive_file_id,
      filename: asset.filename,
      width_px: asset.width_px,
      height_px: asset.height_px,
    },
  };
}

module.exports = {
  generatePrintSpec,
  DEFAULT_PROFILES,
};
