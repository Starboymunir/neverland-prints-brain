# PopMotif.com — Complete Design System & Section Architecture

> Source: `popmotif.thml` (16,954 lines) — full homepage HTML of **popmotif.com**
> Theme: **Minimalista v1.4.2** (Shopify Theme Store ID 2316)
> Theme name set to: **"Pop Motif New 2025"**
> Shop: Pop Motif | Currency: NZD | Domain: `popmotifgallery.myshopify.com`

---

## 1. Typography

| Token | Value |
|---|---|
| **Primary Font** | `"Instrument Sans", sans-serif` (Google/Shopify CDN) |
| **Weights loaded** | 400 (normal + italic), 500 (normal), 700 (normal + italic) |
| **Icon Font** | `JudgemeStar` (base64-encoded woff for review star glyphs) |
| **Base font-size** | `10px` on `<html>` (rem-based scale) |
| **Body font-size** | `calc(var(--font-body-scale) * 1rem - 0.1rem)` → **1.5rem (15px)** |
| **Body line-height** | `1.4` (body), variable `--font-body-line-height: 1.5` |
| **Body weight** | 400 |
| **Heading family** | `"Instrument Sans", sans-serif` |
| **Heading weight** | 400 |
| **Heading letter-spacing** | `0em` |
| **Heading line-height** | `1.2` |
| **Heading scales** | H1: `1.0`, H2: `1.15`, H3: `1.0`, H4: `1.0`, H5: `1.0` |
| **Subtitle** | family same, weight 400, transform `none`, scale `1.5`, letter-spacing `-0.02em` |
| **Button font** | weight `500`, transform `none`, letter-spacing `-0.02em` |
| **Card heading** | weight 400, scale `1.5` |
| **Card text** | weight 400, scale `1.4` |
| **Header menu** | weight 400, transform `none` |
| **Footer menu** | weight 400 |
| **Popup heading** | weight 500, scale `1.23` |

---

## 2. Color Palette (4 Schemes)

All values are `R, G, B` triplets used as `rgb(var(--color-*))`.

### Scheme 1 — Light (`:root`, `.color-background-1`)
| Token | RGB | Hex |
|---|---|---|
| `--color-background` | 255, 255, 255 | `#FFFFFF` |
| `--color-background-secondary` | 244, 244, 244 | `#F4F4F4` |
| `--color-foreground` | 40, 40, 40 | `#282828` |
| `--color-foreground-secondary` | 105, 105, 105 | `#696969` |
| `--color-foreground-title` | 40, 40, 40 | `#282828` |
| `--color-button` | 40, 40, 40 | `#282828` |
| `--color-button-hover` | 53, 53, 53 | `#353535` |
| `--color-button-text` | 249, 249, 249 | `#F9F9F9` |
| `--color-button-secondary` | 249, 249, 249 | `#F9F9F9` |
| `--color-button-secondary-text` | 40, 40, 40 | `#282828` |
| `--color-border` | 229, 229, 229 | `#E5E5E5` |
| `--color-border-input` | 229, 229, 229 | `#E5E5E5` |
| `--color-background-input` | 244, 244, 244 | `#F4F4F4` |
| `--color-overlay` | 0, 0, 0 | `#000000` |

### Scheme 2 — Secondary (`.color-background-2`)
| Token | RGB | Hex |
|---|---|---|
| `--color-background` | 244, 244, 244 | `#F4F4F4` |
| `--color-background-secondary` | 249, 249, 249 | `#F9F9F9` |
| Foreground & buttons: **same as Scheme 1** | | |

### Scheme 3 — Dark (`.color-background-3`)
| Token | RGB | Hex |
|---|---|---|
| `--color-background` | 40, 40, 40 | `#282828` |
| `--color-background-secondary` | 31, 31, 31 | `#1F1F1F` |
| `--color-foreground` | 249, 249, 249 | `#F9F9F9` |
| `--color-foreground-secondary` | 169, 169, 169 | `#A9A9A9` |
| `--color-button` | 255, 255, 255 | `#FFFFFF` |
| `--color-button-text` | 40, 40, 40 | `#282828` |
| `--color-border` | 62, 62, 62 | `#3E3E3E` |
| `--color-background-input` | 53, 53, 53 | `#353535` |

