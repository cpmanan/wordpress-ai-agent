const { NodeSSH } = require('node-ssh');

let ssh = null;
let connectingPromise = null; // mutex — prevents parallel connect races

// Parse the SSH private key from env var (handles Railway's \n escaping)
function getPrivateKey() {
  const rawKey = process.env.SSH_PRIVATE_KEY || '';
  if (!rawKey) throw new Error('SSH_PRIVATE_KEY env var is not set');
  // Railway stores multiline env vars with literal \n — convert back to real newlines
  const key = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return key.trim() + '\n';
}

// Check if the current ssh instance is alive
function isAlive() {
  if (!ssh) return false;
  try {
    // node-ssh exposes the underlying ssh2 Connection as ssh.connection
    return ssh.connection && !ssh.connection._sock?.destroyed;
  } catch {
    return false;
  }
}

// Connect to WP Engine SSH — serialised via connectingPromise mutex
async function connect() {
  if (isAlive()) return ssh;

  // If a connect is already in-flight, wait for it rather than racing
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    ssh = new NodeSSH();
    const privateKey = getPrivateKey();
    console.log(`🔑 Key format: ${privateKey.substring(0, 35).replace(/\n/g, '↵')}`);
    console.log(`🔌 Connecting SSH to ${process.env.WPENGINE_SSH_HOST} as ${process.env.WPENGINE_SSH_USER}`);

    try {
      await ssh.connect({
        host:        process.env.WPENGINE_SSH_HOST,
        username:    process.env.WPENGINE_SSH_USER,
        privateKey,               // pass key string directly — no temp file
        port:        22,
        readyTimeout: 20000,
        algorithms:  { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] }
      });
      console.log(`✅ SSH connected to ${process.env.WPENGINE_SSH_HOST}`);
    } catch (err) {
      ssh = null;
      const hint = err.message.includes('handshake') || err.message.includes('Timed out') || err.message.includes('All configured');
      if (hint) {
        throw new Error(
          `SSH connection to WP Engine failed.\n` +
          `Host: ${process.env.WPENGINE_SSH_HOST}\n` +
          `Check: https://my.wpengine.com/ssh_keys (account-level, not install-level)\n` +
          `Original: ${err.message}`
        );
      }
      throw err;
    } finally {
      connectingPromise = null; // release mutex regardless of outcome
    }
    return ssh;
  })();

  return connectingPromise;
}

// Disconnect SSH
function disconnect() {
  if (ssh) { try { ssh.dispose(); } catch {} ssh = null; }
  connectingPromise = null;
}

// Run a WP CLI command via SSH
async function runWpCli(command) {
  const conn = await connect();
  // WP Engine SSH path: /home/wpe-user/sites/{install-name}
  const wpPath = `/home/wpe-user/sites/${process.env.WPENGINE_SSH_USER}`;
  const result = await conn.execCommand(`wp ${command} --path=${wpPath}`, {
    cwd: wpPath
  });
  if (result.stderr && !result.stderr.includes('Warning') && !result.stderr.includes('Notice')) {
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
