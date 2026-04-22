const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── HELPERS ──────────────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Check grant status using Puppeteer so JS-rendered content is visible
async function checkGrantStatus(browserPage, url) {
  try {
    await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const text = await browserPage.evaluate(() => (document.body && document.body.innerText || '').toLowerCase());
    if (text.includes('application period is closed') ||
        text.includes('applications are closed') ||
        text.includes('not currently accepting') ||
        text.includes('this program is closed') ||
        text.includes('closed for applications') ||
        text.includes('no longer accepting') ||
        text.includes('program is not currently') ||
        text.includes('applications are not currently') ||
        text.includes('deadline has passed') ||
        text.includes('currently closed') ||
        text.includes('not accepting applications') ||
        text.includes('funding is not available') ||
        text.includes('not available at this time')) {
      return 'Closed';
    }
    return 'Available';
  } catch(e) {
    return 'Available';
  }
}

function stripHtml(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function resolveUrl(href, base) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return null; }
}

function isPast(dateStr) {
  if (!dateStr) return false;
  const s = dateStr.toLowerCase();
  if (s.includes('rolling') || s.includes('ongoing')) return false;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return false;
  return parsed < new Date();
}

const NAV_JUNK = [
  'main navigation', 'custom log in', 'cloudflare', 'investor relations',
  'rfps & bids', 'rfps and bids', 'services', 'public information',
  'connect with us', 'careers', 'contact us', 'about', 'news', 'events',
  'log in', 'log out', 'sign in', 'toggle navigation', 'skip to',
  'capital grant programs administered by dasny:',
  'grant programs administered with other state',
  'grant administration',
];

function isJunk(title) {
  if (!title || title.length < 5) return true;
  const t = title.toLowerCase().trim();
  return NAV_JUNK.some(j => t === j || t.startsWith(j));
}

// ── EFC ──────────────────────────────────────────────────────
async function scrapeEFC() {
  console.log('Scraping EFC...');
  try {
    const html = await fetchHtml('https://efc.ny.gov/apply');
    console.log('  EFC html length: ' + html.length);

    const grants = [];
    const seen = new Set();

    // Each row: <tr><td><a href="...">Title</a></td><td>Description</td><td>Deadline</td></tr>
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[0];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]);
      if (cells.length < 2) continue;

      const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const lm = linkRe.exec(cells[0]);
      if (!lm) continue;

      const title = stripHtml(lm[2]);
      const url = resolveUrl(lm[1], 'https://efc.ny.gov');
      const desc = stripHtml(cells[1]);
      const dueDate = cells[2] ? stripHtml(cells[2]) : '';

      if (isJunk(title) || seen.has(title)) continue;
      seen.add(title);
      if (desc.toLowerCase().includes('low-cost financing') || desc.toLowerCase().includes('revolving fund')) continue;
      if (isPast(dueDate)) { console.log('  EFC SKIP past: ' + title); continue; }
      if (dueDate.toLowerCase().includes('currently closed') ||
          dueDate.toLowerCase().includes('application period is currently closed')) {
        console.log('  EFC SKIP closed: ' + title); continue;
      }

      const dueLower = dueDate.toLowerCase();
      const efcStatus = (dueLower.includes('closed') || dueLower.includes('not available') || dueLower.includes('not accepting')) ? 'Closed' : 'Available';
      grants.push({
        id: 'efc-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
        title, agency: 'NYS Environmental Facilities Corporation',
        status: efcStatus,
        dueDate: dueDate.slice(0, 120),
        description: desc.slice(0, 300),
        link: url || 'https://efc.ny.gov/apply',
        source: 'EFC',
      });
    }
    console.log('  EFC: ' + grants.length + ' grants');
    return grants;
  } catch(e) {
    console.log('  EFC error: ' + e.message);
    return [];
  }
}

// ── NYS PARKS ────────────────────────────────────────────────
async function scrapeParks() {
  console.log('Scraping NYS Parks...');
  try {
    const html = await fetchHtml('https://parks.ny.gov/grants');
    console.log('  Parks html length: ' + html.length);

    const grants = [];
    const seen = new Set();

    // Grant links are in the sidebar nav: href="/grants/program-name"
    const linkRe = /<a[^>]+href="(\/grants\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1];
      const title = stripHtml(m[2]);
      if (isJunk(title) || seen.has(href)) continue;
      seen.add(href);
      // Check surrounding HTML for closed/unavailable indicators
      const surroundingText = html.substring(Math.max(0, m.index - 200), m.index + 200).toLowerCase();
      const parksStatus = (surroundingText.includes('closed') || surroundingText.includes('not available') || surroundingText.includes('not currently')) ? 'Closed' : 'Available';
      grants.push({
        id: 'parks-' + href.replace('/grants/', '').replace(/[^a-z0-9]/g, '-').slice(0, 40),
        title, agency: 'NYS Office of Parks, Recreation & Historic Preservation',
        status: parksStatus, dueDate: '',
        link: 'https://parks.ny.gov' + href,
        source: 'NYS Parks',
      });
    }

    // DASNY-hosted parks grants (NY BRICKS, NY SWIMS)
    const dasnyRe = /<a[^>]+href="(https:\/\/www\.dasny\.org\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = dasnyRe.exec(html)) !== null) {
      const title = stripHtml(m[2]);
      if (isJunk(title) || seen.has(m[1])) continue;
      seen.add(m[1]);
      grants.push({
        id: 'parks-dasny-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
        title, agency: 'NYS Parks / DASNY',
        status: 'Available', dueDate: '',
        link: m[1], source: 'NYS Parks',
      });
    }

    return grants; // status checked later via browser
  } catch(e) {
    console.log('  Parks error: ' + e.message);
    return [];
  }
}