### Scheme 4 — Darkest (`.color-background-4`)
| Token | RGB | Hex |
|---|---|---|
| `--color-background` | 31, 31, 31 | `#1F1F1F` |
| `--color-background-secondary` | 40, 40, 40 | `#282828` |
| `--color-foreground` | 249, 249, 249 | `#F9F9F9` |
| `--color-button` | 40, 40, 40 | `#282828` |
| `--color-button-text` | 249, 249, 249 | `#F9F9F9` |

### Additional Color Tokens
| Token | Value |
|---|---|
| `--color-card-price-new` | 40, 40, 40 (`#282828`) |
| `--color-card-price-old` | 169, 169, 169 (`#A9A9A9`) |

---

## 3. Spacing System

| Token | Mobile | Desktop (>=990px) |
|---|---|---|
| `--spaced-section` | `5rem` (50px) | `16rem` (160px) |
| `--announcement-height` | `0px` | `0px` |
| `--header-height` | dynamic (JS-set) | dynamic |
| `--breadcrumbs-height` | `0px` | `0px` |

Each section uses **per-section padding overrides** with 3-tier responsive breakpoints:
- Mobile (default)
- Tablet (>=750px)
- Desktop (>=1440px)

Example pattern (Bestsellers):
```css
padding-top: 4.8rem;    /* mobile */
padding-bottom: 4.8rem;
/* >=750px */ padding-top: 6.4rem; padding-bottom: 6.4rem;
/* >=1440px */ padding-top: 8.8rem; padding-bottom: 8.8rem;
```

---

## 4. Button Styles

| Property | Value |
|---|---|
| `--border-radius-button` | `4px` |
| Primary: bg | `rgb(40,40,40)` / hover `rgb(53,53,53)` |
| Primary: text | `rgb(249,249,249)` |
| Primary: font | Instrument Sans 500, letter-spacing `-0.02em` |
| Secondary: bg | `rgb(249,249,249)` / hover `rgb(238,238,238)` |
| Secondary: text | `rgb(40,40,40)` |
| Tertiary (outline) | border `rgb(40,40,40)`, hover fills to `rgb(40,40,40)` with white text |

**Button Classes**: `button--primary`, `button--secondary`, `button--tertiary`, `button--simple`, `button--arrow`, `button--full-width`

---

## 5. Global Layout

```css
html { box-sizing: border-box; font-size: 10px; height: 100%; }
body { display: grid; grid-template-rows: auto auto 1fr auto; grid-template-columns: 100%; }
```
Page container: `div.container` (max-width set via theme)
Grid: Bootstrap-style 12-column via `.row` + `.col-md-*` classes

---

## 6. JavaScript & Third-Party Stack

| Library | Purpose |
|---|---|
| jQuery 3.6.0 | DOM manipulation |
| Swiper.js (bundle) | All carousels/sliders |
| GSAP + ScrollTrigger | Scroll-based animations |
| AOS.js | Animate On Scroll (`once: true`) |
| Judge.me | Product reviews (4.95 avg, 5455 reviews) |
| Klaviyo | Email marketing / newsletter |
| Google Analytics | Site verification present |
| TikTok Pixel | Advertising |
| Justuno | Pop-ups/lead capture |
| Afterpay/Clearpay | BNPL messaging (snippet v1.2.1) |
| Shopify Cart Sync | Sign In with Shop |
| hCaptcha | Form protection |
| Live Chat | Custom chat widget (`chat-button-container`) |

---

## 7. Homepage Section Order & Architecture

### Section Map (top to bottom)

