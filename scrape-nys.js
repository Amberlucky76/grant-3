const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const NYS_URL = 'https://esupplier.sfs.ny.gov/psc/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL?PortalActualURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentProvider=ERP&PortalCRefLabel=Search%20for%20Grant%20Opportunities&PortalRegistryName=SUPPLIER&PortalServletURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsp%2ffscm%2f&PortalURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2f&PortalHostNode=ERP&NoCrumbs=yes&PortalKeyStruct=yes';

const SFS_BASE = 'https://esupplier.sfs.ny.gov';
const SFS_FALLBACK = 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to search page...');
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

  // Scrape the results table
  const rawGrants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const colEventId = 0, colAgency = 1, colTitle = 2, colStatus = 3, colEligibility = 4, colDueDate = 7;

    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 4) continue;

      const texts = cells.map(c => c.innerText.trim().replace(/\s+/g, ' ').split('\n')[0]);

      if (texts[0].toLowerCase().includes('event id') || texts[2]?.toLowerCase().includes('grant opportunity')) continue;

      const id = texts[colEventId];
      const agency = texts[colAgency];
      const title = texts[colTitle];
      const status = texts[colStatus];
      const eligibility = texts[colEligibility] || '';
      const dueDate = texts[colDueDate] || texts[6] || '';

      if (!id || id.length > 25 || !/^[A-Z]/.test(id)) continue;
      if (!title || title.length < 4 || title.length > 150) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      const eligLower = eligibility.toLowerCase();
      if (eligLower && !eligLower.includes('governmental') && !eligLower.includes('government')) {
        console.log('SKIPPED (eligibility): [' + id + '] ' + title);
        continue;
      }

      const anchor = cells[colTitle]?.querySelector('a');
      const titleHref = anchor ? anchor.getAttribute('href') : null;

      results.push({ id, agency, title, status, eligibility, dueDate, titleHref });
    }
    return results;
  });

  console.log('Found ' + rawGrants.length + ' governmental grants — fetching detail pages...');

  const grants = [];
  for (const g of rawGrants) {
    let announcementLink = SFS_FALLBACK;

    if (g.titleHref) {
      const detailUrl = g.titleHref.startsWith('http') ? g.titleHref : SFS_BASE + g.titleHref;
      console.log('Fetching detail for [' + g.id + ']: ' + detailUrl);
      try {
        await page.goto(detailUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        const found = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('td, th, label, span, div'));
          for (const el of allEls) {
            if (el.innerText && el.innerText.trim().toLowerCase().includes('announcement link')) {
              const parent = el.closest('tr') || el.parentElement;
              if (parent) {
                const link = parent.querySelector('a[href]');
                if (link) return link.href;
                const nextRow = parent.nextElementSibling;
                if (nextRow) {
                  const link2 = nextRow.querySelector('a[href]');
                  if (link2) return link2.href;
                }
              }
            }
          }
          // Fallback: first external link on the page
          const links = Array.from(document.querySelectorAll('a[href]'));
          const external = links.find(a =>
            a.href &&
            !a.href.includes('esupplier.sfs.ny.gov') &&
            !a.href.includes('javascript') &&
            a.href.startsWith('http')
          );
          return external ? external.href : null;
        });

        if (found) {
          announcementLink = found;
          console.log('  -> Found: ' + announcementLink);
        } else {
          console.log('  -> No announcement link found, using SFS detail URL');
          announcementLink = detailUrl;
        }
      } catch (e) {
        console.log('  -> Error for [' + g.id + ']: ' + e.message);
        announcementLink = g.titleHref ? (SFS_BASE + g.titleHref) : SFS_FALLBACK;
      }
    } else {
      console.log('[' + g.id + '] No title link in table, using fallback');
    }

    grants.push({
      id: g.id,
      agency: g.agency,
      title: g.title,
      status: g.status,
      eligibility: g.eligibility,
      dueDate: g.dueDate,
      link: announcementLink,
      source: 'NYS',
    });
  }

  await browser.close();

  console.log('\nDone. ' + grants.length + ' grants processed.');
  grants.forEach(g => console.log(' - [' + g.id + '] ' + g.link));

  let manualGrants = [];
  const outputPath = path.join(process.cwd(), 'nys-grants.json');
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries');
    } catch(e) {
      console.log('Could not read existing file:', e.message);
    }
  }

  const allGrants = [...grants, ...manualGrants];
  const output = { grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved.');
})();
