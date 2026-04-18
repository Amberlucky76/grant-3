const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const NYS_URL = 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

  console.log('Navigating to NYS grants page...');
  await page.goto(NYS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for the grants table to appear
  try {
    await page.waitForSelector('table', { timeout: 20000 });
  } catch (e) {
    console.log('Table not found within timeout, trying anyway...');
  }

  // Give JS a moment to finish rendering
  await new Promise(r => setTimeout(r, 3000));

  console.log('Extracting grant data...');
  const grants = await page.evaluate(() => {
    const results = [];

    // Find all table rows
    const rows = document.querySelectorAll('tr');

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) continue;

      const id = cells[0]?.innerText?.trim();
      const agency = cells[1]?.innerText?.trim();
      const titleCell = cells[2];
      const title = titleCell?.innerText?.trim();
      const status = cells[3]?.innerText?.trim();
      const eligibility = cells[4]?.innerText?.trim() || '';

      // Get the link from the title cell
      const anchor = titleCell?.querySelector('a');
      let link = anchor?.href || '';
      if (!link && anchor) {
        link = 'https://esupplier.sfs.ny.gov' + anchor.getAttribute('href');
      }

      // Filter out header rows and empty rows
      if (!id || !title || title.toLowerCase() === 'grant opportunity') continue;
      if (id.toLowerCase() === 'event id') continue;

      results.push({
        id,
        agency,
        title,
        status,
        eligibility,
        link: link || 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL',
        source: 'NYS',
      });
    }

    return results;
  });

  await browser.close();

  console.log(`Found ${grants.length} grants`);

  // Write to nys-grants.json in the repo root
  const output = {
    grants,
    fetched: new Date().toISOString(),
    count: grants.length,
  };

  const outPath = path.join(process.cwd(), 'nys-grants.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Saved to ${outPath}`);
})();