| # | Section ID | Class | Lines |
|---|---|---|---|
| **0** | Header (header-group) | `shopify-section-group-header-group` | ~650-3400 |
| **1** | `hero_jxE7me` | `hero-section` | 3326-3420 |
| **2** | `marquee_R8KRmU` | `spaced-section` | 3421-3447 |
| **3** | `carousel_QrFHfH` | `spaced-section section-carousel` | 3447-3893 |
| **4** | `carousel2_LLNeKU` | `spaced-section section-carousel` | 3894-4340 |
| **5** | `art_made_easy_JpJ8RP` | (custom) | 4341-4376 |
| **6** | `media_slideshow_BwUxyz` | (custom) | 4376-4599 |
| **7** | `countup_7aQerC` | `spaced-section` | 4599-4625 |
| **8** | `product_slider_bQDXTz` | `popular-products-section spaced-section` | 4625-11090 |
| **9** | `product_slider2_py3VkF` | `popular-products-section spaced-section` | 11090-14810 |
| **10** | `where_pros_shop_6EGWXq` | `spaced-section` | 14810-14892 |
| **11** | `ugc_YydDHG` | `ugc-section` | 14892-15017 |
| **12** | `reviews_8NLtVh` | `spaced-section` | 15017-15180 |
| **13** | Footer (footer-group) | `shopify-section-group-footer-group` | 15180-16500 |
| **14** | Cart Drawer | `cart-drawer` | 16500-16650 |

---

## 8. Detailed Section Breakdown

---

### 8.1 Header & Navigation

**Structure**: Sticky header with announcement bar slot (currently height 0)

```
header-group
+-- Announcement Bar (hidden/0px)
+-- Header (sticky)
    +-- Logo: SVG "Pop Motif" (pop-motif.svg, 185x21px)
    +-- Desktop Mega-Menu Navigation
    |   +-- Shop (mega-menu with collection links + featured images)
    |   +-- Collections (mega-menu)
    |   +-- Artists (mega-menu with artist grid)
    |   +-- Inspiration (link)
    |   +-- About Us (mega-menu)
    +-- Search (predictive search with AJAX)
    +-- Account icon -> /account/login
    +-- Cart icon -> Cart Drawer (slide-in)
```

**Navigation Links (Shop mega-menu)**:
- Shop All -> `/collections/art-prints-nz`
- Best Sellers -> `/collections/best-selling-art-prints`
- New In -> `/collections/new-art-prints`
- Gift Cards -> `/products/gift-card`
- Collections by style: Abstract, Botanical, Coastal, Contemporary, Figurative, Landscape, Line Art, Mid-Century Modern, Minimalist, Photography, Still Life, Vintage

**Mobile**: Hamburger menu -> `menu-drawer` with accordion sub-menus

---

### 8.2 Hero Banner

**Section ID**: `hero_jxE7me`
**Type**: Full-width image hero with text overlay

```html
<section class="hero-section">
  <!-- Full-bleed background image -->
  <img srcset="...&width=375 375w, ...&width=750 750w, ...&width=1100 1100w,
               ...&width=1500 1500w, ...&width=1780 1780w, ...&width=2000 2000w"
       sizes="100vw" />
  
  <!-- Overlay content -->
  <div class="hero__content hero__content--middle-center color-background-1
              hero-full hero__content--desktop-split">
    <div class="hero__top"><!-- empty --></div>
    <div class="hero__middle">
      <h2 class="h1">"Where Art Meets Home"</h2>
    </div>
    <div class="hero__bottom">
      <a href="/collections/art-prints-nz" class="button button--primary">Shop All Art</a>
      <a href="/collections/new-art-prints" class="button button--secondary">New Arrivals</a>
    </div>
  </div>
</section>
```

**Key Details**:
- Hero image: `hero-new.webp` served via Shopify CDN with 6 srcset sizes (375-2000w)
- Content positioned `middle-center` with `hero-full` (full viewport) and `desktop-split`
- **2 CTA buttons**: "Shop All Art" (primary/dark) + "New Arrivals" (secondary/light)
- Responsive padding: 4.8rem mobile, 6.4rem tablet, 8.8rem desktop

---

### 8.3 Marquee / Ticker

**Section ID**: `marquee_R8KRmU`
**Type**: Infinite horizontal scrolling text strip

