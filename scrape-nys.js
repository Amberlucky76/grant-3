const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const NYS_URL = 'https://esupplier.sfs.ny.gov/psc/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL?PortalActualURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentProvider=ERP&PortalCRefLabel=Search%20for%20Grant%20Opportunities&PortalRegistryName=SUPPLIER&PortalServletURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsp%2ffscm%2f&PortalURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2f&PortalHostNode=ERP&NoCrumbs=yes&PortalKeyStruct=yes';

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
  await new Promise(r => setTimeout(r, 5000));

  // Click Search button
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type=submit], button, a'));
      const btn = btns.find(b => (b.value || b.innerText || '').trim().toLowerCase() === 'search');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 7000));
    console.log('Clicked search, waiting for results...');
  } catch (e) {
    console.log('Search click note:', e.message);
  }

  // Extract grants by parsing the grid properly
  const grants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // PeopleSoft renders results in a grid - each row is a <tr> with specific cell structure
    // Columns: Event ID | Funding Agency | Grant Opportunity | Status | Eligibility | Availability Date | Anticipated Release Date | Due Date
    const rows = document.querySelectorAll('tr');

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 4) continue;

      // Get text of each cell cleanly
      const cellTexts = cells.map(c => c.innerText?.trim().replace(/\s+/g, ' ') || '');

      const id = cellTexts[0];
      const agency = cellTexts[1];
      const title = cellTexts[2];
      const status = cellTexts[3];
      const eligibility = cellTexts[4] || '';
      const availDate = cellTexts[5] || '';
      const releaseDate = cellTexts[6] || '';
      const dueDate = cellTexts[7] || '';

      // Skip header rows and empty rows
      const skipTitles = ['event id', 'grant opportunity', 'funding agency', 'status', 'eligibility',
        'availability date', 'anticipated release date', 'due date', 'search criteria'];
      if (!id || !title || title.length < 4) continue;
      if (skipTitles.some(s => title.toLowerCase().includes(s))) continue;
      if (skipTitles.some(s => id.toLowerCase().includes(s))) continue;
      if (seen.has(id + title)) continue;
      seen.add(id + title);

      // Get the link from the title cell
      const anchor = cells[2]?.querySelector('a');
      const link = anchor?.href || 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

      results.push({
        id,
        agency,
        title,
        status,
        eligibility,
        availDate,
        dueDate: dueDate || releaseDate,
        link,
        source: 'NYS',
      });
    }
    return results;
  });

  await browser.close();

  console.log(`Found ${grants.length} grants`);
  grants.forEach(g => console.log(` - [${g.id}] ${g.title} | ${g.status} | due: ${g.dueDate}`));

  const output = { grants, fetched: new Date().toISOString(), count: grants.length };
  fs.writeFileSync(path.join(process.cwd(), 'nys-grants.json'), JSON.stringify(output, null, 2));
  console.log('Saved nys-grants.json');
})();
