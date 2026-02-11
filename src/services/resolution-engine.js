/**
 * Resolution Engine
 * -----------------
 * Core logic for:
 *   1. Calculating print dimensions from pixel dimensions
 *   2. Classifying aspect ratios
 *   3. Generating valid print size variants per artwork
 *
 * Key formula:  1 cm = 35.43 px  (client-specified)
 *               So: print_cm = pixel_count / 35.43
 */
const config = require("../config");

const PX_PER_CM = config.resolution.pxPerCm; // 35.43
const PX_PER_INCH = PX_PER_CM * 2.54; // ≈ 90 px/inch
const MIN_PRINT_DPI = config.resolution.minPrintDpi; // 150

/**
 * Standard print sizes (cm) — we'll match artworks to valid subsets.
 * Each group is for a specific ratio class.
 */
const PRINT_SIZE_CATALOG = {
  // Square sizes (ratio ~1:1)
  square: [
    { label: "Small",      width: 20,  height: 20  },
    { label: "Medium",     width: 30,  height: 30  },
    { label: "Large",      width: 50,  height: 50  },
    { label: "X-Large",    width: 70,  height: 70  },
  ],
  // Portrait sizes (height > width, ratio 0.5–0.95)
  portrait_2_3: [
    { label: "Small",      width: 20,  height: 30  },
    { label: "Medium",     width: 30,  height: 45  },
    { label: "Large",      width: 40,  height: 60  },
    { label: "X-Large",    width: 60,  height: 90  },
  ],
  portrait_3_4: [
    { label: "Small",      width: 21,  height: 28  },
    { label: "Medium",     width: 30,  height: 40  },
    { label: "Large",      width: 45,  height: 60  },
    { label: "X-Large",    width: 60,  height: 80  },
  ],
  portrait_4_5: [
    { label: "Small",      width: 20,  height: 25  },
    { label: "Medium",     width: 32,  height: 40  },
    { label: "Large",      width: 48,  height: 60  },
    { label: "X-Large",    width: 64,  height: 80  },
  ],
  // Landscape sizes (width > height, ratio 1.05–2.0)
  landscape_3_2: [
    { label: "Small",      width: 30,  height: 20  },
    { label: "Medium",     width: 45,  height: 30  },
    { label: "Large",      width: 60,  height: 40  },
    { label: "X-Large",    width: 90,  height: 60  },
  ],
  landscape_4_3: [
    { label: "Small",      width: 28,  height: 21  },
    { label: "Medium",     width: 40,  height: 30  },
    { label: "Large",      width: 60,  height: 45  },
    { label: "X-Large",    width: 80,  height: 60  },
  ],
  landscape_16_9: [
    { label: "Small",      width: 32,  height: 18  },
    { label: "Medium",     width: 48,  height: 27  },
    { label: "Large",      width: 80,  height: 45  },
    { label: "X-Large",    width: 112, height: 63  },
  ],
  // Panoramic (very wide or very tall, ratio > 2.0 or < 0.5)
  panoramic_wide: [
    { label: "Small",      width: 40,  height: 15  },
    { label: "Medium",     width: 60,  height: 22  },
    { label: "Large",      width: 90,  height: 33  },
    { label: "X-Large",    width: 120, height: 44  },
  ],
  panoramic_tall: [
    { label: "Small",      width: 15,  height: 40  },
    { label: "Medium",     width: 22,  height: 60  },
    { label: "Large",      width: 33,  height: 90  },
    { label: "X-Large",    width: 44,  height: 120 },
  ],
};

/**
 * Classify an aspect ratio into a named ratio class.
 */
function classifyRatio(widthPx, heightPx) {
  const ratio = widthPx / heightPx;

  if (ratio >= 0.95 && ratio <= 1.05) return "square";
  if (ratio > 1.05 && ratio <= 1.4)   return "landscape_4_3";
  if (ratio > 1.4 && ratio <= 1.65)   return "landscape_3_2";
  if (ratio > 1.65 && ratio <= 2.0)   return "landscape_16_9";
  if (ratio > 2.0)                     return "panoramic_wide";
  if (ratio >= 0.7 && ratio < 0.95)    return "portrait_4_5";
  if (ratio >= 0.6 && ratio < 0.7)     return "portrait_3_4";
  if (ratio >= 0.5 && ratio < 0.6)     return "portrait_2_3";
  if (ratio < 0.5)                     return "panoramic_tall";

  return "landscape_4_3"; // fallback
}