// ── HCR ──────────────────────────────────────────────────────
async function scrapeHCR() {
  console.log('Scraping HCR...');
  try {
    const html = await fetchHtml('https://hcr.ny.gov/grant-partners');
    console.log('  HCR html length: ' + html.length);

    const grants = [];
    const seen = new Set();

    // Try multiple patterns since HCR uses varied markup
    // Pattern 1: <strong><a href="...">Title</a></strong>
    // Pattern 2: <a href="..."><strong>Title</strong></a>
    // Pattern 3: plain bold links in the grant list section
    const patterns = [
      /<strong>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/strong>/gi,
      /<a[^>]+href="([^"]+)"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/a>/gi,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        let href = m[1];
        const title = stripHtml(m[2]);
        if (isJunk(title) || seen.has(title)) continue;
        seen.add(title);

        // Decode Microsoft SafeLink wrapper
        const safeMatch = href.match(/[?&]url=([^&]+)/);
        if (safeMatch) {
          try { href = decodeURIComponent(safeMatch[1]); } catch {}
        }
        const url = resolveUrl(href, 'https://hcr.ny.gov');
        if (!url) continue;

        grants.push({
          id: 'hcr-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
          title, agency: 'NYS Homes & Community Renewal',
          status: 'Available', dueDate: '',
          link: url, source: 'HCR',
        });
      }
    }

    return grants; // status checked later via browser
  } catch(e) {
    console.log('  HCR error: ' + e.message);
    return [];
  }
}

// ── DASNY ─────────────────────────────────────────────────────
async function scrapeDASNY(page) {
  console.log('Scraping DASNY...');
  try {
    await page.goto('https://www.dasny.org/about/what-we-do/grants-administration', {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await new Promise(r => setTimeout(r, 3000));

    // Log raw headings for debugging
    const debug = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('h2, h3'));
      return hs.map(h => h.innerText.trim()).filter(t => t.length > 2);
    });
    console.log('  DASNY headings found: ' + JSON.stringify(debug));

    const grants = await page.evaluate((NAV_JUNK) => {
      function isJunk(title) {
        if (!title || title.length < 5) return true;
        const t = title.toLowerCase().trim();
        return NAV_JUNK.some(j => t === j || t.startsWith(j));
      }

      const results = [];
      const seen = new Set();
      const main = document.querySelector('main, .main-content, #main-content, [role="main"], article') || document.body;
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
          const dateMatch = text.match(/([A-Z][a-z]+ \d{1,2},? \d{4})/);
          if (dateMatch && !dueDate) dueDate = dateMatch[1];

          const anchors = Array.from(el.querySelectorAll('a[href]'));
          for (const a of anchors) {
            if (a.href && a.href.startsWith('http') &&
                !a.href.includes('javascript') &&
                !a.href.includes('/about/what-we-do') &&
                !a.href.includes('/opportunities') &&
                !a.href.includes('/news') &&
                !a.href.includes('grantsmanagement.ny.gov/register') &&
                link.includes('/grants-administration')) {
              link = a.href;
            }
          }
          el = el.nextElementSibling;
        }
        results.push({ title, dueDate, link });
      }
      return results;
    }, NAV_JUNK);

    const now = new Date();
    const formatted = grants
      .filter(g => !isJunk(g.title))
      .filter(g => {
        if (!g.dueDate) return true;
        const d = new Date(g.dueDate);
        if (isNaN(d.getTime())) return true;
        if (d < now) { console.log('  DASNY SKIP past: ' + g.title + ' (' + g.dueDate + ')'); return false; }
        return true;
      })
      .map(g => ({
        id: 'dasny-' + g.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
        title: g.title, agency: 'DASNY',
        status: 'Available', dueDate: g.dueDate,
        link: g.link, source: 'DASNY',
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

  // Run static scrapers (EFC, Parks, HCR use https.get; DASNY uses browser)
  const [efc, parks, hcr] = await Promise.all([scrapeEFC(), scrapeParks(), scrapeHCR()]);
  const dasny = await scrapeDASNY(page);

  // Check status of Parks and HCR grants using Puppeteer (JS-rendered pages)
  const needsCheck = [...parks, ...hcr].filter(g => g.link && g.link.startsWith('http'));
  console.log('\nChecking status of ' + needsCheck.length + ' Parks/HCR grants...');
  const statusMap = {};
  for (const g of needsCheck) {
    const status = await checkGrantStatus(page, g.link);
    statusMap[g.id] = status;
    if (status === 'Closed') console.log('  CLOSED: [' + g.source + '] ' + g.title);
  }
  const parksChecked = parks.map(g => ({ ...g, status: statusMap[g.id] || g.status }));
  const hcrChecked = hcr.map(g => ({ ...g, status: statusMap[g.id] || g.status }));

  await browser.close();

  const scraped = [...efc, ...parksChecked, ...hcrChecked, ...dasny];
  console.log('\nTotal agency grants: ' + scraped.length);
  scraped.forEach(g => console.log(' [' + g.source + '] ' + g.title + (g.dueDate ? ' · ' + g.dueDate : '')));

  const outputPath = path.join(process.cwd(), 'agency-grants.json');
  let manualGrants = [];
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries');
    } catch(e) { console.log('Could not read existing file:', e.message); }
  }

  const allGrants = [...scraped, ...manualGrants];
  const output = {
    grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length,
    sources: { efc: efc.length, parks: parks.length, hcr: hcr.length, dasny: dasny.length },
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved to agency-grants.json');
})();
