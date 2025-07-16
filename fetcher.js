import puppeteer from 'puppeteer';

async function fetchUrl(url) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  const content = await page.content();
  console.log(content);
  await browser.close();
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('No URL provided');
    process.exit(1);
  }

  try {
    await fetchUrl(url);
    process.exit(0);
  } catch (err) {
    console.error('Error fetching URL:', err);
    process.exit(1);
  }
})();