const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const NYS_URL = 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating...');
  try {
    await page.goto(NYS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (e) {
    console.log('Nav note:', e.message);
  }

  await new Promise(r => setTimeout(r, 8000));

  // Log full HTML so we can see exactly what PeopleSoft renders
  const html = await page.content();
  fs.writeFileSync('/tmp/nys-page.html', html);
  console.log('HTML length:', html.length);

  // Log all table HTML
  const tables = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('table')).map((t, i) => ({
      index: i,
      rows: t.rows.length,
      html: t.outerHTML.slice(0, 500),
    }));
  });
  console.log('Tables:', JSON.stringify(tables));

  // Try to find rows that look like grants:
  // Real grant rows have an Event ID pattern (letters+numbers) and a link with AUC in the href
  const grants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Look for links that go to grant detail pages
    const allLinks = document.querySelectorAll('a[href*="AUC"], a[href*="auc"], a[href*="BID"], a[href*="bid"]');
    console.log('Grant-like links found:', allLinks.length);

    for (const a of allLinks) {
      const title = a.innerText?.trim();
      const href = a.href;

      // Skip navigation items
      const navTerms = ['favorites', 'main menu', 'new window', 'sign in', 'skip', 'search', 'refine', 'popup', 'sort'];
      if (!title || title.length < 5) continue;
      if (navTerms.some(n => title.toLowerCase() === n)) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      // Try to get surrounding row data
      const row = a.closest('tr');
      let id = '', agency = '', status = '', eligibility = '';

      if (row) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          id = cells[0]?.innerText?.trim() || '';
          agency = cells[1]?.innerText?.trim() || '';
          status = cells[3]?.innerText?.trim() || '';
          eligibility = cells[4]?.innerText?.trim() || '';
        }
      }

      // Only include if it looks like a real grant (has an agency code or ID)
      // Event IDs typically look like: AGM-WFD26, FPIG20, VT0000003 etc
      const looksLikeGrantId = /^[A-Z]{2,}[\-0-9]/.test(id) || id.length > 3;
      const looksLikeNavLink = ['favorites', 'main menu', 'new window', 'search', 'refine'].includes(title.toLowerCase());

      if (looksLikeNavLink) continue;
      if (!looksLikeGrantId && !agency) continue;

      results.push({
        id: id || '',
        agency: agency || '',
        title,
        status: status || 'Available',
        eligibility: eligibility || '',
        link: href,
        source: 'NYS',
      });
    }

    return results;
  });

  await browser.close();

  console.log(`Found ${grants.length} grants`);
  grants.forEach(g => console.log(` - [${g.id}] ${g.title} | ${g.agency} | ${g.status}`));

  const output = { grants, fetched: new Date().toISOString(), count: grants.length };
  fs.writeFileSync(path.join(process.cwd(), 'nys-grants.json'), JSON.stringify(output, null, 2));
  console.log('Saved nys-grants.json');
})();
