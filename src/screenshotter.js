/**
 * screenshotter.js
 *
 * Takes a full-page screenshot using microlink.io (free tier, no API key).
 * Downloads the image and uploads it to Jira as an issue attachment.
 *
 * Free tier limits: 50 req/day, no custom headers, no force param.
 * Cache busting is handled by appending ?nocache=<timestamp> to the URL
 * before passing it to microlink — this makes every request a unique URL
 * so microlink always renders fresh.
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
 * Take a full-page screenshot via microlink.io free tier.
 * Cache busting: ?nocache=<timestamp> appended to URL = unique URL each run
 * = microlink always fetches fresh (it caches by URL).
 */
async function takeScreenshot(url) {
  // Append cache-buster to URL so microlink never serves a cached render
  const separator = url.includes('?') ? '&' : '?';
  const freshUrl  = `${url}${separator}nocache=${Date.now()}`;

  console.log(`📸 Taking full-page screenshot of ${freshUrl} via microlink.io...`);

  const apiRes = await axios.get('https://api.microlink.io', {
    params: {
      url:              freshUrl,
      screenshot:       true,
      meta:             false,
      fullPage:         true,
      'viewport.width': 1440,
      waitFor:          5000,   // wait 5s for CSS/fonts/images to load
    },
    timeout: 60000,
    headers: { 'Accept': 'application/json' },
  });

  // Log full response for debugging
  console.log(`📡 microlink status: ${apiRes.data?.status}, code: ${apiRes.data?.data?.screenshot ? 'has screenshot' : 'no screenshot'}`);

  const screenshotUrl = apiRes.data?.data?.screenshot?.url;
  if (!screenshotUrl) {
    throw new Error(`microlink.io did not return screenshot URL. Response: ${JSON.stringify(apiRes.data).substring(0, 300)}`);
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
        'Authorization':     `Basic ${auth}`,
        'X-Atlassian-Token': 'no-check',
      },
    }
  );

  const attachment = res.data[0];
  console.log(`✅ Attachment uploaded: ${attachment.filename}`);
  return attachment.content;
}

/**
 * Main export: screenshot staging → upload to Jira → return attachment URL.
 * Fails gracefully — screenshot is nice-to-have, not critical to the deploy flow.
 * urlOverride: pass a custom URL (already has ?nocache if needed); we'll add one if not present.
 */
async function capturePreview(issueKey, urlOverride) {
  try {
    const baseUrl        = urlOverride || WP_URL;
    const screenshotPath = await takeScreenshot(baseUrl);
    const imageUrl       = await uploadToJira(issueKey, screenshotPath);

    try { fs.unlinkSync(screenshotPath); } catch (_) {}

    return imageUrl;
  } catch (err) {
    console.warn(`⚠️  Screenshot failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = { capturePreview };