```html
<div class="ticker-wrap">
  <div class="ticker">
    <!-- Repeated multiple times for seamless loop: -->
    <span class="ticker__item">Gallery Quality Art Prints</span>
    <span class="ticker__item">*</span>
    <span class="ticker__item">Custom Framing</span>
    <span class="ticker__item">*</span>
    <span class="ticker__item">Free NZ Shipping</span>
    <span class="ticker__item">*</span>
    <span class="ticker__item">10-Year Warranty</span>
    <span class="ticker__item">*</span>
    <!-- ...repeated 4x for continuous scroll -->
  </div>
</div>
```

**Ticker Messages**: "Gallery Quality Art Prints" * "Custom Framing" * "Free NZ Shipping" * "10-Year Warranty"

**CSS Animation**: `@keyframes ticker` — continuous leftward scroll via `translateX()`

---

### 8.4 Popular Collections Carousel

**Section ID**: `carousel_QrFHfH`
**Type**: Swiper-based horizontal carousel of collection cards

**Section Header**: "Popular Collections" + "Explore All ->" link

**Collections (8 items)**:

| # | Title | Link |
|---|---|---|
| 1 | Abstract | /collections/abstract-art-prints |
| 2 | Contemporary | /collections/contemporary-art-prints |
| 3 | Coastal | /collections/coastal-art-prints |
| 4 | Botanical | /collections/botanical-art-prints |
| 5 | Photography | /collections/photography-art-prints |
| 6 | Figurative | /collections/figurative-art-prints |
| 7 | Mid Century Modern | /collections/mid-century-modern-art-prints |
| 8 | Landscape | /collections/landscape-art-prints |

**Card structure**:
```html
<div class="swiper-slide carousel-card">
  <a href="/collections/...">
    <div class="carousel-card__media">
      <img srcset="...&width=165 165w, ...&width=535 535w, ...&width=750 750w" />
    </div>
    <h3 class="carousel-card__heading h5">Collection Name</h3>
  </a>
</div>
```

---

### 8.5 Popular Artists Carousel

**Section ID**: `carousel2_LLNeKU`
**Type**: Same Swiper carousel structure as Collections

**Section Header**: "Popular Artists" + "Explore All ->" link

**Artists (12 items)**:

| # | Name | Link |
|---|---|---|
| 1 | Clare Elsaesser | /collections/clare-elsaesser |
| 2 | Bea Muller | /collections/bea-muller |
| 3 | Frank Moth | /collections/frank-moth |
| 4 | Aureous | /collections/aureous |
| 5 | Sofia Bonati | /collections/sofia-bonati |
| 6 | Sofia Lind | /collections/sofia-lind |
| 7 | Ruben Ireland | /collections/ruben-ireland |
| 8 | Dada22 | /collections/dada22 |
| 9 | Beth Hoeckel | /collections/beth-hoeckel |
| 10 | Dan Hobday | /collections/dan-hobday |
| 11 | Linn Wold | /collections/linn-wold |
| 12 | J.H. Lynch | /collections/j-h-lynch |

Each card: artist portrait image + name as H3

---

### 8.6 Art Made Easy / Gallery Quality

**Section ID**: `art_made_easy_JpJ8RP`
**Type**: 50/50 split — autoplay video left, text + CTA right

```html
<div class="art-made-easy">
  <div class="container">
    <div class="row row-eq-height">
      <div class="col-md-6">
        <!-- Left: autoplay muted looping video -->
        <video autoplay loop muted playsinline class="always-autoplay no-autoplay-control">
          <source src="...art-made-easy.m3u8" type="application/x-mpegURL">
          <source src="...art-made-easy.HD-1080p.mp4" type="video/mp4">
        </video>
      </div>
      <div class="col-md-6">
        <!-- Right: text content -->
        <div class="ame-text vcenter">
          <h2 class="h2">The Art Of Art Made Easy</h2>
          <p>Discover gallery-quality art prints and custom framing —
             crafted with care and delivered to your door.
             Explore thousands of works from world-class artists,
             all at prices that make beautiful walls accessible to everyone.</p>
          <a href="/pages/our-story" class="button button--primary">Our Story</a>
        </div>
      </div>
    </div>
  </div>
</div>
```

