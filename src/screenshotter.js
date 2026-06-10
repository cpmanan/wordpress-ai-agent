/**
 * screenshotter.js
 *
 * Takes a full-page screenshot using microlink.io (free, no API key, Playwright-powered).
 * Downloads the image and uploads it to Jira as an issue attachment.
 *
 * microlink.io renders pages with a real headless browser (Playwright), so JS/CSS
 * all execute fully before the screenshot is taken — reliable full-page captures.
 */

const axios    = require('axios');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const FormData = require('form-data');

const JIRA_BASE      = process.env.JIRA_BASE_URL || 'https://cp-jira.atlassian.net';
const JIRA_EMAIL     = process.env.ATLASSIAN_EMAIL;
const JIRA_API_TOKEN = process.env.ATLASSIAN_API_TOKEN;
const WP_URL         = process.env.WP_STAGING_URL || 'https://brindayogacstg.wpenginepowered.com';

/**
 * Take a full-page screenshot via microlink.io.
 * microlink.io uses Playwright under the hood — full JS rendering, full-page capture.
 * Free tier: 50 req/day, no API key needed.
 * Returns path to saved PNG file.
 */
async function takeScreenshot(url) {
  console.log(`📸 Taking full-page screenshot of ${url} via microlink.io (Playwright)...`);

  // microlink.io API:
  //   screenshot=true        → capture screenshot
  //   meta=false             → skip metadata extraction, just screenshot
  //   fullPage=true          → scroll and capture entire page height
  //   viewport.width=1440    → desktop width
  //   waitFor=6000           → wait 6s for fonts, images, and CSS animations to fully load
  //   force=true             → bypass microlink's own CDN cache — always re-render fresh
  //   headers.*              → sent to WP Engine when loading the page:
  //                            Cache-Control: no-cache  → bypasses WP Engine page cache
  //                            Pragma: no-cache         → bypasses any HTTP/1.0 proxy cache
  //                            This forces WP Engine to serve fresh HTML with the latest
  //                            CSS ?ver= URL instead of the cached old HTML.
  const apiUrl = 'https://api.microlink.io';
  const params = {
    url,
    screenshot: true,
    meta: false,
    fullPage: true,
    'viewport.width': 1440,
    'viewport.height': 900,
    waitFor: 6000,
    force: true,
    'headers.Cache-Control': 'no-cache, no-store, must-revalidate',
    'headers.Pragma': 'no-cache',
  };

  console.log('⏳ Waiting for microlink.io to render full page...');
  const apiRes = await axios.get(apiUrl, {
    params,
    timeout: 60000,
    headers: { 'Accept': 'application/json' },
  });

  const screenshotUrl = apiRes.data?.data?.screenshot?.url;
  if (!screenshotUrl) {
    throw new Error(`microlink.io did not return a screenshot URL. Response: ${JSON.stringify(apiRes.data)}`);
  }

  console.log(`📥 Downloading screenshot from: ${screenshotUrl}`);
  const imgRes = await axios.get(screenshotUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const screenshotPath = path.join(os.tmpdir(), `preview-${Date.now()}.png`);
  fs.writeFileSync(screenshotPath, imgRes.data);

  console.log(`✅ Screenshot saved (${imgRes.data.byteLength} bytes): ${screenshotPath}`);
  return screenshotPath;
}

/**
 * Upload screenshot as a Jira issue attachment.
 * Returns the attachment content URL (shown inline in Jira comments).
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
        'Authorization':      `Basic ${auth}`,
        'X-Atlassian-Token':  'no-check',
      },
    }
  );

  const attachment = res.data[0];
  console.log(`✅ Attachment uploaded: ${attachment.filename}`);
  return attachment.content; // direct URL usable in Jira comment
}

/**
 * Main export: screenshot staging → upload to Jira → return attachment URL.
 * Fails gracefully — screenshot is nice-to-have, not critical to the deploy flow.
 */
async function capturePreview(issueKey, urlOverride) {
  try {
    const screenshotPath = await takeScreenshot(urlOverride || WP_URL);
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
