/**
 * wpEngine.js
 *
 * WP Engine REST API helpers.
 * Used for creating backup checkpoints before risky operations
 * (plugin installs, updates, deactivations, core updates).
 *
 * Env vars required:
 *   WP_ENGINE_API_USER     — WP Engine API username (portal → API Access)
 *   WP_ENGINE_API_PASSWORD — WP Engine API password
 *   WP_ENGINE_INSTALL_ID   — Install ID (UUID shown in WP Engine portal URL)
 *
 * API docs: https://wpengineapi.com/reference
 */

const axios = require('axios');

const WPE_API_BASE = 'https://api.wpengineapi.com/v1';

function getAuth() {
  const user = process.env.WP_ENGINE_API_USER;
  const pass = process.env.WP_ENGINE_API_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      '❌ WP Engine API credentials not set.\n' +
      'Add WP_ENGINE_API_USER and WP_ENGINE_API_PASSWORD to Railway env vars.\n' +
      'Get credentials: WP Engine portal → My Profile → API Access'
    );
  }
  return { username: user, password: pass };
}

function getInstallId() {
  const id = process.env.WP_ENGINE_INSTALL_ID;
  if (!id) {
    throw new Error(
      '❌ WP_ENGINE_INSTALL_ID not set.\n' +
      'Add it to Railway env vars.\n' +
      'Find it: WP Engine portal → your install → the UUID in the URL'
    );
  }
  return id;
}

/**
 * Create a WP Engine backup checkpoint.
 * @param {string} description  Human-readable label (e.g. "Pre-update backup — BRIN-58")
 * @param {string[]} notifyEmails  Optional email addresses to notify when backup completes
 * @returns {{ id: string, status: string, created_at: string }}
 */
async function createBackup(description = 'Agent backup', notifyEmails = []) {
  const auth      = getAuth();
  const installId = getInstallId();

  console.log(`🔒 Creating WP Engine backup: "${description}" for install ${installId}...`);

  const res = await axios.post(
    `${WPE_API_BASE}/installs/${installId}/backups`,
    { description, notification_emails: notifyEmails },
    {
      auth,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  const backup = res.data;
  console.log(`✅ Backup checkpoint created: ${backup.id} (status: ${backup.status})`);

  return {
    id:         backup.id,
    status:     backup.status,
    created_at: backup.created_at || new Date().toISOString(),
  };
}

/**
 * Get status of a backup checkpoint.
 * @param {string} backupId
 */
async function getBackupStatus(backupId) {
  const auth      = getAuth();
  const installId = getInstallId();

  const res = await axios.get(
    `${WPE_API_BASE}/installs/${installId}/backups/${backupId}`,
    { auth, timeout: 15000 }
  );

  return res.data; // { id, status, description, created_at, ... }
}

/**
 * List recent backup checkpoints for the install.
 * @param {number} limit  Max checkpoints to return (default 5)
 */
async function listBackups(limit = 5) {
  const auth      = getAuth();
  const installId = getInstallId();

  const res = await axios.get(
    `${WPE_API_BASE}/installs/${installId}/backups`,
    { auth, params: { limit }, timeout: 15000 }
  );

  return res.data?.results || [];
}

/**
 * Check if WP Engine API credentials are configured.
 * Returns true/false without throwing.
 */
function isConfigured() {
  return !!(
    process.env.WP_ENGINE_API_USER &&
    process.env.WP_ENGINE_API_PASSWORD &&
    process.env.WP_ENGINE_INSTALL_ID
  );
}

module.exports = { createBackup, getBackupStatus, listBackups, isConfigured };
