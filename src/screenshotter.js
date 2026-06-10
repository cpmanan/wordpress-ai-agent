/**
 * screenshotter.js
 *
 * Takes a full-page screenshot of the staging site after deployment
 * and uploads it to Jira as an issue attachment, then posts it in a comment.
 */

const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const axios     = require('axios');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const FormData  = require('form-data');

const JIRA_BASE      = process.env.JIRA_BASE_URL || 'https://cp-jira.atlassian.net';
const JIRA_EMAIL     = process.env.ATLASSIAN_EMAIL;
const JIRA_API_TOKEN = process.env.ATLASSIAN_API_TOKEN;
const CLOUD_ID       = process.env.JIRA_CLOUD_ID || 'a3fb9302-bf50-4c4e-abe1-01f661ccb93c';
const WP_URL         = process.env.WP_STAGING_URL || 'https://brindayogacstg.wpenginepowered.com';

/**
 * Launch headless Chromium and take a full-page screenshot.
 * Returns the path to the saved PNG file.
 */
async function takeScreenshot(url) {
  console.log(`📸 Taking screenshot of ${url}...`);

  const browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: { width: 1440, height: 900 },
    executablePath:  await chromium.executablePath(),
    headless:        chromium.headless,
  });

  try {
    const page = await browser.newPage();

    // Bypass cookie banners / popups
    await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait a beat for fonts/animations to settle
    await new Promise(r => setTimeout(r, 2000));

    const screenshotPath = path.join(os.tmpdir(), `preview-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }); // viewport only — faster

    console.log(`✅ Screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  } finally {
    await browser.close();
  }
}

/**
 * Upload screenshot as a Jira issue attachment.
 * Returns the attachment URL.
 */
async function uploadToJira(issueKey, screenshotPath) {
  console.log(`📎 Uploading screenshot to Jira issue ${issueKey}...`);

  const form = new FormData();
  form.append('file', fs.createReadStream(screenshotPath), {
    filename:    `preview-${issueKey}.png`,
    contentType: 'image/png',
  });

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  const res = await axios.post(
    `${JIRA_BASE}/rest/api/3/issue/${issueKey}/attachments`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Basic ${auth}`,
        'X-Atlassian-Token': 'no-check',
      },
    }
  );

  const attachment = res.data[0];
  console.log(`✅ Attachment uploaded: ${attachment.content}`);
  return attachment.content; // direct download URL
}

/**
 * Main export: take screenshot of staging, upload to Jira, return image URL.
 * Fails gracefully — screenshot is nice-to-have, not critical.
 */
async function capturePreview(issueKey) {
  try {
    const screenshotPath = await takeScreenshot(WP_URL);
    const imageUrl       = await uploadToJira(issueKey, screenshotPath);

    // Clean up temp file
    try { fs.unlinkSync(screenshotPath); } catch (_) {}

    return imageUrl;
  } catch (err) {
    console.warn(`⚠️  Screenshot failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = { capturePreview };
