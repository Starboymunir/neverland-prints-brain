const https = require('https');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Fetching PopMotif homepage...');
  const html = await fetchPage('https://popmotif.com/');
  console.log('Got', html.length, 'bytes\n');

  // Navigation structure
  const navMatches = html.matchAll(/href="([^"]*?)"[^>]*?>([\s\S]*?)<\/a>/g);
  const navLinks = [];
  const seen = new Set();
  for (const m of navMatches) {
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const href = m[1];
    if (text && text.length > 1 && text.length < 60 && !href.includes('cdn.shopify') && !seen.has(text)) {
      seen.add(text);
      navLinks.push({ text, href });
    }
  }
  console.log('=== NAVIGATION & LINKS ===');
  navLinks.slice(0, 50).forEach(l => console.log(`  ${l.text} -> ${l.href}`));

  // Headings
  const headingMatches = html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g);
  console.log('\n=== HEADINGS ===');
  for (const m of headingMatches) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) console.log(`  ${text}`);
  }

  // Section IDs and classes
  const sectionMatches = html.matchAll(/<section[^>]*(?:class="([^"]*)")?[^>]*(?:id="([^"]*)")?/g);
  console.log('\n=== SECTIONS ===');
  for (const m of sectionMatches) {
    console.log(`  class="${m[1] || ''}" id="${m[2] || ''}"`);
  }

  // Shopify section types (from data attributes)
  const shopifySections = html.matchAll(/data-section-type="([^"]*)"/g);
  console.log('\n=== SHOPIFY SECTION TYPES ===');
  for (const m of shopifySections) {
    console.log(`  ${m[1]}`);
  }

  // Look for class patterns
  const classPatterns = html.matchAll(/class="([^"]*(?:hero|banner|collection|featured|grid|slider|artist|category|trust|gallery|marquee|testimonial|newsletter)[^"]*)"/gi);
  console.log('\n=== KEY CLASS PATTERNS ===');
  const seenClasses = new Set();
  for (const m of classPatterns) {
    if (!seenClasses.has(m[1])) {
      seenClasses.add(m[1]);
      console.log(`  ${m[1]}`);
    }
  }

  // Color scheme - look for background colors
  const bgColors = html.matchAll(/background(?:-color)?:\s*(#[0-9a-fA-F]{3,8}|rgb[^)]+\))/g);
  console.log('\n=== BACKGROUND COLORS ===');
  const seenColors = new Set();
  for (const m of bgColors) {
    if (!seenColors.has(m[1])) {
      seenColors.add(m[1]);
      console.log(`  ${m[1]}`);
    }
  }

  // Body text (page content overview)
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  console.log('\n=== PAGE CONTENT (first 3000 chars) ===');
  console.log(bodyText.substring(0, 3000));

  // Also fetch collections page
  console.log('\n\n========================================');
  console.log('Fetching PopMotif /collections...');
  try {
    const colHtml = await fetchPage('https://popmotif.com/collections');
    const colHeadings = colHtml.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g);
    console.log('\n=== COLLECTIONS PAGE HEADINGS ===');
    for (const m of colHeadings) {
      const text = m[1].replace(/<[^>]+>/g, '').trim();
      if (text) console.log(`  ${text}`);
    }
    
    // Collection links
    const colLinks = colHtml.matchAll(/href="\/collections\/([^"]+)"/g);
    console.log('\n=== COLLECTION HANDLES ===');
    const seenCol = new Set();
    for (const m of colLinks) {
      if (!seenCol.has(m[1])) {
        seenCol.add(m[1]);
        console.log(`  ${m[1]}`);
      }
    }
  } catch(e) {
    console.log('Error:', e.message);
  }

  // Fetch pages/artists or similar
  console.log('\n\n========================================');
  console.log('Fetching PopMotif /pages/artists...');
  try {
    const artistHtml = await fetchPage('https://popmotif.com/pages/artists');
    const artistBody = artistHtml
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(artistBody.substring(0, 1500));
  } catch(e) {
    console.log('Error:', e.message);
  }
})();
