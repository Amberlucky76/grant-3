const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ── HELPERS ──────────────────────────────────────────────────
function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function resolveUrl(href, base) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return null; }
}

// Returns true if the date string is in the past
function isPast(dateStr) {
  if (!dateStr) return false;
  const s = dateStr.toLowerCase();
  if (s.includes('rolling') || s.includes('ongoing') || s.includes('closed') || s.includes('open')) return false;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return false;
  return parsed < new Date();
}

// Navigation / chrome words that indicate a non-grant item
const NAV_JUNK = [
  'main navigation', 'custom log in', 'cloudflare', 'investor relations',
  'rfps & bids', 'rfps and bids', 'services', 'public information',
  'connect with us', 'careers', 'contact us', 'about', 'news', 'events',
  'skip to', 'log in', 'log out', 'sign in', 'toggle navigation',
  'capital grant programs administered by dasny:',
  'grant programs administered with other state',
];

function isJunk(title) {
  if (!title || title.length < 5) return true;
  const t = title.toLowerCase().trim();
  return NAV_JUNK.some(j => t === j || t.startsWith(j));
}

// ── EFC ──────────────────────────────────────────────────────
async function scrapeEFC() {
  console.log('Scraping EFC...');
  const res = await fetch('https://efc.ny.gov/apply');
  const html = await res.text();

  const grants = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cellMatch;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 2) continue;

    const linkMatch = linkRe.exec(cells[0]);
    if (!linkMatch) continue;

    const url = resolveUrl(linkMatch[1], 'https://efc.ny.gov');
    const title = stripHtml(linkMatch[2]);
    const description = stripHtml(cells[1]);
    const dueDate = cells[2] ? stripHtml(cells[2]) : '';

    if (isJunk(title)) continue;
    // Skip financing/loan programs, keep grants only
    if (description.toLowerCase().includes('low-cost financing') ||
        description.toLowerCase().includes('revolving fund')) continue;
    // Skip if deadline has passed
    if (isPast(dueDate)) { console.log('  EFC SKIP (past): ' + title); continue; }

    grants.push({
      id: 'efc-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
      title,
      agency: 'NYS Environmental Facilities Corporation',
      status: dueDate.toLowerCase().includes('closed') ? 'Closed' : 'Available',
      dueDate: dueDate.slice(0, 120),
      description: description.slice(0, 300),
      link: url || 'https://efc.ny.gov/apply',
      source: 'EFC',
    });
  }

  console.log('  EFC: ' + grants.length + ' grants');
  return grants;
}

// ── NYS PARKS ────────────────────────────────────────────────
async function scrapeParks() {
  console.log('Scraping NYS Parks...');
  const res = await fetch('https://parks.ny.gov/grants');
  const html = await res.text();

  const grants = [];
  const seen = new Set();

  // Only grab links that are under the grants sub-nav: href="/grants/..." 
  // but NOT the top-level /grants page itself
  const linkRe = /<a[^>]+href="(\/grants\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const title = stripHtml(match[2]);
    if (isJunk(title)) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    grants.push({
      id: 'parks-' + href.replace('/grants/', '').replace(/[^a-z0-9]/g, '-').slice(0, 40),
      title,
      agency: 'NYS Office of Parks, Recreation & Historic Preservation',
      status: 'Available',
      dueDate: '',
      link: 'https://parks.ny.gov' + href,
      source: 'NYS Parks',
    });
  }

  // Also grab DASNY-hosted parks grants (NY BRICKS, NY SWIMS) linked from this page
  const dasnyRe = /<a[^>]+href="(https:\/\/www\.dasny\.org\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = dasnyRe.exec(html)) !== null) {
    const title = stripHtml(match[2]);
    if (isJunk(title) || seen.has(match[1])) continue;
    seen.add(match[1]);
    grants.push({
      id: 'parks-dasny-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
      title,
      agency: 'NYS Parks / DASNY',
      status: 'Available',
      dueDate: '',
      link: match[1],
      source: 'NYS Parks',
    });
  }

  console.log('  Parks: ' + grants.length + ' grants');
  return grants;
}

// ── HCR ──────────────────────────────────────────────────────
async function scrapeHCR() {
  console.log('Scraping HCR...');
  const res = await fetch('https://hcr.ny.gov/grant-partners');
  const html = await res.text();

  const grants = [];
  const seen = new Set();

  // HCR grant programs are inside <strong> tags wrapping <a> links
  // e.g. [**Access to Home**](https://hcr.ny.gov/access-home)
  // In HTML: <strong><a href="/access-home">Access to Home</a></strong>
  // Only grab /hcr.ny.gov internal program links, not nav or external safelinks
  const re = /<strong>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/strong>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const title = stripHtml(match[2]);
    if (isJunk(title)) continue;
    if (seen.has(title)) continue;
    seen.add(title);

    // Resolve safelinks and relative URLs
    let url = href;
    const safeMatch = href.match(/url=([^&]+)/);
    if (safeMatch) {
      try { url = decodeURIComponent(safeMatch[1]); } catch {}
    }
    url = resolveUrl(url, 'https://hcr.ny.gov');
    if (!url) continue;

    grants.push({
      id: 'hcr-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
      title,
      agency: 'NYS Homes & Community Renewal',
      status: 'Available',
      dueDate: '',
      link: url,
      source: 'HCR',
    });
  }

  console.log('  HCR: ' + grants.length + ' grants');
  return grants;
}

