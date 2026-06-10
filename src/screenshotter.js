/**
 * screenshotter.js
 *
 * Takes a screenshot of the staging site using thum.io (free, no API key needed)
 * and uploads it to Jira as an issue attachment.
 *
 * Avoids running Chromium on Railway — uses an external screenshot service instead.
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
 * Fetch a screenshot via thum.io and save to a temp file.
 * thum.io is free, no API key required.
 * Returns the path to the saved PNG file.
 */
async function takeScreenshot(url) {
  console.log(`📸 Taking screenshot of ${url} via thum.io...`);

  // thum.io params: width=1440, crop height=900 (above-the-fold)
  // URL must NOT be encoded — thum.io appends it directly after the path
  const screenshotApiUrl = `https://image.thum.io/get/width/1440/crop/900/noanimate/${url}`;

  const response = await axios.get(screenshotApiUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'Accept': 'image/png,image/jpeg,image/*' },
  });

  const screenshotPath = path.join(os.tmpdir(), `preview-${Date.now()}.png`);
  fs.writeFileSync(screenshotPath, response.data);

  console.log(`✅ Screenshot saved (${response.data.byteLength} bytes): ${screenshotPath}`);
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