**Key**: Video has classes `always-autoplay no-autoplay-control` — JS at page bottom ensures it always replays on pause/visibility change.

---

### 8.7 Media Slideshow / Full-Bleed Video

**Section ID**: `media_slideshow_BwUxyz`
**Type**: Full-width video with play/pause and sound toggle controls

```html
<div class="media-slideshow">
  <div class="swiper">
    <div class="swiper-wrapper">
      <div class="swiper-slide">
        <div class="video-wrapper" style="padding-bottom: 56.25%"> <!-- 16:9 -->
          <video autoplay loop muted playsinline class="always-autoplay">
            <source src="...media-slide.m3u8" type="application/x-mpegURL">
            <source src="...media-slide.HD-1080p.mp4" type="video/mp4">
          </video>
        </div>
      </div>
    </div>
  </div>
  <!-- Controls: play/pause button + sound toggle -->
  <div class="media-slideshow-controls">
    <button class="media-slideshow__button play-pause">
      <svg><!-- pause icon --></svg>
    </button>
    <button class="media-slideshow__button media-slideshow__button--sound">
      <svg><!-- sound off icon --></svg>
    </button>
  </div>
</div>
```

**Aspect ratio**: `padding-bottom: 56.25%` (16:9)
**Behavior**: Autoplay muted with manual sound toggle

---

### 8.8 Countup / Stats Section

**Section ID**: `countup_7aQerC`
**Type**: 3-column stats with animated count-up on scroll

```html
<div class="countup-section">
  <div class="container">
    <div class="row">
      <div class="col-md-4">
        <div class="count-up">
          <span data-target="12">0</span>
        </div>
        <p>years in business</p>
      </div>
      <div class="col-md-4">
        <div class="count-up">
          <span data-target="30000+">0</span>
        </div>
        <p>delighted customers</p>
      </div>
      <div class="col-md-4">
        <div class="count-up">
          <span data-target="60000+">0</span>
        </div>
        <p>artworks delivered</p>
      </div>
    </div>
  </div>
</div>
```

**Animation**: IntersectionObserver triggers `animateCountUp()` when 10% visible. Uses `requestAnimationFrame` with 2-second duration and `formatNumber()` for comma-separated display. "+" suffix preserved for 30000+ and 60000+.

---

### 8.9 Bestsellers Product Slider

**Section ID**: `product_slider_bQDXTz`
**Type**: `<product-recommendations>` custom element with horizontal product card slider
**Lines**: 4625-11090 (~6,465 lines — the largest section)

**Section Header**: "Bestsellers" + "Explore All ->" button

**Product Card Structure** (repeated for each product):
```html
<div class="swiper-slide product-slider__item">
  <div class="card-wrapper">
    <div class="card">
      <!-- Primary image -->
      <img srcset="...&width=165, ...&width=360, ...&width=535, ...&width=750, ...&width=1070"
           class="motion-reduce" loading="lazy" />
      <!-- Hover/secondary image -->
      <img class="card__media-second-image motion-reduce" loading="lazy" />

      <!-- Badge -->
      <span class="badge">Best Seller</span>
    </div>

    <!-- Card info -->
    <div class="card-information text-left">
      <a href="/products/..." class="full-unstyled-link">
        <span class="card-information__text h5">Product Title</span>
      </a>

      <!-- Judge.me stars -->
      <span class="jdgm-prev-badge" data-average-rating="5.00" data-number-of-reviews="123">
        <!-- star SVGs -->
      </span>

      <!-- Price -->
      <div class="price">
        <span class="price-item--regular">From $49.00</span>
      </div>

      <!-- Framing option swatches -->
      <div class="card__swatches">
        <div class="card__swatch" data-variant="Unframed"
             style="background:#FFFFFF; border:1px solid #ccc"></div>
        <div class="card__swatch" data-variant="Black Frame"
             style="background:#000000"></div>
        <div class="card__swatch" data-variant="White Frame"
             style="background:#FFFFFF; border:1px solid #ccc"></div>
        <div class="card__swatch" data-variant="Natural Frame"
             style="background:#C4A882"></div>
      </div>
    </div>
  </div>
</div>
```