// ── DASNY ─────────────────────────────────────────────────────
async function scrapeDASNY(page) {
  console.log('Scraping DASNY...');
  try {
    await page.goto('https://www.dasny.org/about/what-we-do/grants-administration', {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await new Promise(r => setTimeout(r, 3000));

    const grants = await page.evaluate(() => {
      const NAV_JUNK = [
        'main navigation', 'custom log in', 'cloudflare', 'investor relations',
        'rfps & bids', 'services', 'public information', 'connect with us',
        'careers', 'contact us', 'about', 'news', 'events', 'log in',
        'capital grant programs administered by dasny:',
        'grant programs administered with other state',
        'grant administration',
      ];

      function isJunk(title) {
        if (!title || title.length < 5) return true;
        const t = title.toLowerCase().trim();
        return NAV_JUNK.some(j => t === j || t.startsWith(j));
      }

      const results = [];
      const seen = new Set();

      // DASNY grant programs are under <h3> headings in the main content area
      // Find the main content div first to avoid nav headings
      const main = document.querySelector('main, .main-content, #main-content, article, .field--type-text-with-summary')
                   || document.body;

      const headings = Array.from(main.querySelectorAll('h3'));
      for (const h of headings) {
        const title = (h.innerText || '').trim();
        if (isJunk(title) || seen.has(title)) continue;
        seen.add(title);

        let dueDate = '';
        let link = 'https://www.dasny.org/about/what-we-do/grants-administration';
        let el = h.nextElementSibling;

        for (let i = 0; i < 8 && el; i++) {
          const text = el.innerText || '';
          // Look for date patterns
          const dateMatch = text.match(/([A-Z][a-z]+ \d{1,2},? \d{4})/);
          if (dateMatch && !dueDate) dueDate = dateMatch[1];
          // Grab first real http link (not nav, not mailto)
          const anchors = Array.from(el.querySelectorAll('a[href]'));
          for (const a of anchors) {
            if (a.href && a.href.startsWith('http') &&
                !a.href.includes('javascript') &&
                !a.href.includes('dasny.org/about') &&
                !a.href.includes('dasny.org/opportunities') &&
                !a.href.includes('dasny.org/news') &&
                link.includes('/grants-administration')) {
              link = a.href;
            }
          }
          el = el.nextElementSibling;
        }

        results.push({ title, dueDate, link });
      }
      return results;
    });

    const now = new Date();
    const formatted = grants
      .filter(g => !isJunk(g.title))
      .filter(g => {
        if (!g.dueDate) return true;
        const d = new Date(g.dueDate);
        if (isNaN(d.getTime())) return true;
        if (d < now) { console.log('  DASNY SKIP (past): ' + g.title); return false; }
        return true;
      })
      .map(g => ({
        id: 'dasny-' + g.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
        title: g.title,
        agency: 'DASNY',
        status: 'Available',
        dueDate: g.dueDate,
        link: g.link,
        source: 'DASNY',
      }));

    console.log('  DASNY: ' + formatted.length + ' grants');
    return formatted;
  } catch (e) {
    console.log('  DASNY error: ' + e.message);
    return [];
  }
}

// ── MAIN ──────────────────────────────────────────────────────
(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const [efc, parks, hcr, dasny] = await Promise.all([
    scrapeEFC(),
    scrapeParks(),
    scrapeHCR(),
    scrapeDASNY(page),
  ]);

  await browser.close();

  const scraped = [...efc, ...parks, ...hcr, ...dasny];
  console.log('\nTotal agency grants: ' + scraped.length);
  scraped.forEach(g => console.log(' [' + g.source + '] ' + g.title + (g.dueDate ? ' · ' + g.dueDate : '')));

  const outputPath = path.join(process.cwd(), 'agency-grants.json');
  let manualGrants = [];
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries');
    } catch(e) {
      console.log('Could not read existing file:', e.message);
    }
  }

  const allGrants = [...scraped, ...manualGrants];
  const output = {
    grants: allGrants,
    fetched: new Date().toISOString(),
    count: allGrants.length,
    sources: { efc: efc.length, parks: parks.length, hcr: hcr.length, dasny: dasny.length },
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved to agency-grants.json');
})();
