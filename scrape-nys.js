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

  const grants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Real Event IDs are short and follow patterns like: AGM-WFD26, FPIG20, EVT0000003, EJCIG-R13
    // They are never longer than ~20 chars and don't contain newlines
    function isValidEventId(id) {
      if (!id || id.length > 25 || id.includes('\n')) return false;
      // Must start with letters and contain alphanumeric/dash chars only
      return /^[A-Z][A-Z0-9\-]{1,24}$/.test(id.trim());
    }

    // Real grant titles are typically under 120 chars and don't repeat themselves
    function isValidTitle(title) {
      if (!title || title.length < 5 || title.length > 150) return false;
      if (title.includes('\n')) return false;
      const skipWords = ['event id', 'grant opportunity', 'funding agency', 'status',
        'eligibility', 'availability date', 'due date', 'search criteria', 'search results'];
      return !skipWords.some(w => title.toLowerCase().includes(w));
    }

    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 4) continue;

      // Each cell should have clean single-line text
      const id = cells[0]?.innerText?.trim().split('\n')[0] || '';
      const agency = cells[1]?.innerText?.trim().split('\n')[0] || '';
      const title = cells[2]?.innerText?.trim().split('\n')[0] || '';
      const status = cells[3]?.innerText?.trim().split('\n')[0] || '';
      const eligibility = cells[4]?.innerText?.trim().split('\n')[0] || '';
      const availDate = cells[5]?.innerText?.trim().split('\n')[0] || '';
      const dueDate = cells[7]?.innerText?.trim().split('\n')[0] || cells[6]?.innerText?.trim().split('\n')[0] || '';

      if (!isValidEventId(id)) continue;
      if (!isValidTitle(title)) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      const anchor = cells[2]?.querySelector('a');
      const link = anchor?.href || 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

      results.push({ id, agency, title, status, eligibility, availDate, dueDate, link, source: 'NYS' });
    }

    return results;
  });

  await browser.close();

  console.log(`Found ${grants.length} grants`);
  grants.forEach(g => console.log(` - [${g.id}] ${g.title} | ${g.status} | due: ${g.dueDate}`));

  const output = { grants, fetched: new Date().toISOString(), count: grants.length };
  fs.writeFileSync(path.join(process.cwd(), 'nys-grants.json'), JSON.stringify(output, null, 2));
  console.log('Saved.');
})();
