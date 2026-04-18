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

  // Intercept all network responses to find the AJAX call that loads grant data
  const ajaxResponses = [];
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    // Capture any XHR/fetch responses that might contain grant data
    if (
      url.includes('AUC') ||
      url.includes('fscm') ||
      contentType.includes('json') ||
      contentType.includes('xml')
    ) {
      try {
        const text = await response.text();
        if (text.length > 100 && text.length < 500000) {
          ajaxResponses.push({ url, contentType, body: text.slice(0, 2000) });
        }
      } catch (e) {}
    }
  });

  console.log('Navigating...');
  try {
    await page.goto(NYS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (e) {
    console.log('Nav note:', e.message);
  }

  // Wait longer for AJAX to fire
  await new Promise(r => setTimeout(r, 10000));

  console.log(`Captured ${ajaxResponses.length} AJAX responses`);
  ajaxResponses.forEach((r, i) => {
    console.log(`\n--- Response ${i + 1} ---`);
    console.log('URL:', r.url);
    console.log('Type:', r.contentType);
    console.log('Body preview:', r.body.slice(0, 300));
  });

  // Also try scrolling/clicking to trigger lazy load
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 3000));

  // Check if content appeared after scroll
  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage text preview:', pageText.slice(0, 1000));

  // Look for any grant-like text patterns on the page
  const grantPatterns = pageText.match(/[A-Z]{2,4}[\-0-9][A-Z0-9\-]{3,}/g) || [];
  console.log('Grant ID patterns found:', grantPatterns.slice(0, 20));

  await browser.close();

  // Try to parse grant data from AJAX responses
  const grants = [];
  for (const r of ajaxResponses) {
    if (r.body.includes('Grant') || r.body.includes('grant') || r.body.includes('AUC')) {
      console.log('\nPotential grant data in:', r.url);
      console.log(r.body.slice(0, 500));
    }
  }

  const output = { grants, fetched: new Date().toISOString(), count: grants.length, debug: { ajaxCount: ajaxResponses.length } };
  fs.writeFileSync(path.join(process.cwd(), 'nys-grants.json'), JSON.stringify(output, null, 2));
  console.log('Done');
})();
