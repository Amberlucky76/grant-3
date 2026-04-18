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

  console.log('Navigating to NYS grants page...');
  try {
    await page.goto(NYS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (e) {
    console.log('Navigation note:', e.message);
  }

  console.log('Waiting for PeopleSoft to render...');
  await new Promise(r => setTimeout(r, 8000));

  const html = await page.content();
  console.log('Page HTML length:', html.length);
  console.log('HTML preview:', html.slice(0, 1000));

  const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);
  const rowCount = await page.evaluate(() => document.querySelectorAll('tr').length);
  console.log(`Tables: ${tableCount}, Rows: ${rowCount}`);

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a'))
      .map(a => ({ text: a.innerText?.trim(), href: a.href }))
      .filter(l => l.text && l.text.length > 5)
  );
  console.log('Links:', JSON.stringify(links.slice(0, 20)));

  const grants = await page.evaluate(() => {
    const results = [];

    // Strategy 1: standard table rows
    for (const row of document.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) continue;
      const id = cells[0]?.innerText?.trim();
      const agency = cells[1]?.innerText?.trim();
      const titleCell = cells[2];
      const title = titleCell?.innerText?.trim();
      const status = cells[3]?.innerText?.trim() || '';
      const eligibility = cells[4]?.innerText?.trim() || '';
      const anchor = titleCell?.querySelector('a');
      const link = anchor?.href || '';
      if (!id || !title || id === 'Event ID' || title === 'Grant Opportunity') continue;
      if (title.length < 4) continue;
      results.push({ id, agency, title, status, eligibility, link, source: 'NYS' });
    }
    if (results.length > 0) return results;

    // Strategy 2: any div with a link that looks like a grant row
    for (const el of document.querySelectorAll('div[class*="row"], div[class*="grid"], li')) {
      const anchor = el.querySelector('a');
      if (!anchor) continue;
      const title = anchor.innerText?.trim();
      if (!title || title.length < 5) continue;
      results.push({ id: '', agency: '', title, status: '', eligibility: '', link: anchor.href, source: 'NYS' });
    }

    return results;
  });

  await browser.close();

  console.log(`Found ${grants.length} grants`);
  const output = { grants, fetched: new Date().toISOString(), count: grants.length };
  fs.writeFileSync(path.join(process.cwd(), 'nys-grants.json'), JSON.stringify(output, null, 2));
  console.log('Done');
})();
