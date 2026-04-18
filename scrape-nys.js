const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Use the inner iframe URL directly
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

  console.log('Navigating to inner page...');
  try {
    await page.goto(NYS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (e) {
    console.log('Nav note:', e.message);
  }

  await new Promise(r => setTimeout(r, 5000));

  // Log what's on the page
  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('Page text:', pageText);

  // Find and click the Search button
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type=submit], button, a'))
      .map(b => ({ text: b.innerText || b.value, id: b.id, name: b.name }))
      .filter(b => b.text || b.id)
      .slice(0, 20)
  );
  console.log('Buttons:', JSON.stringify(buttons));

  // Try clicking Search button
  try {
    const searchBtn = await page.$('input[value="Search"], #NY_AUC_SRCH_BTN, [id*="SEARCH"], [id*="search"]');
    if (searchBtn) {
      console.log('Found search button, clicking...');
      await searchBtn.click();
      await new Promise(r => setTimeout(r, 6000));
    } else {
      // Try by text
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('input[type=submit], button'));
        const searchBtn = btns.find(b => (b.value || b.innerText || '').toLowerCase().includes('search'));
        if (searchBtn) searchBtn.click();
      });
      await new Promise(r => setTimeout(r, 6000));
    }
  } catch (e) {
    console.log('Search click error:', e.message);
  }

  const afterText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('After search text:', afterText);

  // Now try to extract grants
  const grants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    for (const row of document.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) continue;

      const id = cells[0]?.innerText?.trim();
      const agency = cells[1]?.innerText?.trim();
      const titleCell = cells[2];
      const title = titleCell?.innerText?.trim();
      const status = cells[3]?.innerText?.trim() || '';
      const eligibility = cells[4]?.innerText?.trim() || '';
      const anchor = titleCell?.querySelector('a');
      const link = anchor?.href || '';

      if (!title || title.length < 4) continue;
      if (['event id', 'grant opportunity', 'funding agency', 'status', 'eligibility'].includes(title.toLowerCase())) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      results.push({ id: id || '', agency: agency || '', title, status, eligibility, link, source: 'NYS' });
    }
    return results;
  });

  console.log(`Found ${grants.length} grants`);
  grants.forEach(g => console.log(` - [${g.id}] ${g.title}`));

  await browser.close();

  const output = { grants, fetched: new Date().toISOString(), count: grants.length };
  fs.writeFileSync(path.join(process.cwd(), 'nys-grants.json'), JSON.stringify(output, null, 2));
  console.log('Saved nys-grants.json');
})();
