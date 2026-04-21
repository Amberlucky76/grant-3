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

  // Click Search
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[type=submit], button, a'));
    const btn = btns.find(b => (b.value || b.innerText || '').trim().toLowerCase() === 'search');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 7000));

  // Log the actual header row so we know column order
  const headers = await page.evaluate(() => {
    for (const row of document.querySelectorAll('tr')) {
      const ths = row.querySelectorAll('th');
      if (ths.length > 2) {
        return Array.from(ths).map(th => th.innerText.trim());
      }
      // Also check td rows that look like headers
      const tds = row.querySelectorAll('td');
      if (tds.length > 2) {
        const texts = Array.from(tds).map(td => td.innerText.trim());
        if (texts[0].toLowerCase().includes('event')) return texts;
      }
    }
    return [];
  });
  console.log('Headers:', JSON.stringify(headers));

  const grants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Find the header row first to know column positions
    let colEventId = 0, colAgency = 1, colTitle = 2, colStatus = 3, colEligibility = 4, colDueDate = 7;

    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 4) continue;

      const texts = cells.map(c => c.innerText.trim().replace(/\s+/g, ' ').split('\n')[0]);

      // Detect header row and skip it
      if (texts[0].toLowerCase().includes('event id') || texts[2]?.toLowerCase().includes('grant opportunity')) continue;

      const id = texts[colEventId];
      const agency = texts[colAgency];
      const title = texts[colTitle];
      const status = texts[colStatus];
      const eligibility = texts[colEligibility] || '';
      const dueDate = texts[colDueDate] || texts[6] || '';

      // Validate: real Event IDs are short alphanumeric codes
      if (!id || id.length > 25 || !/^[A-Z]/.test(id)) continue;
      if (!title || title.length < 4 || title.length > 150) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      // Only include if eligible for governmental entities
      const eligLower = eligibility.toLowerCase();
      if (eligLower && !eligLower.includes('governmental') && !eligLower.includes('government')) {
        console.log(`SKIPPED (eligibility): [${id}] ${title} | elig: ${eligibility}`);
        continue;
      }

      const anchor = cells[colTitle]?.querySelector('a');
      const link = 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

      console.log(`KEEPING: [${id}] ${title} | elig: ${eligibility}`);
      results.push({ id, agency, title, status, eligibility, dueDate, link, source: 'NYS' });
    }
    return results;
  });

  await browser.close();

  console.log(`Found ${grants.length} governmental grants`);
  grants.forEach(g => console.log(` - [${g.id}] ${g.title} | ${g.eligibility}`));

let manualGrants = [];
const outputPath = path.join(process.cwd(), 'nys-grants.json');
if (fs.existsSync(outputPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    // Keep only entries flagged as manual (scraper entries will be replaced)
    manualGrants = (existing.grants || []).filter(g => g.manual === true);
    console.log(`Preserving ${manualGrants.length} manual entries`);
  } catch(e) {
    console.log('Could not read existing file:', e.message);
  }
}

// Merge: scraped grants first, manual ones appended after
const allGrants = [...grants, ...manualGrants];
const output = { grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length };
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log('Saved.');
