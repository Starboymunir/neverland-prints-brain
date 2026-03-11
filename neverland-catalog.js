/* ═══════════════════════════════════════════════════════════════════════
   NEVERLAND PRINTS — Catalog Engine
   API-driven catalog browsing, product detail, and cart integration.
   Part of the Skeleton Product Architecture.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────────
  const WATERMARK_URL = (document.querySelector('link[href*="neverland.css"]')?.href || '').replace('neverland.css', 'watermark-1.png') || 'https://cdn.shopify.com/s/files/1/0675/4300/7316/t/3/assets/watermark-1.png';
  const WATERMARK_HTML = `<img src="${WATERMARK_URL}" alt="" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:22%;max-width:80px;opacity:0.04;pointer-events:none;user-select:none;z-index:2;" aria-hidden="true">`;
  const PRICE_TIERS = {
    small:       { unframed: '29.99', framed: '39.99', label: 'Small' },
    medium:      { unframed: '49.99', framed: '64.99', label: 'Medium' },
    large:       { unframed: '79.99', framed: '99.99', label: 'Large' },
    extra_large: { unframed: '119.99', framed: '149.99', label: 'Extra Large' },
  };

  let priceMap = null;     // skeleton variant IDs, loaded from API
  let currentAsset = null; // current art detail page asset
  let currentFrame = 'unframed';
  let currentFrameColor = 'none'; // selected frame color: none, black, white, natural, walnut
  let currentVariantSize = null; // selected size variant
  let searchDebounce = null;

  // ─── HELPERS ──────────────────────────────────────────

  function getApiBase() {
    const el = document.querySelector('[data-api-base]');
    return el ? el.dataset.apiBase : 'https://neverland-prints-brain.onrender.com';
  }

  async function apiFetch(endpoint) {
    const base = getApiBase();
    const url = `${base}${endpoint}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
    return res.json();
  }

  function formatPrice(price) {
    const num = parseFloat(price);
    return '$' + num.toFixed(2);
  }

  function formatOrientation(orientation) {
    if (!orientation) return '';
    // e.g. portrait_4_5 → Portrait 4:5, landscape_3_2 → Landscape 3:2
    const parts = orientation.split('_');
    const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    if (parts.length >= 3) return name + ' ' + parts[1] + ':' + parts[2];
    return name;
  }

  function formatMaxPrint(maxPrint) {
    if (!maxPrint) return '';
    // e.g. "94.47 × 112.6 cm" → "94 × 113 cm"
    return maxPrint.replace(/(\d+\.\d+)/g, (m) => Math.round(parseFloat(m)).toString());
  }

  function getUrlParam(key) {
    return new URLSearchParams(window.location.search).get(key);
  }

  function setUrlParams(params) {
    const url = new URL(window.location);
    for (const [key, val] of Object.entries(params)) {
      if (val) url.searchParams.set(key, val);
      else url.searchParams.delete(key);
    }
    window.history.replaceState({}, '', url);
  }

  // ─── PRICE MAP LOADING ────────────────────────────────

  async function loadPriceMap() {
    if (priceMap) return priceMap;
    try {
      priceMap = await apiFetch('/api/storefront/price-map');
    } catch (e) {
      console.warn('Price map not available:', e.message);
      priceMap = {};
    }
    return priceMap;
  }

  function getVariantId(tier, framed) {
    const key = `${tier}_${framed ? 'framed' : 'unframed'}`;
    // Prefer per-asset priceMap (returned by asset detail API), fall back to global
    const assetMap = currentAsset?.priceMap;
    if (assetMap?.[key]?.variantId) return assetMap[key].variantId;
    return priceMap?.[key]?.variantId || null;
  }

  function getPrice(tier, framed) {
    const tierData = PRICE_TIERS[tier];
    if (!tierData) return '29.99';
    return framed ? tierData.framed : tierData.unframed;
  }

  // ─── COUNTRY FLAG MAPPING ─────────────────────────────
  const COUNTRY_FLAGS = {
    'Netherlands': '🇳🇱', 'France': '🇫🇷', 'United States': '🇺🇸', 'United Kingdom': '🇬🇧',
    'Italy': '🇮🇹', 'Germany': '🇩🇪', 'Belgium': '🇧🇪', 'Russia': '🇷🇺',
    'Spain': '🇪🇸', 'Austria': '🇦🇹', 'Japan': '🇯🇵', 'Denmark': '🇩🇰',
    'Norway': '🇳🇴', 'Sweden': '🇸🇪', 'Switzerland': '🇨🇭', 'Czech Republic': '🇨🇿',
    'Poland': '🇵🇱', 'Greece': '🇬🇷', 'Ireland': '🇮🇪', 'Portugal': '🇵🇹',
    'China': '🇨🇳', 'India': '🇮🇳', 'Mexico': '🇲🇽', 'Canada': '🇨🇦',
    'Australia': '🇦🇺', 'Brazil': '🇧🇷', 'Argentina': '🇦🇷', 'Turkey': '🇹🇷',
    'Hungary': '🇭🇺', 'Finland': '🇫🇮', 'Romania': '🇷🇴', 'Ukraine': '🇺🇦',
  };
  const CONTINENT_ICONS = {
    'Europe': '🏛️', 'Asia': '🏯', 'North America': '🗽',
    'South America': '🌿', 'Africa': '🌍', 'Oceania': '🌊',
  };

  function getFlag(country) { return COUNTRY_FLAGS[country] || '🎨'; }

  // ─── PRODUCT CARD RENDERING ───────────────────────────

  function renderCatalogCard(item) {
    const price = getPrice(item.priceTier, false);
    const comparePrice = getPrice(item.priceTier, true);
    const artUrl = `/pages/art?id=${item.id}`;
    const flag = item.country ? getFlag(item.country) : '';

    // Build meta line: flag + country · era
    let metaHtml = '';
    if (item.country || item.era) {
      const parts = [];
      if (item.country) parts.push(`<span class="catalog-card__meta-flag">${flag}</span> ${escHtml(item.country)}`);
      if (item.era && item.era !== 'Unknown') parts.push(escHtml(item.era));
      metaHtml = `<p class="catalog-card__meta">${parts.join('<span class="catalog-card__meta-sep">·</span>')}</p>`;
    }

    return `
      <div class="catalog-card" data-animate="fade-up">
        <a href="${artUrl}" class="catalog-card__link">
          <div class="catalog-card__img-wrap">
            <img
              class="catalog-card__img"
              src="${item.imageSrcset?.s600 || item.image}"
              srcset="${item.imageSrcset?.s400 || item.image} 400w,
                      ${item.imageSrcset?.s600 || item.image} 600w,
                      ${item.imageSrcset?.s800 || item.image} 800w"
              sizes="(max-width: 576px) 90vw, (max-width: 768px) 45vw, (max-width: 1024px) 30vw, 23vw"
              alt="${escHtml(item.title)}"
              loading="lazy"
              decoding="async"
              onerror="this.style.display='none'"
            >
            ${item.quality === 'museum' ? '<span class="catalog-card__quality">Museum Grade</span>' : ''}
            ${WATERMARK_HTML}
            <div class="catalog-card__overlay"><span>Quick View</span></div>
          </div>
          <div class="catalog-card__info">
            <h3 class="catalog-card__title">${escHtml(item.title)}</h3>
            <p class="catalog-card__artist">${escHtml(item.artist || 'Unknown Artist')}</p>
            ${metaHtml}
            <div class="catalog-card__price">
              <span class="catalog-card__price-current">From ${formatPrice(price)}</span>
              <span class="catalog-card__price-compare">${formatPrice(comparePrice)}</span>
            </div>
          </div>
        </a>
      </div>
    `;
  }

  function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── CATALOG BROWSE PAGE ──────────────────────────────

  // Cached filter data for map + active filters
  let cachedFilters = null;

  async function initCatalogBrowse() {
    const grid = document.getElementById('catalog-grid');
    if (!grid) return;

    // Load the SVG world map asset then filters
    await loadWorldMap();
    loadFilters();

    // Filter toggle panel
    const filterToggle = document.getElementById('filter-toggle');
    const filterPanel = document.getElementById('filter-panel');
    if (filterToggle && filterPanel) {
      filterToggle.addEventListener('click', () => {
        filterToggle.classList.toggle('is-open');
        filterPanel.classList.toggle('is-open');
      });
    }

    // Map collapse toggle
    const mapToggle = document.getElementById('map-collapse-toggle');
    const mapBody = document.getElementById('map-body');
    const mapSection = document.getElementById('catalog-map');
    if (mapToggle && mapBody && mapSection) {
      mapToggle.addEventListener('click', () => {
        const isOpen = mapSection.classList.toggle('is-open');
        mapBody.style.display = isOpen ? '' : 'none';
      });
    }

    // Read initial params from URL
    const initialPage = parseInt(getUrlParam('page') || '1', 10);
    const initialArtist = getUrlParam('artist');
    const initialStyle = getUrlParam('style');
    const initialMood = getUrlParam('mood');
    const initialOrientation = getUrlParam('orientation');
    const initialEra = getUrlParam('era');
    const initialSubject = getUrlParam('subject');
    const initialCountry = getUrlParam('country');
    const initialContinent = getUrlParam('continent');
    const initialSort = getUrlParam('sort') || 'newest';
    const initialQ = getUrlParam('q');

    // Set filter values from URL
    setFilterValue('artist', initialArtist);
    setFilterValue('style', initialStyle);
    setFilterValue('mood', initialMood);
    setFilterValue('orientation', initialOrientation);
    setFilterValue('era', initialEra);
    setFilterValue('subject', initialSubject);
    setFilterValue('country', initialCountry);
    setFilterValue('sort', initialSort);
    if (initialQ) {
      const searchInput = document.getElementById('catalog-search');
      if (searchInput) searchInput.value = initialQ;
    }

    // If continent is set from URL, activate it on the map
    if (initialContinent) {
      activateMapContinent(initialContinent);
    }

    // Auto-open filter panel if any dropdown filter is active
    if (initialArtist || initialStyle || initialMood || initialOrientation || initialEra || initialSubject || initialCountry) {
      if (filterToggle && filterPanel) {
        filterToggle.classList.add('is-open');
        filterPanel.classList.add('is-open');
      }
    }

    // Fetch and render
    await fetchCatalog(initialPage);

    // Listen for filter changes
    document.querySelectorAll('.catalog-filter').forEach(select => {
      select.addEventListener('change', () => {
        fetchCatalog(1);
        updateActiveFilters();
        updateFilterBadge();
      });
    });

    // Search input
    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearBtn.style.display = searchInput.value ? 'flex' : 'none';
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          fetchCatalog(1);
          updateActiveFilters();
        }, 400);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        fetchCatalog(1);
        updateActiveFilters();
      });
    }

    // Reset filters button
    const resetBtn = document.getElementById('catalog-reset-filters');
    if (resetBtn) {
      resetBtn.addEventListener('click', clearAllFilters);
    }

    // Clear all button in active filters bar
    const clearAllBtn = document.getElementById('catalog-clear-all');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', clearAllFilters);
    }

    // Map back button
    const mapBack = document.getElementById('map-back');
    if (mapBack) {
      mapBack.addEventListener('click', () => {
        deactivateMapContinent();
        fetchCatalog(1);
        updateActiveFilters();
      });
    }

    // Initial active filters display
    updateActiveFilters();
    updateFilterBadge();
  }

  function clearAllFilters() {
    document.querySelectorAll('.catalog-filter').forEach(s => {
      if (s.dataset.filter !== 'sort') s.selectedIndex = 0;
    });
    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    deactivateMapContinent();
    // Clear any active country pills
    document.querySelectorAll('.country-pill.is-active').forEach(p => p.classList.remove('is-active'));
    fetchCatalog(1);
    updateActiveFilters();
    updateFilterBadge();
  }

  function activateMapContinent(continent) {
    // Show country pills for this continent
    const svgWrap = document.getElementById('map-svg-wrap');
    const countriesDiv = document.getElementById('map-countries');
    const regionTitle = document.getElementById('map-region-title');
    const legend = document.getElementById('map-legend-label');
    if (svgWrap) svgWrap.style.display = 'none';
    if (countriesDiv) countriesDiv.style.display = '';
    if (regionTitle) regionTitle.textContent = continent;
    if (legend) legend.textContent = continent;

    // Highlight the active SVG continent
    document.querySelectorAll('.map-continent').forEach(r => {
      r.classList.toggle('is-active', r.dataset.continent === continent);
    });

    // Render country pills for this continent
    renderCountryPills(continent);
  }

  function deactivateMapContinent() {
    const svgWrap = document.getElementById('map-svg-wrap');
    const countriesDiv = document.getElementById('map-countries');
    if (svgWrap) svgWrap.style.display = '';
    if (countriesDiv) countriesDiv.style.display = 'none';
    document.querySelectorAll('.map-continent.is-active').forEach(r => r.classList.remove('is-active'));
    // Clear continent filter
    setUrlParams({ continent: null, country: null });
    setFilterValue('country', '');
  }

  function renderCountryPills(continent) {
    const container = document.getElementById('map-country-pills');
    if (!container || !cachedFilters) return;

    // Map continent to its countries
    const CONTINENT_COUNTRIES = {};
    // We need the nationality data — use cachedFilters.countries + our mapping
    // For now, we know which countries belong where from the artist-nationalities.json
    const COUNTRY_CONTINENT_MAP = {
      'Netherlands': 'Europe', 'France': 'Europe', 'United Kingdom': 'Europe',
      'Italy': 'Europe', 'Germany': 'Europe', 'Belgium': 'Europe', 'Russia': 'Europe',
      'Spain': 'Europe', 'Austria': 'Europe', 'Denmark': 'Europe',
      'Norway': 'Europe', 'Sweden': 'Europe', 'Switzerland': 'Europe',
      'Czech Republic': 'Europe', 'Poland': 'Europe', 'Greece': 'Europe',
      'Ireland': 'Europe', 'Portugal': 'Europe', 'Hungary': 'Europe',
      'Finland': 'Europe', 'Romania': 'Europe', 'Ukraine': 'Europe',
      'Turkey': 'Europe',
      'United States': 'North America', 'Canada': 'North America', 'Mexico': 'North America',
      'Japan': 'Asia', 'China': 'Asia', 'India': 'Asia',
      'Brazil': 'South America', 'Argentina': 'South America',
      'Australia': 'Oceania',
    };

    const countries = (cachedFilters.countries || []).filter(c => {
      return COUNTRY_CONTINENT_MAP[c.value] === continent;
    });

    if (countries.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No specific countries catalogued yet for this region.</p>';
      return;
    }

    // "All in continent" pill
    const currentCountry = getFilterValues().country;
    container.innerHTML = `
      <button type="button" class="country-pill${!currentCountry ? ' is-active' : ''}" data-continent="${continent}" data-country="">
        <span class="country-pill__flag">${CONTINENT_ICONS[continent] || '🌍'}</span>
        All ${continent}
      </button>
    ` + countries.map(c => {
      const isActive = currentCountry === c.value ? ' is-active' : '';
      return `<button type="button" class="country-pill${isActive}" data-country="${escHtml(c.value)}">
        <span class="country-pill__flag">${getFlag(c.value)}</span>
        ${escHtml(c.value)}
        <span class="country-pill__count">${c.count.toLocaleString()}</span>
      </button>`;
    }).join('');

    // Country pill click handlers
    container.querySelectorAll('.country-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        container.querySelectorAll('.country-pill').forEach(p => p.classList.remove('is-active'));
        pill.classList.add('is-active');

        const country = pill.dataset.country;
        const cont = pill.dataset.continent || continent;

        if (country) {
          // Filter by specific country
          setFilterValue('country', country);
          setUrlParams({ country, continent: null });
        } else {
          // Filter by whole continent
          setFilterValue('country', '');
          setUrlParams({ country: null, continent: cont });
        }
        fetchCatalog(1);
        updateActiveFilters();
        updateFilterBadge();
      });
    });
  }

  function updateActiveFilters() {
    const container = document.getElementById('active-filters');
    const chipsDiv = document.getElementById('active-filter-chips');
    if (!container || !chipsDiv) return;

    const filters = getFilterValues();
    const chips = [];

    const filterLabels = {
      artist: 'Artist', style: 'Style', mood: 'Mood',
      orientation: 'Orientation', era: 'Era', subject: 'Subject',
      country: 'Country', continent: 'Region', q: 'Search',
    };

    for (const [key, val] of Object.entries(filters)) {
      if (key === 'sort' || !val) continue;
      const label = filterLabels[key] || key;
      const flag = key === 'country' ? getFlag(val) + ' ' : '';
      const icon = key === 'continent' ? (CONTINENT_ICONS[val] || '🌍') + ' ' : '';
      chips.push(`
        <span class="filter-chip">
          ${flag}${icon}${escHtml(label)}: ${escHtml(val)}
          <button type="button" class="filter-chip__remove" data-remove-filter="${key}" aria-label="Remove ${label} filter">×</button>
        </span>
      `);
    }

    if (chips.length > 0) {
      container.style.display = '';
      chipsDiv.innerHTML = chips.join('');

      // Chip remove handlers
      chipsDiv.querySelectorAll('.filter-chip__remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.removeFilter;
          if (key === 'q') {
            const searchInput = document.getElementById('catalog-search');
            const clearBtn = document.getElementById('catalog-search-clear');
            if (searchInput) searchInput.value = '';
            if (clearBtn) clearBtn.style.display = 'none';
          } else if (key === 'continent') {
            deactivateMapContinent();
          } else if (key === 'country') {
            setFilterValue('country', '');
            setUrlParams({ country: null });
            document.querySelectorAll('.country-pill.is-active').forEach(p => p.classList.remove('is-active'));
          } else {
            setFilterValue(key, '');
          }
          fetchCatalog(1);
          updateActiveFilters();
          updateFilterBadge();
        });
      });
    } else {
      container.style.display = 'none';
    }
  }

  function updateFilterBadge() {
    const badge = document.getElementById('filter-count');
    if (!badge) return;
    const filters = getFilterValues();
    let count = 0;
    for (const [key, val] of Object.entries(filters)) {
      if (key !== 'sort' && val) count++;
    }
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function setFilterValue(name, value) {
    const el = document.querySelector(`[data-filter="${name}"]`);
    if (el && value) {
      // Try to find the matching option
      for (const opt of el.options) {
        if (opt.value === value) {
          el.value = value;
          break;
        }
      }
    }
  }

  function getFilterValues() {
    const filters = {};
    document.querySelectorAll('.catalog-filter').forEach(select => {
      const key = select.dataset.filter;
      const val = select.value;
      if (val) filters[key] = val;
    });
    const searchInput = document.getElementById('catalog-search');
    if (searchInput && searchInput.value.trim()) {
      filters.q = searchInput.value.trim();
    }
    // Check for continent filter (set via map, stored in URL)
    const continentParam = getUrlParam('continent');
    if (continentParam && !filters.continent) {
      filters.continent = continentParam;
    }
    return filters;
  }

  async function fetchCatalog(page = 1) {
    const grid = document.getElementById('catalog-grid');
    const loading = document.getElementById('catalog-loading');
    const empty = document.getElementById('catalog-empty');
    const pagination = document.getElementById('catalog-pagination');
    const countEl = document.getElementById('catalog-count');
    const showingEl = document.getElementById('catalog-showing');
    const perPage = parseInt(document.querySelector('[data-per-page]')?.dataset.perPage || '24', 10);

    loading.style.display = 'flex';
    empty.style.display = 'none';
    grid.innerHTML = '';

    const filters = getFilterValues();
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: perPage.toString(),
      ...filters,
    });

    // Update URL
    setUrlParams({ page: page > 1 ? page : null, ...filters });

    try {
      const data = await apiFetch(`/api/storefront/catalog?${params}`);

      loading.style.display = 'none';

      if (data.items.length === 0) {
        empty.style.display = 'block';
        pagination.innerHTML = '';
        countEl.textContent = '0 prints';
        showingEl.textContent = '';
        return;
      }

      // Update count
      countEl.textContent = `${data.total.toLocaleString()} prints`;
      const from = (page - 1) * perPage + 1;
      const to = Math.min(page * perPage, data.total);
      showingEl.innerHTML = `Showing <strong>${from}–${to}</strong> of ${data.total.toLocaleString()}`;

      // Render cards
      grid.innerHTML = data.items.map(renderCatalogCard).join('');

      // Render pagination
      renderPagination(pagination, page, data.totalPages, fetchCatalog);

      // Re-init scroll animations
      initScrollAnimations(grid);

      // Track impressions
      trackEvent('impression', { page, count: data.items.length });

      // Scroll to top of grid on page change (if not first load)
      if (page > 1) {
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (err) {
      loading.style.display = 'none';
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h2>Error loading catalog</h2><p>${escHtml(err.message)}</p></div>`;
    }
  }

  // ── Load SVG world map from theme asset ─────────────────────────
  async function loadWorldMap() {
    const wrap = document.getElementById('map-svg-wrap');
    if (!wrap) return;
    const url = wrap.dataset.mapUrl;
    if (!url) return;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const svgText = await res.text();
      wrap.innerHTML = svgText;
    } catch (e) {
      console.warn('Could not load world map SVG:', e);
      wrap.innerHTML = '<p style="text-align:center;padding:40px;color:var(--text-muted)">Map unavailable</p>';
    }
  }

  async function loadFilters() {
    try {
      const [data, artistData] = await Promise.all([
        apiFetch('/api/storefront/filters'),
        apiFetch('/api/storefront/artists?limit=100')
      ]);

      // Cache filter data for map
      cachedFilters = data;

      // Populate artist select
      const artistSelect = document.getElementById('filter-artist');
      if (artistSelect && artistData.artists) {
        artistData.artists.slice(0, 100).forEach(a => {
          const opt = document.createElement('option');
          opt.value = a.name || a.artist;
          opt.textContent = `${a.name || a.artist} (${a.count})`;
          artistSelect.appendChild(opt);
        });
      }

      // Populate style select
      const styleSelect = document.getElementById('filter-style');
      if (styleSelect && data.styles) {
        data.styles.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.value;
          opt.textContent = `${s.value} (${s.count})`;
          styleSelect.appendChild(opt);
        });
      }

      // Populate era select
      const eraSelect = document.getElementById('filter-era');
      if (eraSelect && data.eras) {
        data.eras.filter(e => e.value && e.value !== 'Unknown').forEach(e => {
          const opt = document.createElement('option');
          opt.value = e.value;
          opt.textContent = `${e.value} (${e.count.toLocaleString()})`;
          eraSelect.appendChild(opt);
        });
      }

      // Populate subject select
      const subjectSelect = document.getElementById('filter-subject');
      if (subjectSelect && data.subjects) {
        data.subjects.slice(0, 30).forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.value;
          opt.textContent = `${s.value} (${s.count.toLocaleString()})`;
          subjectSelect.appendChild(opt);
        });
      }

      // Populate country select
      const countrySelect = document.getElementById('filter-country');
      if (countrySelect && data.countries) {
        data.countries.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.value;
          opt.textContent = `${getFlag(c.value)} ${c.value} (${c.count.toLocaleString()})`;
          countrySelect.appendChild(opt);
        });
      }

      // Populate mood select
      const moodSelect = document.getElementById('filter-mood');
      if (moodSelect && data.moods) {
        data.moods.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = `${m.value} (${m.count})`;
          moodSelect.appendChild(opt);
        });
      }

      // Populate orientation select dynamically
      const orientSelect = document.getElementById('filter-orientation');
      if (orientSelect && data.orientations) {
        data.orientations.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.value;
          const label = o.value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          opt.textContent = `${label} (${o.count})`;
          orientSelect.appendChild(opt);
        });
      }

      // ── Populate SVG World Map with continent counts & click handlers ──
      const worldMap = document.getElementById('world-map');
      if (worldMap && data.continents) {
        // Map data-continent values to count label IDs (strip spaces for IDs)
        const countMap = {};
        data.continents.forEach(c => {
          countMap[c.value] = c.count;
        });

        // Set count labels on the SVG
        const idMap = { 'Europe': 'Europe', 'Asia': 'Asia', 'North America': 'NorthAmerica', 'South America': 'SouthAmerica', 'Africa': 'Africa', 'Oceania': 'Oceania' };
        Object.entries(idMap).forEach(([name, id]) => {
          const el = document.getElementById('map-count-' + id);
          if (el) {
            const count = countMap[name] || 0;
            el.textContent = count > 0 ? count.toLocaleString() + ' artworks' : '';
          }
        });

        // SVG continent click handlers
        worldMap.querySelectorAll('.map-continent').forEach(region => {
          region.addEventListener('click', () => {
            const continent = region.dataset.continent;
            activateMapContinent(continent);
            setUrlParams({ continent, country: null });
            setFilterValue('country', '');
            fetchCatalog(1);
            updateActiveFilters();
            updateFilterBadge();
          });
          // Keyboard support
          region.setAttribute('tabindex', '0');
          region.setAttribute('role', 'button');
          region.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); region.click(); }
          });
        });
      }

      // Re-apply URL filter values after options are loaded
      const artist = getUrlParam('artist');
      const style = getUrlParam('style');
      const mood = getUrlParam('mood');
      const era = getUrlParam('era');
      const subject = getUrlParam('subject');
      const country = getUrlParam('country');
      if (artist) setFilterValue('artist', artist);
      if (style) setFilterValue('style', style);
      if (mood) setFilterValue('mood', mood);
      if (era) setFilterValue('era', era);
      if (subject) setFilterValue('subject', subject);
      if (country) setFilterValue('country', country);
    } catch (e) {
      console.warn('Failed to load filters:', e.message);
    }
  }

  function renderPagination(container, currentPage, totalPages, onPageClick) {
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';

    // Previous
    if (currentPage > 1) {
      html += `<a href="#" data-page="${currentPage - 1}" aria-label="Previous page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </a>`;
    }

    // Page numbers
    const range = [];
    const delta = 2;
    for (let i = Math.max(1, currentPage - delta); i <= Math.min(totalPages, currentPage + delta); i++) {
      range.push(i);
    }
    if (range[0] > 1) { range.unshift(1); if (range[1] > 2) range.splice(1, 0, '...'); }
    if (range[range.length - 1] < totalPages) {
      if (range[range.length - 1] < totalPages - 1) range.push('...');
      range.push(totalPages);
    }

    for (const p of range) {
      if (p === '...') {
        html += '<span class="pagination-ellipsis">…</span>';
      } else if (p === currentPage) {
        html += `<span class="is-current">${p}</span>`;
      } else {
        html += `<a href="#" data-page="${p}">${p}</a>`;
      }
    }

    // Next
    if (currentPage < totalPages) {
      html += `<a href="#" data-page="${currentPage + 1}" aria-label="Next page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
      </a>`;
    }

    container.innerHTML = html;

    // Click handlers
    container.querySelectorAll('[data-page]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        onPageClick(parseInt(link.dataset.page, 10));
      });
    });
  }

  // ─── ART DETAIL PAGE ─────────────────────────────────

  async function initArtDetail() {
    const page = document.getElementById('art-detail');
    if (!page) return;

    const assetId = getUrlParam('id');
    if (!assetId) {
      showArtNotFound();
      return;
    }

    await loadPriceMap();

    try {
      const asset = await apiFetch(`/api/storefront/asset/${assetId}`);
      currentAsset = asset;
      renderArtDetail(asset);
      loadSimilarArtworks(assetId);
      trackEvent('view', { asset_id: assetId, title: asset.title });
    } catch (err) {
      showArtNotFound();
    }
  }

  function renderArtDetail(asset) {
    const loading = document.getElementById('art-loading');
    const content = document.getElementById('art-content');

    // Image
    const img = document.getElementById('art-image');
    img.src = asset.images.s1200;
    img.srcset = `${asset.images.s800} 800w, ${asset.images.s1200} 1200w, ${asset.images.s1600} 1600w, ${asset.images.s2000} 2000w`;
    img.alt = asset.title;

    // Frame preview swatches
    ['none','black','white','natural','walnut'].forEach(f => {
      const sw = document.getElementById('art-swatch-' + f);
      if (sw) sw.src = asset.images.s400 || asset.images.s800;
    });

    // Lifestyle section images
    const lsImg1 = document.getElementById('art-lifestyle-img');
    const lsImg2 = document.getElementById('art-lifestyle-img2');
    if (lsImg1) lsImg1.src = asset.images.s800 || asset.images.s1200;
    if (lsImg2) lsImg2.src = asset.images.s800 || asset.images.s1200;
    const lifestyleWrap = document.getElementById('art-lifestyle');
    if (lifestyleWrap) lifestyleWrap.style.display = '';

    // Breadcrumb
    const bcTitle = document.getElementById('art-breadcrumb-title');
    if (bcTitle) bcTitle.textContent = asset.title ? asset.title.replace(/\s+\d{4}$/, '') : '';

    // Title & Artist — strip trailing year if present (e.g. "Richard Mentor Johnson 1843" → "Richard Mentor Johnson")
    const cleanTitle = asset.title ? asset.title.replace(/\s+\d{4}$/, '') : '';
    document.getElementById('art-title').textContent = cleanTitle;
    document.getElementById('art-artist').textContent = asset.artist || 'Unknown Artist';

    // Update page title
    document.title = `${asset.title} by ${asset.artist || 'Unknown'} — ${document.title.split('—').pop().trim()}`;

    // Description
    const descEl = document.getElementById('art-description');
    descEl.innerHTML = asset.description || `<p>A beautiful ${asset.style || 'art'} print${asset.mood ? ' with a ' + asset.mood + ' mood' : ''}. ${asset.subject ? 'Featuring: ' + asset.subject + '.' : ''}</p>`;

    // Size options — build from asset.variants if available, otherwise from priceMap tiers
    {
      let sizeList = [];

      if (asset.variants && asset.variants.length > 0) {
        // API returned explicit variant sizes
        sizeList = asset.variants.map(v => ({
          tier: v.priceTier,
          label: PRICE_TIERS[v.priceTier]?.label || v.label || v.size,
          size: v.size || '',
        }));
      } else if (asset.priceMap) {
        // Derive sizes from priceMap keys (deduplicate unframed/framed pairs)
        const seen = new Set();
        for (const key of Object.keys(asset.priceMap)) {
          const tier = key.replace(/_(?:un)?framed$/, '');
          if (!seen.has(tier) && PRICE_TIERS[tier]) {
            seen.add(tier);
            sizeList.push({
              tier,
              label: PRICE_TIERS[tier].label,
              size: PRICE_TIERS[tier].label,
            });
          }
        }
        // Sort by price ascending
        const tierOrder = ['small', 'medium', 'large', 'extra_large'];
        sizeList.sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));
      }

      // Fallback: if still empty, build from PRICE_TIERS based on asset's tier
      if (sizeList.length === 0) {
        const tierOrder = ['small', 'medium', 'large', 'extra_large'];
        const assetTier = asset.priceTier || 'small';
        const maxIdx = tierOrder.indexOf(assetTier);
        for (let i = 0; i <= Math.max(0, maxIdx); i++) {
          const t = tierOrder[i];
          sizeList.push({ tier: t, label: PRICE_TIERS[t].label, size: PRICE_TIERS[t].label });
        }
      }

      if (sizeList.length > 0) {
        const section = document.getElementById('art-variants-section');
        const options = document.getElementById('art-variant-options');
        const sizeDisplay = document.getElementById('art-size-display');
        if (section && options) {
          section.style.display = '';

          // Default to the asset's own priceTier, or first available
          const defaultTier = asset.priceTier || sizeList[0].tier;
          const defaultIdx = Math.max(0, sizeList.findIndex(s => s.tier === defaultTier));

          options.innerHTML = sizeList.map((s, i) => {
            const isSelected = i === defaultIdx ? ' is-selected' : '';
            const price = getPrice(s.tier, false);
            return `<button type="button" class="variant-option${isSelected}"
                      data-variant-idx="${i}" data-tier="${s.tier}"
                      data-size="${s.size}">
                      ${escHtml(s.label)} — ${formatPrice(price)}
                    </button>`;
          }).join('');

          currentVariantSize = { priceTier: sizeList[defaultIdx].tier, size: sizeList[defaultIdx].size };
          if (sizeDisplay) sizeDisplay.textContent = sizeList[defaultIdx].label;

          // Size selection handlers
          options.querySelectorAll('.variant-option').forEach(btn => {
            btn.addEventListener('click', () => {
              options.querySelector('.is-selected')?.classList.remove('is-selected');
              btn.classList.add('is-selected');
              const idx = parseInt(btn.dataset.variantIdx, 10);
              currentVariantSize = { priceTier: sizeList[idx].tier, size: sizeList[idx].size };
              if (sizeDisplay) sizeDisplay.textContent = sizeList[idx].label;
              updateArtPrice();
              updateRoomView();
            });
          });
        }
      }
    }

    // Frame option handlers
    const frameDisplay = document.getElementById('art-frame-display');
    const framesPreview = document.getElementById('pp-frames');
    document.querySelectorAll('#art-frame-options .variant-option').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelector('#art-frame-options .is-selected')?.classList.remove('is-selected');
        btn.classList.add('is-selected');
        currentFrame = btn.dataset.frame;
        if (frameDisplay) frameDisplay.textContent = currentFrame === 'framed' ? 'Framed' : 'Unframed';
        // Show/hide frame preview swatches
        if (framesPreview) {
          framesPreview.style.display = currentFrame === 'framed' ? '' : 'none';
          // When switching to unframed, reset frame preview
          if (currentFrame !== 'framed') {
            const ppFrame = document.getElementById('pp-frame');
            if (ppFrame) ppFrame.dataset.frame = 'none';
            document.querySelector('.pp-frames__btn.is-active')?.classList.remove('is-active');
            const noneBtn = document.querySelector('.pp-frames__btn[data-frame="none"]');
            if (noneBtn) noneBtn.classList.add('is-active');
            currentFrameColor = 'none';
          }
        }
        updateArtPrice();
        updateRoomView();
      });
    });

    // Hide frame preview initially (starts unframed)
    if (framesPreview) framesPreview.style.display = 'none';

    // Initial price (after size + frame handlers are set up)
    updateArtPrice();

    // Frame preview swatches — also set frame color for cart
    document.querySelectorAll('.pp-frames__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelector('.pp-frames__btn.is-active')?.classList.remove('is-active');
        btn.classList.add('is-active');
        const ppFrame = document.getElementById('pp-frame');
        if (ppFrame) ppFrame.dataset.frame = btn.dataset.frame;
        currentFrameColor = btn.dataset.frame;
        // If a frame color is selected (not 'none'), ensure framed is selected
        if (btn.dataset.frame !== 'none' && currentFrame !== 'framed') {
          document.querySelector('#art-frame-options .is-selected')?.classList.remove('is-selected');
          const framedBtn = document.querySelector('#art-frame-options .variant-option[data-frame="framed"]');
          if (framedBtn) {
            framedBtn.classList.add('is-selected');
            currentFrame = 'framed';
            if (frameDisplay) frameDisplay.textContent = 'Framed';
            updateArtPrice();
          }
        }
        updateRoomView();
      });
    });

    // Lightbox
    const zoomBtn = document.getElementById('pp-zoom-btn');
    const lightbox = document.getElementById('pp-lightbox');
    const lbImg = document.getElementById('pp-lightbox-img');
    const lbClose = document.getElementById('pp-lightbox-close');
    if (zoomBtn && lightbox) {
      zoomBtn.addEventListener('click', () => {
        lbImg.src = asset.images.s2000 || asset.images.s1600 || asset.images.s1200;
        lbImg.alt = asset.title;
        lightbox.classList.add('is-open');
        document.body.style.overflow = 'hidden';
      });
      const closeLb = () => {
        lightbox.classList.remove('is-open');
        document.body.style.overflow = '';
      };
      lbClose?.addEventListener('click', closeLb);
      lightbox.querySelector('.pp-lightbox__close')?.addEventListener('click', closeLb);
    }

    // Add to cart handler
    document.getElementById('art-add-to-cart').addEventListener('click', addToCart);

    // Meta info (specs)
    const metaEl = document.getElementById('art-meta');
    metaEl.innerHTML = `
      ${asset.orientation ? `<div class="pp-specs__row"><span class="pp-specs__label">Orientation</span><span class="pp-specs__value">${formatOrientation(asset.orientation)}</span></div>` : ''}
      ${asset.maxPrint ? `<div class="pp-specs__row"><span class="pp-specs__label">Max Print Size</span><span class="pp-specs__value">${formatMaxPrint(asset.maxPrint)}</span></div>` : ''}
      ${asset.quality ? `<div class="pp-specs__row"><span class="pp-specs__label">Quality</span><span class="pp-specs__value">${asset.quality} Grade</span></div>` : ''}
      ${asset.artist ? `<div class="pp-specs__row"><span class="pp-specs__label">Artist</span><span class="pp-specs__value">${escHtml(asset.artist)}</span></div>` : ''}
      ${asset.style ? `<div class="pp-specs__row"><span class="pp-specs__label">Style</span><span class="pp-specs__value">${escHtml(asset.style)}</span></div>` : ''}
      ${asset.mood ? `<div class="pp-specs__row"><span class="pp-specs__label">Mood</span><span class="pp-specs__value">${escHtml(asset.mood)}</span></div>` : ''}
    `;

    // Show content
    loading.style.display = 'none';
    content.style.display = '';

    // Re-init accordion
    initAccordion();

    // Render room view (see it on your wall)
    renderRoomView(asset);
  }

  // ─── ROOM VIEW — See It On Your Wall ─────────────────

  function renderRoomView(asset) {
    const container = document.getElementById('art-room-view');
    if (!container) return;

    container.innerHTML = `
      <div class="room-preview">
        <div class="room-preview__heading">See It On Your Wall</div>
        <div class="room-preview__scene">
          <div class="room-preview__wall">
            <div class="room-preview__art-frame" id="room-art-frame" data-frame="none">
              <img src="${asset.images.s800 || asset.images.s1200}" alt="${escHtml(asset.title)}" draggable="false">
            </div>
            <div class="room-preview__dims" id="room-dims"></div>
          </div>
          <div class="room-preview__person" title="170 cm reference">
            <svg viewBox="0 0 40 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="20" cy="8" r="7" fill="#9b8e7e"/>
              <path d="M20 16 C12 16 8 24 8 36 L12 36 14 56 10 90 16 90 20 64 24 90 30 90 26 56 28 36 32 36 C32 24 28 16 20 16Z" fill="#9b8e7e"/>
            </svg>
            <span class="room-preview__person-label">170 cm</span>
          </div>
          <div class="room-preview__sofa">
            <svg viewBox="0 0 260 90" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="15" y="30" width="230" height="50" rx="6" fill="#8a7d6d"/>
              <rect x="5" y="20" width="35" height="60" rx="8" fill="#7a6e5e"/>
              <rect x="220" y="20" width="35" height="60" rx="8" fill="#7a6e5e"/>
              <rect x="25" y="10" width="210" height="25" rx="5" fill="#7a6e5e"/>
              <rect x="35" y="80" width="12" height="10" rx="2" fill="#6b5f50"/>
              <rect x="213" y="80" width="12" height="10" rx="2" fill="#6b5f50"/>
            </svg>
          </div>
        </div>
        <span class="room-preview__caption">Scale reference — artwork shown proportionally on a standard wall</span>
      </div>
    `;

    updateRoomView();
  }

  function updateRoomView() {
    const frame = document.getElementById('room-art-frame');
    if (!frame) return;

    // Update frame style
    if (currentFrame === 'framed' && currentFrameColor && currentFrameColor !== 'none') {
      frame.dataset.frame = currentFrameColor;
    } else if (currentFrame === 'framed') {
      frame.dataset.frame = 'black';
    } else {
      frame.dataset.frame = 'none';
    }

    // Parse size dimensions (e.g. "40×60 cm" or "60x80 cm")
    const sizeStr = currentVariantSize?.size || '';
    const match = sizeStr.match(/(\d+)\s*[×x]\s*(\d+)/i);
    const img = frame.querySelector('img');
    const dims = document.getElementById('room-dims');

    if (match && img) {
      const wCm = parseInt(match[1]);
      const hCm = parseInt(match[2]);

      // Scale: the room scene represents ~200cm of wall height
      // The scene CSS height is 280px, wall portion is ~65% = 182px
      // So scale = 182/200 = 0.91 px/cm
      const SCALE = 0.91;
      const maxW = 260; // max px width in scene
      const maxH = 160; // max px height in scene

      let imgW = Math.round(wCm * SCALE);
      let imgH = Math.round(hCm * SCALE);

      // Clamp to scene limits while maintaining aspect ratio
      if (imgW > maxW) { imgH = Math.round(imgH * (maxW / imgW)); imgW = maxW; }
      if (imgH > maxH) { imgW = Math.round(imgW * (maxH / imgH)); imgH = maxH; }

      img.style.width = imgW + 'px';
      img.style.height = imgH + 'px';
      img.style.maxWidth = imgW + 'px';
      img.style.maxHeight = imgH + 'px';

      if (dims) dims.textContent = wCm + ' × ' + hCm + ' cm';
    } else if (img) {
      // Fallback — use tier-based defaults
      const tierSizes = { small: [90, 70], medium: [110, 90], large: [140, 110], extra_large: [180, 140] };
      const tier = currentVariantSize?.priceTier || 'small';
      const [w, h] = tierSizes[tier] || [90, 70];
      img.style.width = w + 'px';
      img.style.height = h + 'px';
      img.style.maxWidth = w + 'px';
      img.style.maxHeight = h + 'px';
      if (dims) dims.textContent = PRICE_TIERS[tier]?.label || '';
    }
  }

  function updateArtPrice() {
    if (!currentAsset) return;

    const tier = currentVariantSize?.priceTier || currentAsset.priceTier;
    const framed = currentFrame === 'framed';
    const price = getPrice(tier, framed);
    const comparePrice = framed ? null : getPrice(tier, true);

    document.getElementById('art-price').textContent = formatPrice(price);
    document.getElementById('art-cart-price').textContent = formatPrice(price);

    const compareEl = document.getElementById('art-compare-price');
    if (!framed && comparePrice) {
      compareEl.textContent = formatPrice(comparePrice);
      compareEl.style.display = '';
    } else {
      compareEl.style.display = 'none';
    }
  }

  function showArtNotFound() {
    const loading = document.getElementById('art-loading');
    const notFound = document.getElementById('art-not-found');
    if (loading) loading.style.display = 'none';
    if (notFound) notFound.style.display = '';
  }

  async function loadSimilarArtworks(assetId) {
    try {
      const data = await apiFetch(`/api/storefront/similar-asset/${assetId}?limit=4`);
      if (!data.similar || data.similar.length === 0) return;

      const container = document.getElementById('art-similar');
      const grid = document.getElementById('art-similar-grid');
      container.style.display = '';

      grid.innerHTML = data.similar.map(item => {
        const artUrl = `/pages/art?id=${item.id}`;
        const price = getPrice(item.priceTier, false);
        return `
          <div class="catalog-card" data-animate="fade-up">
            <a href="${artUrl}" class="catalog-card__link">
              <div class="catalog-card__img-wrap">
                <img class="catalog-card__img" src="${item.image}" alt="${escHtml(item.title)}" loading="lazy">
                ${WATERMARK_HTML}
                <div class="catalog-card__overlay"><span>View</span></div>
              </div>
              <div class="catalog-card__info">
                <h3 class="catalog-card__title">${escHtml(item.title)}</h3>
                <p class="catalog-card__artist">${escHtml(item.artist)}</p>
                <div class="catalog-card__price">
                  <span class="catalog-card__price-current">From ${formatPrice(price)}</span>
                </div>
              </div>
            </a>
          </div>
        `;
      }).join('');

      initScrollAnimations(grid);
    } catch (e) {
      console.warn('Similar artworks failed:', e.message);
    }
  }

  // ─── CART INTEGRATION ─────────────────────────────────
  // Uses Shopify's /cart/add.js with skeleton variant + line item properties

  async function addToCart() {
    if (!currentAsset) return;

    const btn = document.getElementById('art-add-to-cart');
    const feedback = document.getElementById('art-feedback');
    const tier = currentVariantSize?.priceTier || currentAsset.priceTier;
    const framed = currentFrame === 'framed';
    const variantId = getVariantId(tier, framed);

    if (!variantId || variantId === 'PENDING') {
      alert('Cart is not ready yet. Please try again shortly.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Adding…';

    // Determine frame description for Printful
    const frameColorMap = { black: 'Black', white: 'White', natural: 'Natural Oak', walnut: 'Walnut' };
    const frameDesc = framed && currentFrameColor !== 'none'
      ? frameColorMap[currentFrameColor] || 'Black'
      : (framed ? 'Black' : 'None');

    const lineItemProperties = {
      '_asset_id': currentAsset.id,
      'Artwork': currentAsset.title,
      'Artist': currentAsset.artist || 'Unknown',
      'Size': currentVariantSize?.size || currentAsset.maxPrint,
      'Frame': framed ? 'Framed' : 'Unframed',
      'Frame Color': frameDesc,
      '_drive_file_id': currentAsset.driveFileId,
      '_price_tier': tier,
      '_frame_color': currentFrameColor,
      '_preview': currentAsset.images.s400,
    };

    try {
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            id: parseInt(variantId, 10),
            quantity: 1,
            properties: lineItemProperties,
          }],
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.description || err.message || 'Failed to add to cart');
      }

      // Success
      btn.innerHTML = 'Added ✓';
      feedback.style.display = 'flex';

      // Update cart count in header
      updateCartCount();

      // Track event
      trackEvent('add_to_cart', {
        asset_id: currentAsset.id,
        title: currentAsset.title,
        price_tier: tier,
        framed,
      });

      // Redirect to cart page after brief confirmation
      setTimeout(() => {
        window.location.href = '/cart';
      }, 600);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = `Add to Cart — <span id="art-cart-price">${formatPrice(getPrice(tier, framed))}</span>`;
      alert('Error: ' + err.message);
    }
  }

  async function updateCartCount() {
    try {
      const res = await fetch('/cart.js');
      const cart = await res.json();
      // Update dedicated badge elements (not the parent link)
      document.querySelectorAll('.cart-count__badge, [data-cart-count]').forEach(el => {
        el.textContent = cart.item_count;
        el.style.display = cart.item_count > 0 ? '' : 'none';
      });
      // If no badge exists inside .cart-count, create one
      document.querySelectorAll('a.cart-count').forEach(link => {
        let badge = link.querySelector('.cart-count__badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'cart-count__badge';
          link.appendChild(badge);
        }
        badge.textContent = cart.item_count;
        badge.style.display = cart.item_count > 0 ? '' : 'none';
      });
    } catch (e) { /* ignore */ }
  }

  // ─── ANALYTICS ────────────────────────────────────────

  function trackEvent(eventType, metadata = {}) {
    const base = getApiBase();
    fetch(`${base}/api/storefront/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: eventType,
        session_id: getSessionId(),
        metadata,
      }),
    }).catch(() => {});
  }

  function getSessionId() {
    let sid = sessionStorage.getItem('neverland_sid');
    if (!sid) {
      sid = 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('neverland_sid', sid);
    }
    return sid;
  }

  // ─── SCROLL ANIMATIONS ───────────────────────────────

  function initScrollAnimations(container) {
    const els = (container || document).querySelectorAll('[data-animate]:not(.is-visible)');
    if (els.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

    els.forEach(el => observer.observe(el));
  }

  function initAccordion() {
    document.querySelectorAll('.pp-accordion__trigger').forEach(trigger => {
      // Remove old listeners by cloning
      const clone = trigger.cloneNode(true);
      trigger.parentNode.replaceChild(clone, trigger);
      clone.addEventListener('click', () => {
        const content = clone.nextElementSibling;
        const isOpen = clone.classList.contains('is-open');
        clone.closest('.pp-accordion')?.querySelectorAll('.pp-accordion__trigger').forEach(t => {
          t.classList.remove('is-open');
          t.nextElementSibling?.classList.remove('is-open');
        });
        if (!isOpen) {
          clone.classList.add('is-open');
          content?.classList.add('is-open');
        }
      });
    });
  }

  // ─── SEARCH PAGE INTEGRATION ──────────────────────────

  async function initSearchPage() {
    // Check if we're on a search page with our API search
    const searchForm = document.querySelector('.search-page form[action="/search"]');
    if (!searchForm) return;

    // Override search to use our API
    const searchInput = searchForm.querySelector('input[name="q"]');
    if (!searchInput) return;

    searchForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (!query) return;

      // Redirect to our catalog page with search
      window.location.href = `/pages/catalog?q=${encodeURIComponent(query)}`;
    });
  }

  // ─── ARTISTS MEGA-MENU ─────────────────────────────────

  async function initArtistsMegaMenu() {
    const popularCol = document.getElementById('artists-mega-popular');
    const moreCol = document.getElementById('artists-mega-more');
    if (!popularCol && !moreCol) return;

    try {
      const data = await apiFetch('/api/storefront/artists?limit=12');
      if (!data.artists || data.artists.length === 0) return;
      const artists = data.artists;
      const half = Math.ceil(artists.length / 2);
      const first = artists.slice(0, half);
      const second = artists.slice(half);

      function renderCol(col, list) {
        if (!col) return;
        const title = col.querySelector('.mega-nav__col-title');
        const html = list.map(a =>
          `<a href="/pages/catalog?artist=${encodeURIComponent(a.name || a.artist)}">${a.name || a.artist} <small style="color:var(--text-muted)">(${a.count})</small></a>`
        ).join('');
        col.innerHTML = (title ? title.outerHTML : '') + html;
      }

      renderCol(popularCol, first);
      renderCol(moreCol, second);
    } catch (e) {
      // Silently fail — static links still work
    }
  }

  // ─── HOMEPAGE INITIALIZATION ────────────────────────────

  async function initHomepage() {
    // Only run on the homepage (index template or root path)
    const isHome = document.body.classList.contains('template-index') ||
                   window.location.pathname === '/' ||
                   document.querySelector('#hero-mosaic');
    if (!isHome) return;

    // ── IMMEDIATE: Init Swipers for server-rendered sections (no API wait) ──
    const bestsellersSlides = document.getElementById('bestsellers-slides');
    if (bestsellersSlides && bestsellersSlides.children.length > 0) {
      reinitSwiper('bestsellers-swiper', 'product');
    }
    const newArrivalsSlides = document.getElementById('new-arrivals-slides');
    if (newArrivalsSlides && newArrivalsSlides.children.length > 0) {
      reinitSwiper('new-arrivals-swiper', 'product');
    }
    const artistSlidesEl = document.getElementById('artist-carousel-slides');
    if (artistSlidesEl && artistSlidesEl.children.length > 0) {
      reinitSwiper('artist-carousel-swiper', 'artist');
    }
    // Init pros carousel immediately if it has slides
    if (document.querySelector('#pros-carousel .swiper-slide')) {
      reinitSwiper('pros-carousel', 'testimonial');
    }

    // ── BACKGROUND: Fire API calls non-blocking for progressive enhancement ──
    // Only used for hero bg replacement and 3D frame rotation (everything else is server-rendered)

    // Show cached hero instantly (no API wait)
    (function showCachedHero() {
      const ph = document.getElementById('hero-bg-placeholder');
      if (!ph) return;
      try {
        const cached = JSON.parse(localStorage.getItem('nl_hero'));
        if (cached && cached.url && (Date.now() - cached.ts < 86400000)) {
          const img = new Image();
          img.onload = function() {
            const el = document.getElementById('hero-bg-placeholder');
            if (el) el.outerHTML = `<img src="${cached.url}" alt="${(cached.alt || '').replace(/"/g, '&quot;')}" loading="eager" fetchpriority="high" style="width:100%;height:100%;object-fit:cover;" id="hero-bg-cached">`;
          };
          img.src = cached.url;
        }
      } catch(e) {}
    })();

    function setHeroBg(items) {
      const ph = document.getElementById('hero-bg-placeholder') || document.getElementById('hero-bg-cached');
      if (!ph || items.length === 0) return;
      const heroItem = items[Math.floor(Math.random() * Math.min(items.length, 10))];
      const heroUrl = heroItem.imageSrcset ? heroItem.imageSrcset.s1600 || heroItem.imageSrcset.s1200 : heroItem.image;
      if (heroUrl) {
        const img = new Image();
        img.onload = function () {
          const target = document.getElementById('hero-bg-placeholder') || document.getElementById('hero-bg-cached');
          if (target) {
            target.outerHTML = `<img src="${heroUrl}" alt="${(heroItem.title || '').replace(/"/g, '&quot;')}" loading="eager" fetchpriority="high" style="width:100%;height:100%;object-fit:cover;">`;
            try { localStorage.setItem('nl_hero', JSON.stringify({ url: heroUrl, alt: heroItem.title || '', ts: Date.now() })); } catch(e) {}
          }
        };
        img.src = heroUrl;
      }
    }

    function populate3DFrame(items) {
      const frameEl = document.getElementById('frame3d-artwork');
      const frameTitleEl = document.getElementById('frame3d-title');
      const frameArtistEl = document.getElementById('frame3d-artist');
      if (!frameEl || items.length < 32) return;
      const artIdx = [30, 31, 32, 33, 34];
      let curIdx = 0;
      function showArt() {
        const item = items[artIdx[curIdx % artIdx.length]];
        if (!item) return;
        const url = item.imageSrcset ? item.imageSrcset.s800 : item.image;
        const newImg = new Image();
        newImg.onload = function () {
          frameEl.style.opacity = '0';
          setTimeout(() => {
            frameEl.src = url;
            frameEl.alt = item.title || 'Artwork';
            if (frameTitleEl) frameTitleEl.textContent = item.title || 'Untitled';
            if (frameArtistEl) frameArtistEl.textContent = item.artist || '';
            frameEl.style.opacity = '1';
          }, 400);
        };
        newImg.src = url;
        curIdx++;
      }
      showArt();
      setInterval(showArt, 6000);
    }

    // Single background API call for hero + 3D frame only (non-blocking)
    apiFetch('/api/storefront/catalog?sort=random&per_page=50')
      .then(function(data) {
        const items = data.items || [];
        if (items.length > 0) {
          setHeroBg(items);
          populate3DFrame(items);
        }
      })
      .catch(function() {
        // Retry once after 5s for cold start
        setTimeout(function() {
          apiFetch('/api/storefront/catalog?sort=random&per_page=50')
            .then(function(data) {
              const items = data.items || [];
              if (items.length > 0) {
                setHeroBg(items);
                populate3DFrame(items);
              }
            })
            .catch(function() {});
        }, 5000);
      });
  }

  // ── Product card slide HTML generator ──
  function productCardSlide(item) {
    const img = item.imageSrcset ? item.imageSrcset.s600 : item.image;
    const title = (item.title || 'Untitled').replace(/"/g, '&quot;');
    const artist = item.artist || 'Unknown Artist';
    const price = item.price || '29.99';
    return `<div class="swiper-slide">
      <div class="product-card">
        <a href="/pages/art?id=${item.id}" class="product-card__link">
          <div class="product-card__img-wrap">
            <img class="product-card__img" src="${img}" alt="${title}" loading="lazy">
            ${WATERMARK_HTML}
            <div class="product-card__quick">Quick View</div>
          </div>
          <div class="product-card__info">
            <div class="product-card__artist">${artist}</div>
            <h3 class="product-card__title">${item.title || 'Untitled'}</h3>
            <div class="product-card__price">
              <span class="product-card__price-current">From $${price}</span>
            </div>
          </div>
        </a>
      </div>
    </div>`;
  }

  // ── Reinitialize Swiper on a container after dynamic content ──
  function reinitSwiper(containerId, type) {
    if (typeof Swiper === 'undefined') return;
    const el = document.getElementById(containerId);
    if (!el) return;

    // Destroy existing Swiper instance if any
    if (el.swiper) {
      try { el.swiper.destroy(true, true); } catch (e) {}
    }

    const section = el.closest('.section') || el.closest('section');
    const prevEl = section ? section.querySelector('.swiper-arrow--prev') : null;
    const nextEl = section ? section.querySelector('.swiper-arrow--next') : null;
    const paginationEl = el.querySelector('.swiper-pagination');

    const configs = {
      collection: {
        slidesPerView: 1.3, spaceBetween: 12, speed: 700, grabCursor: true,
        pagination: { el: paginationEl, clickable: true },
        navigation: { prevEl, nextEl },
        breakpoints: {
          576: { slidesPerView: 2.3, spaceBetween: 14 },
          768: { slidesPerView: 3.2, spaceBetween: 16 },
          1024: { slidesPerView: 4.2, spaceBetween: 16 },
          1400: { slidesPerView: 5, spaceBetween: 16 },
        }
      },
      artist: {
        slidesPerView: 1.4, spaceBetween: 12, speed: 700, grabCursor: true,
        pagination: { el: paginationEl, clickable: true },
        navigation: { prevEl, nextEl },
        breakpoints: {
          576: { slidesPerView: 2.4, spaceBetween: 14 },
          768: { slidesPerView: 3.3, spaceBetween: 16 },
          1024: { slidesPerView: 4.2, spaceBetween: 16 },
          1400: { slidesPerView: 5, spaceBetween: 16 },
        }
      },
      product: {
        slidesPerView: 1.2, spaceBetween: 14, speed: 600, grabCursor: true,
        pagination: { el: paginationEl, clickable: true },
        navigation: { prevEl, nextEl },
        breakpoints: {
          576: { slidesPerView: 2.3, spaceBetween: 16 },
          768: { slidesPerView: 3.2, spaceBetween: 18 },
          1024: { slidesPerView: 4, spaceBetween: 20 },
        }
      },
    };

    new Swiper(el, configs[type] || configs.product);
  }

  // ─── IMAGE PROTECTION ────────────────────────────────
  // Prevent right-click on artwork images
  document.addEventListener('contextmenu', function(e) {
    if (e.target.closest('.product-gallery, .catalog-card, .product-card, .pp-frame, .frame-preview, .room-preview, .showcase-frame, .carousel__card')) {
      e.preventDefault();
    }
  });
  // Prevent dragging images
  document.addEventListener('dragstart', function(e) {
    if (e.target.tagName === 'IMG') e.preventDefault();
  });
  // Block Ctrl+S / Ctrl+Shift+I on art pages
  document.addEventListener('keydown', function(e) {
    if (document.getElementById('art-detail') && (e.ctrlKey || e.metaKey)) {
      if (e.key === 's' || e.key === 'S' || (e.shiftKey && (e.key === 'i' || e.key === 'I'))) {
        e.preventDefault();
      }
    }
  });

  // ─── NEWSLETTER AJAX HANDLING ─────────────────────────
  function initNewsletter() {
    const form = document.querySelector('.footer-newsletter__form');
    if (!form) return;
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const email = form.querySelector('input[name="contact[email]"]');
      if (!email || !email.value) return;
      const btn = form.querySelector('.footer-newsletter__btn');
      if (btn) btn.disabled = true;
      try {
        const fd = new FormData(form);
        const resp = await fetch('/contact#contact_form', { method: 'POST', body: fd });
        if (resp.ok || resp.status === 302 || resp.status === 200) {
          const success = document.getElementById('newsletter-success');
          if (success) success.style.display = '';
          email.value = '';
          setTimeout(() => { if (success) success.style.display = 'none'; }, 5000);
        }
      } catch (err) {
        console.warn('Newsletter signup error:', err);
      }
      if (btn) btn.disabled = false;
    });
  }

  // ─── INIT ─────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    initCatalogBrowse();
    initArtDetail();
    initSearchPage();
    initArtistsMegaMenu();
    initHomepage();
    initNewsletter();
  });

})();
