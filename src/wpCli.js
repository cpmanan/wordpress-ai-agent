const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const os = require('os');
const path = require('path');

let ssh = null;

// Setup SSH key file from env var
function setupSshKey() {
  const keyPath = path.join(os.tmpdir(), 'wpengine_cli_key');
  fs.writeFileSync(keyPath, process.env.SSH_PRIVATE_KEY + '\n', { mode: 0o600 });
  return keyPath;
}

// Connect to WP Engine SSH
async function connect() {
  if (ssh && ssh.isConnected()) return ssh;
  ssh = new NodeSSH();
  const keyPath = setupSshKey();

  console.log(`🔌 Connecting SSH to ${process.env.WPENGINE_SSH_HOST} as ${process.env.WPENGINE_SSH_USER}`);

  try {
    await ssh.connect({
      host: process.env.WPENGINE_SSH_HOST,
      username: process.env.WPENGINE_SSH_USER,
      privateKeyPath: keyPath,
      port: 22,
      readyTimeout: 20000,
      algorithms: { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] }
    });
  } catch (err) {
    ssh = null;
    if (err.message.includes('handshake') || err.message.includes('Timed out')) {
      throw new Error(
        `SSH connection to WP Engine failed. Please ensure:\n` +
        `1. SSH public key is added to WP Engine → SSH Keys (account level, not install level)\n` +
        `2. URL: https://my.wpengine.com/ssh_keys\n` +
        `SSH Host: ${process.env.WPENGINE_SSH_HOST}\n` +
        `Original error: ${err.message}`
      );
    }
    throw err;
  }

  console.log(`✅ SSH connected to ${process.env.WPENGINE_SSH_HOST}`);
  return ssh;
}

// Disconnect SSH
function disconnect() {
  if (ssh) { ssh.dispose(); ssh = null; }
}

// Run a WP CLI command via SSH
async function runWpCli(command) {
  const conn = await connect();
  const wpPath = `/home/${process.env.WPENGINE_SSH_USER}/sites/${process.env.WPENGINE_SSH_USER}`;
  const result = await conn.execCommand(`wp ${command} --path=${wpPath}`, {
    cwd: wpPath
  });
  if (result.stderr && !result.stderr.includes('Warning')) {
    throw new Error(`WP CLI error: ${result.stderr}`);
  }
  console.log(`✅ WP CLI: wp ${command}`);
  return result.stdout.trim();
}

// ── Navigation Menu Functions ─────────────────────────────────────

// List all menus
async function getMenus() {
  const output = await runWpCli('menu list --format=json');
  return JSON.parse(output || '[]');
}

// Get menu items for a specific menu
async function getMenuItems(menuName) {
  const output = await runWpCli(`menu item list "${menuName}" --format=json`);
  return JSON.parse(output || '[]');
}

// Add a page to a menu
async function addPageToMenu(menuName, pageId, title = '', position = null) {
  let cmd = `menu item add-post "${menuName}" ${pageId}`;
  if (title) cmd += ` --title="${title}"`;
  if (position) cmd += ` --position=${position}`;
  return await runWpCli(cmd);
}

// Add a custom URL to a menu
async function addUrlToMenu(menuName, url, title, position = null) {
  let cmd = `menu item add-custom "${menuName}" "${title}" "${url}"`;
  if (position) cmd += ` --position=${position}`;
  return await runWpCli(cmd);
}

// Remove an item from a menu
async function removeMenuItemById(itemId) {
  return await runWpCli(`menu item delete ${itemId}`);
}

// ── Plugin Functions ──────────────────────────────────────────────

// List installed plugins
async function getPlugins() {
  const output = await runWpCli('plugin list --format=json');
  return JSON.parse(output || '[]');
}

// Install and activate a plugin
async function installPlugin(slug) {
  // Check WP Engine blocked plugins first
  const blocked = ['timthumb', 'dzs-videogallery', 'custom-content-type-manager'];
  if (blocked.includes(slug.toLowerCase())) {
    throw new Error(`Plugin "${slug}" is blocked by WP Engine.`);
  }
  await runWpCli(`plugin install ${slug} --activate`);
  return true;
}

// Activate an existing plugin
async function activatePlugin(slug) {
  return await runWpCli(`plugin activate ${slug}`);
}

// Deactivate a plugin
async function deactivatePlugin(slug) {
  return await runWpCli(`plugin deactivate ${slug}`);
}

// Update a specific plugin
async function updatePlugin(slug) {
  return await runWpCli(`plugin update ${slug}`);
}

// ── SEO Functions (Yoast) ─────────────────────────────────────────

async function updateYoastSeo(postId, { title, description, focusKeyword }) {
  if (title) await runWpCli(`post meta update ${postId} _yoast_wpseo_title "${title}"`);
  if (description) await runWpCli(`post meta update ${postId} _yoast_wpseo_metadesc "${description}"`);
  if (focusKeyword) await runWpCli(`post meta update ${postId} _yoast_wpseo_focuskw "${focusKeyword}"`);
}

// ── Database Backup/Restore ───────────────────────────────────────

async function exportDb(cardId) {
  const file = `/tmp/backup-${cardId}-${Date.now()}.sql`;
  await runWpCli(`db export ${file}`);
  return file;
}

async function importDb(file) {
  return await runWpCli(`db import ${file}`);
}

module.exports = {
  runWpCli, connect, disconnect,
  getMenus, getMenuItems, addPageToMenu, addUrlToMenu, removeMenuItemById,
  getPlugins, installPlugin, activatePlugin, deactivatePlugin, updatePlugin,
  updateYoastSeo, exportDb, importDb
};
