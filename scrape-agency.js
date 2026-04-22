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

// ── EFC ──────────────────────────────────────────────────────
// efc.ny.gov/apply — static HTML table: Program | Description | Deadline
async function scrapeEFC() {
  console.log('Scraping EFC...');
  const res = await fetch('https://efc.ny.gov/apply');
  const html = await res.text();

  const grants = [];
  // Match table rows: <tr><td><a href="...">Title</a></td><td>desc</td><td>deadline</td></tr>
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
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

    if (!title || title.length < 4) continue;
    // Skip financing programs (SRF loans), keep grants
    if (description.toLowerCase().includes('low-cost financing') || description.toLowerCase().includes('revolving fund')) continue;

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
// parks.ny.gov/grants — static HTML sidebar list of grant program links
async function scrapeParks() {
  console.log('Scraping NYS Parks...');
  const res = await fetch('https://parks.ny.gov/grants');
  const html = await res.text();

  const grants = [];
  // The grants are listed as <a href="/grants/program-name">Program Name</a> in the sidebar nav
  const linkRe = /<a[^>]+href="(\/grants\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const title = stripHtml(match[2]);
    if (!title || title.length < 4) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    const url = 'https://parks.ny.gov' + href;
    grants.push({
      id: 'parks-' + href.replace('/grants/', '').replace(/[^a-z0-9]/g, '-').slice(0, 30),
      title,
      agency: 'NYS Office of Parks, Recreation & Historic Preservation',
      status: 'Available',
      dueDate: '',
      link: url,
      source: 'NYS Parks',
    });
  }

  // Also catch DASNY-hosted parks grants linked from this page
  const dasnyRe = /<a[^>]+href="(https:\/\/www\.dasny\.org\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = dasnyRe.exec(html)) !== null) {
    const title = stripHtml(match[2]);
    if (!title || title.length < 4 || seen.has(match[1])) continue;
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
// hcr.ny.gov/grant-partners — static HTML list of named programs with <a> links
async function scrapeHCR() {
  console.log('Scraping HCR...');
  const res = await fetch('https://hcr.ny.gov/grant-partners');
  const html = await res.text();

  const grants = [];
  const seen = new Set();
  // Programs are listed as bold links: <a href="/program-name"><strong>Program Name</strong></a>
  // or <strong><a href="...">Program Name</a></strong>
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>\s*(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*<\/a>/gi;

  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const title = stripHtml(match[2]);
    if (!title || title.length < 4) continue;
    if (title.toLowerCase().includes('scroll') || title.toLowerCase().includes('click here')) continue;
    if (seen.has(title)) continue;
    seen.add(title);

    const url = resolveUrl(href, 'https://hcr.ny.gov');
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
// dasny.org/grants-administration — JS-rendered, needs Puppeteer
async function scrapeDASNY(page) {
  console.log('Scraping DASNY...');
  try {
    await page.goto('https://www.dasny.org/about/what-we-do/grants-administration', {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await new Promise(r => setTimeout(r, 3000));

    const grants = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Each grant program is under an <h3> heading
      const headings = Array.from(document.querySelectorAll('h3, h2'));
      for (const h of headings) {
        const title = (h.innerText || '').trim();
        if (!title || title.length < 4) continue;
        if (seen.has(title)) continue;
        seen.add(title);

        // Look for deadline info and link in the following content
        let dueDate = '';
        let link = 'https://www.dasny.org/about/what-we-do/grants-administration';
        let el = h.nextElementSibling;
        let text = '';
        for (let i = 0; i < 6 && el; i++) {
          text += ' ' + (el.innerText || '');
          // Grab first http link
          const a = el.querySelector('a[href]');
          if (a && a.href && a.href.startsWith('http') && !a.href.includes('javascript') && link.includes('dasny.org/about')) {
            link = a.href;
          }
          el = el.nextElementSibling;
        }
        // Try to extract a date
        const dateMatch = text.match(/([A-Z][a-z]+ \d{1,2},? \d{4})/);
        if (dateMatch) dueDate = dateMatch[1];

        results.push({ title, dueDate, link });
      }
      return results;
    });

    const formatted = grants
      .filter(g => g.title.length > 4)
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

  // Run all scrapers
  const [efc, parks, hcr, dasny] = await Promise.all([
    scrapeEFC(),
    scrapeParks(),
    scrapeHCR(),
    scrapeDASNY(page),
  ]);

  await browser.close();

  const scraped = [...efc, ...parks, ...hcr, ...dasny];
  console.log('\nTotal agency grants scraped: ' + scraped.length);

  // Load existing agency-grants.json and preserve manual entries
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
  scraped.forEach(g => console.log(' [' + g.source + '] ' + g.title));
})();