/**
 * Calculate max print dimensions at the native resolution.
 */
function calcMaxPrintSize(widthPx, heightPx) {
  return {
    widthCm: +(widthPx / PX_PER_CM).toFixed(2),
    heightCm: +(heightPx / PX_PER_CM).toFixed(2),
    widthInches: +(widthPx / PX_PER_INCH).toFixed(2),
    heightInches: +(heightPx / PX_PER_INCH).toFixed(2),
  };
}

/**
 * Calculate effective DPI for a given print size.
 */
function calcEffectiveDpi(widthPx, heightPx, printWidthCm, printHeightCm) {
  const dpiW = widthPx / (printWidthCm / 2.54);
  const dpiH = heightPx / (printHeightCm / 2.54);
  return +Math.min(dpiW, dpiH).toFixed(2);
}

/**
 * Grade print quality based on DPI.
 */
function gradeQuality(dpi) {
  if (dpi >= 300) return "excellent";
  if (dpi >= 200) return "good";
  if (dpi >= 150) return "acceptable";
  return "low";
}

/**
 * For a given artwork, compute all valid print variants.
 * Returns an array of variant objects.
 */
function computeVariants(widthPx, heightPx) {
  const ratioClass = classifyRatio(widthPx, heightPx);
  const ratio = +(widthPx / heightPx).toFixed(4);
  const maxPrint = calcMaxPrintSize(widthPx, heightPx);

  // Get the matching size catalog
  let catalog = PRINT_SIZE_CATALOG[ratioClass];
  if (!catalog) catalog = PRINT_SIZE_CATALOG.landscape_4_3; // fallback

  // For each catalog size, check if this artwork can produce it at acceptable DPI
  const variants = [];

  for (const size of catalog) {
    // Scale the catalog size to match the artwork's exact ratio
    // We keep the WIDTH from the catalog and adjust HEIGHT to preserve ratio
    let printW = size.width;
    let printH = +(size.width / ratio).toFixed(2);

    // Or if portrait, keep HEIGHT and adjust WIDTH
    if (ratio < 1) {
      printH = size.height;
      printW = +(size.height * ratio).toFixed(2);
    }

    const dpi = calcEffectiveDpi(widthPx, heightPx, printW, printH);
    const quality = gradeQuality(dpi);

    // Only include if quality is at least acceptable
    if (dpi >= MIN_PRINT_DPI) {
      variants.push({
        label: size.label,
        width_cm: printW,
        height_cm: printH,
        width_inches: +(printW / 2.54).toFixed(2),
        height_inches: +(printH / 2.54).toFixed(2),
        effective_dpi: dpi,
        quality_grade: quality,
      });
    }
  }

  // If no variants meet the DPI threshold, include the smallest as a "custom" size
  if (variants.length === 0) {
    const customW = Math.min(maxPrint.widthCm, 30);
    const customH = +(customW / ratio).toFixed(2);
    const dpi = calcEffectiveDpi(widthPx, heightPx, customW, customH);
    variants.push({
      label: "Custom",
      width_cm: customW,
      height_cm: customH,
      width_inches: +(customW / 2.54).toFixed(2),
      height_inches: +(customH / 2.54).toFixed(2),
      effective_dpi: dpi,
      quality_grade: gradeQuality(dpi),
    });
  }

  return {
    ratio,
    ratioClass,
    maxPrint,
    variants,
  };
}

/**
 * Full analysis of a single artwork image.
 */
function analyzeArtwork(widthPx, heightPx) {
  const { ratio, ratioClass, maxPrint, variants } = computeVariants(widthPx, heightPx);

  return {
    dimensions: { widthPx, heightPx },
    aspectRatio: ratio,
    ratioClass,
    maxPrint,
    variants,
    summary: {
      totalVariants: variants.length,
      bestQuality: variants[0]?.quality_grade || "n/a",
      largestPrint: variants[variants.length - 1]
        ? `${variants[variants.length - 1].width_cm} × ${variants[variants.length - 1].height_cm} cm`
        : "n/a",
    },
  };
}

module.exports = {
  classifyRatio,
  calcMaxPrintSize,
  calcEffectiveDpi,
  gradeQuality,
  computeVariants,
  analyzeArtwork,
  PRINT_SIZE_CATALOG,
  PX_PER_CM,
  PX_PER_INCH,
};