**Framing Swatch Colors**:
| Variant | Color |
|---|---|
| Unframed | `#FFFFFF` (white + border) |
| Black Frame | `#000000` |
| White Frame | `#FFFFFF` (white + border) |
| Natural Frame | `#C4A882` |

**Badge types**: "Best Seller" (on bestsellers), "New" (on new arrivals)

---

### 8.10 New Arrivals Product Slider

**Section ID**: `product_slider2_py3VkF`
**Type**: Identical structure to Bestsellers
**Lines**: 11090-14810

**Section Header**: "New Arrivals" + "Explore All ->" button
**Uses**: Same `<product-recommendations>` custom element, same card structure, same swatch system
**JS**: `product-slider-2.js` (separate script from bestsellers)
**Padding**: `0` top, `4.8rem/6.4rem/8.8rem` bottom (responsive)

---

### 8.11 Where The Pros Shop (Testimonials)

**Section ID**: `where_pros_shop_6EGWXq`
**Type**: Swiper carousel of professional interior designer testimonials

```html
<div class="pro-shop">
  <div class="container">
    <div class="pros-shop"> <!-- Swiper container -->
      <h2 class="h2">Where The Pros Shop</h2>
      <div class="swiper-wrapper">
        <div class="swiper-slide">
          <img src="...shelley-ferguson.jpg">
          <div class="pro-info vcenter">
            <h3>"Quote text..."</h3>
            <p>Name | Company</p>
          </div>
        </div>
      </div>
      <div class="swiper-pagination"></div>
    </div>
  </div>
</div>
```

**Testimonials (5 pros)**:

| # | Name | Company | Quote (summary) |
|---|---|---|---|
| 1 | Shelley Ferguson | SF Studio | "Love the range of art... suit different aesthetics" |
| 2 | Melissa Greenough | Eterno Interiors | "Made my job so easy... affordable for everyone" |
| 3 | Gaby Muir | Finer Homes | "Extensive and ever-expanding selection... highly recommend" |
| 4 | Vanessa Webb | Dress My Nest | "So simple to source pieces... game changer" |
| 5 | Di Simpson | Interior Designer | "Extensive selection... interior designer's dream" |

**Swiper Config**:
```js
{
  loop: true,
  slidesPerView: 1,
  speed: 1000,
  autoplay: { delay: 6000, disableOnInteraction: false },
  pagination: { el: '.swiper-pagination', type: 'bullets' }
}
```

**Layout**: Each slide is image (professional's photo) + quote + attribution, side-by-side. Pagination bullets visible, nav arrows commented out.

---

### 8.12 UGC — "Our Art In Your Homes"

**Section ID**: `ugc_YydDHG`
**Type**: 4-column grid of customer-submitted videos with poster images

```html
<div class="ugc-videos">
  <div class="container">
    <div class="row">
      <div class="col-md-8"><h3>Our Art In Your Homes</h3></div>
    </div>
    <div class="row row-eq-height">
      <!-- 4 video cards, each col-6 col-md-3 -->
      <div class="col-6 col-md-3">
        <div class="video-container">
          <video class="custom-video" poster="...ugc-4.jpg">
            <source src="...m3u8" type="application/x-mpegURL">
            <source src="...HD-1080p.mp4" type="video/mp4">
          </video>
          <button class="play-button">
            <img src=".../play-btn.png">
          </button>
        </div>
        <p><strong>Customer Name</strong>, City</p>
      </div>
    </div>
  </div>
</div>
```

**Customers Featured**:

| # | Name | Location |
|---|---|---|
| 1 | Stephanie | Invercargill |
| 2 | Katrina | Auckland |
| 3 | Leigh | Auckland |
| 4 | Brogan | Auckland |

**Behavior**: Videos load with poster image + play button overlay. On click, play button hides, video gets `controls` attribute and plays. Custom JS at bottom of page handles this.

**Grid**: 2 columns on mobile (`col-6`), 4 columns on desktop (`col-md-3`)

---

### 8.13 Reviews — "Take It From Those In The Know"

**Section ID**: `reviews_8NLtVh`
**Type**: Swiper carousel of text review cards

**Aggregate Rating**: Judge.me 4.95/5 from 5,455 reviews (displayed as "5.0/5")

```html
<div class="popmotif-reviews">
  <div class="container">
    <h3 class="pm-reviews-heading">Take It From Those In The Know</h3>
    <!-- Judge.me aggregate widget -->
    <div class="reviews-slider"> <!-- Swiper -->
      <div class="swiper-wrapper">
        <div class="swiper-slide pm-review">
          <img src=".../stars.png"> <!-- 5-star image -->
          <h3>Review Title</h3>
          <p>Review body text...</p>
          <div class="review-btm">
            <p class="rev-person">Name, <span></span></p>
          </div>
        </div>
      </div>
      <div class="review-nav">
        <div class="swiper-button-prev"><svg><!-- left arrow --></svg></div>
        <div class="swiper-button-next"><svg><!-- right arrow --></svg></div>
      </div>
    </div>
  </div>
</div>
```

**Reviews (11 cards)**:

| # | Reviewer | Title |
|---|---|---|
| 1 | Darren F | Quality of the prints is amazing! |
| 2 | Jane B | I am in love with my print |
| 3 | Jillian C | Not enough stores like Pop Motif |
| 4 | Kim L | Customer service master class! |
| 5 | Ellie C | Top quality and stylish |
| 6 | Hamish L | Absolutely delighted |
| 7 | Adrienne W. | Pin-sharp detail on beautiful textured paper |
| 8 | Helena N. | Smitten |
| 9 | Kasey | Absolutely Gorgeous |
| 10 | Charlotte H. | Great print and framing |
| 11 | Robyn W. | The prints and framing are all top quality |

**Swiper Config**:
```js
{
  loop: true,
  spaceBetween: 20,
  navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
  breakpoints: {
    0:   { slidesPerView: 1.3, spaceBetween: 10 },
    520: { slidesPerView: 4, spaceBetween: 20 }
  }
}
```

**Navigation**: Prev/Next SVG arrow buttons (no pagination dots)

---

### 8.14 Footer

**Structure**:
```
footer.footer.color-background-1
+-- footer__content-top
|   +-- Logo (pop-motif.svg 185px)
|   +-- Column: "Shop" (accordion on mobile, flat list on desktop)
|   |   +-- Shop All -> /collections/art-prints-nz
|   |   +-- Best Sellers -> /collections/best-selling-art-prints
|   |   +-- New In -> /collections/new-art-prints
|   |   +-- Gift Cards -> /products/gift-card
|   +-- Column: "Customer Care"
|   |   +-- Contact Us -> /pages/contact-pop-motif
|   |   +-- Shipping and Delivery -> /pages/domestic-shipping
|   |   +-- Returns and Exchanges -> /pages/returns
|   |   +-- 10-Year Warranty -> /pages/our-10-year-warranty
|   |   +-- FAQ -> /pages/faq-1
|   +-- Column: "About us"
|   |   +-- Our Story -> /pages/our-story
|   |   +-- Customer Reviews -> /pages/reviews
|   |   +-- Commercial -> /pages/commercial
|   |   +-- Trade -> /pages/wholesale-trade
|   |   +-- Artist Submissions -> /pages/artist-submissions
|   +-- Newsletter signup block
|       +-- Heading: "Stay In The Know"
|       +-- Text: "Be the first to know... 10% off first order"
|       +-- Email input (pattern validated)
|       +-- Submit: "Join The List" (button--primary)
+-- footer__content-middle
|   +-- Currency selector (disclosure dropdown, 45+ countries, all NZD)
|   +-- Social links
|       +-- Facebook -> facebook.com/pages/Pop-Motif/551721298174830
|       +-- Instagram -> instagram.com/pop_motif/
+-- footer__content-bottom
    +-- (c) 2026 Pop Motif
    +-- Privacy policy -> /policies/privacy-policy
    +-- Terms of service -> /policies/terms-of-service
```

**Footer pattern**: Each menu column has TWO versions:
1. `<div class="accordion">` — mobile (collapsible `<details>`)
2. `<div class="footer-block--menu">` — desktop (always visible)

CSS toggles visibility by breakpoint.

---

### 8.15 Cart Drawer

**Type**: Slide-in drawer (right side), custom element `<cart-drawer>`

```
cart-drawer.drawer.is-empty
+-- CartDrawer-Overlay (backdrop)
+-- drawer__inner
    +-- drawer__header
    |   +-- h2: "My Shopping Bag"
    |   +-- Close button (x SVG)
    +-- drawer__inner-empty
    |   +-- p: "You have no art in your shopping bag."
    |   +-- a: "Shop Art" -> /collections/all
    +-- cart-drawer-items (form)
    +-- drawer__footer
        +-- Shipping: "Free within New Zealand"
        +-- Subtotal: $0.00
        +-- CHECKOUT button (disabled when empty)
```

---

## 9. Key Patterns & Implementation Notes

### Responsive Image Pattern
Every image uses Shopify's CDN image transform with srcset:
```html
<img srcset="...&width=165 165w, ...&width=360 360w, ...&width=535 535w,
             ...&width=750 750w, ...&width=1070 1070w"
     sizes="(min-width: 990px) calc(25vw - 2rem), (min-width: 750px) 33vw, 50vw"
     loading="lazy" />
```

### Video Pattern
Two types:
1. **Background/ambient**: `autoplay loop muted playsinline` + class `always-autoplay no-autoplay-control`
2. **User-initiated**: poster image + play button overlay -> JS adds `controls` and calls `.play()`

### Swiper Patterns
Three distinct slider types:
1. **Collection/Artist carousel**: standard Swiper with prev/next arrows
2. **Product slider**: `<product-recommendations>` custom element wrapping Swiper
3. **Testimonial/Review slider**: Swiper with loop, auto-advance (pros), or manual nav (reviews)

### Color Scheme Application
Sections apply color scheme via CSS class: `color-background-1` (light), `color-background-2`, `color-background-3` (dark), `color-background-4` (darkest). The `data-scheme="light"` attribute on `<html>` activates the correct variable set.

### Section Spacing Pattern
Each section gets a unique padding class:
```css
.section-{section_id}-padding {
  padding-top: Xrem;
  padding-bottom: Yrem;
}
@media (min-width: 750px) { ... }
@media (min-width: 1440px) { ... }
```

### Custom Elements (Web Components)
- `<product-recommendations>` — AJAX-loaded product grids
- `<cart-drawer>` — slide-in shopping cart
- `<cart-drawer-items>` — live cart item list
- `<localization-form>` — country/currency selector
- `<predictive-search>` — search suggestions

---

## 10. SEO & Meta

| Property | Value |
|---|---|
| Title | Gallery Quality Art Prints & Custom Framing NZ | Pop Motif |
| Description | Shop our curated collection of stylish gallery quality art without the gallery price tag. 5,000+ five star reviews. Free NZ shipping, 10-year warranty. |
| OG Type | website |
| Canonical | https://popmotif.com/ |
| Hreflang | x-default + en + en-AU |
| Support email | support@popmotif.com |

---

## 11. Countries Supported (Footer Currency Selector)

Australia, Austria, Belgium, Canada, Cook Islands, Denmark, Estonia, Fiji, Finland, France, French Polynesia, Germany, Greenland, Hong Kong SAR, Hungary, Iceland, Indonesia, Ireland, Italy, Japan, Latvia, Lithuania, Luxembourg, Malaysia, Monaco, Netherlands, New Caledonia, **New Zealand**, Norway, Philippines, Poland, Portugal, Samoa, Saudi Arabia, Singapore, South Africa, South Korea, Spain, Sweden, Switzerland, Taiwan, Tonga, United Arab Emirates, United Kingdom, United States, Vanuatu

All display NZD as currency.
