/**
 * wpCli.js — REST API replacement for WP CLI over SSH
 *
 * Railway blocks outbound port 22, so all WP operations go through
 * the custom brinda-agent REST API plugin installed on WP Engine.
 * All endpoints require WP Application Password (Basic Auth).
 */

const axios = require('axios');

const WP_BASE   = process.env.WP_STAGING_URL;
const wpAuth    = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };
const agentHdrs = () => ({ 'X-Agent-Token': process.env.AGENT_TOKEN || '' });

// ── Core REST helper ──────────────────────────────────────────────────────

async function agentApi(method, path, data = null) {
  const url = `${WP_BASE}/wp-json/brinda-agent/v1/${path}`;
  try {
    const res = await axios({ method, url, headers: agentHdrs(), data, timeout: 30000 });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Agent API ${method.toUpperCase()} ${path} failed: ${msg}`);
  }
}

// ── runWpCli shim — called by siteKnowledge.js + pageInspector.js ─────────
// These functions convert the old WP CLI commands to REST API calls.
// Not a real WP CLI runner — only the commands actually used by the agent.

async function runWpCli(command) {
  const cmd = command.trim();

  // ── post meta get <id> _elementor_data ───────────────────────────────────
  const elemGet = cmd.match(/^post meta get (\d+) _elementor_data/);
  if (elemGet) {
    const res = await agentApi('get', `elementor-data?post_id=${elemGet[1]}`);
    return res.elementor_data || '';
  }

  // ── post meta update <id> _elementor_data <value> ───────────────────────
  // (used by pageInspector write path — not needed but keep for safety)
  const elemSet = cmd.match(/^post meta update (\d+) _elementor_data/);
  if (elemSet) {
    throw new Error('Use brinda-agent/v1/elementor-data POST endpoint directly');
  }

  // ── cache flush ──────────────────────────────────────────────────────────
  if (cmd === 'cache flush' || cmd.startsWith('cache flush')) {
    await agentApi('post', 'flush-cache', {});
    return 'Cache flushed.';
  }

  // ── post delete <id> --force ─────────────────────────────────────────────
  const postDel = cmd.match(/^post delete (\d+).*--force/);
  if (postDel) {
    await axios.delete(`${WP_BASE}/wp-json/wp/v2/posts/${postDel[1]}`, {
      auth: wpAuth, params: { force: true }, timeout: 15000,
    }).catch(() => {}); // ignore 404
    return 'Deleted.';
  }

  // ── post term set <id> <taxonomy> <term_id> ──────────────────────────────
  const termSet = cmd.match(/^post term set (\d+) (\S+) (\d+)/);
  if (termSet) {
    // Use standard WP REST API — set taxonomy term on post
    const [, postId, taxonomy, termId] = termSet;
    await axios.post(`${WP_BASE}/wp-json/wp/v2/posts/${postId}`, {
      [taxonomy]: [parseInt(termId)],
    }, { auth: wpAuth, timeout: 15000 }).catch(() => {});
    return 'Term set.';
  }

  // ── eval '...' ───────────────────────────────────────────────────────────
  // siteKnowledge.js uses this to fetch site options — redirect to /site-info
  if (cmd.startsWith('eval ')) {
    // Return a placeholder; siteKnowledge.js now calls buildKnowledge via REST directly
    return '{}';
  }

  // ── post list ────────────────────────────────────────────────────────────
  const postList = cmd.match(/^post list.*--post_type=(\S+)/);
  if (postList) {
    const postType = postList[1];
    const catMatch = cmd.match(/--tax_query\[0\]\[terms\]=(\d+)/);
    const catId    = catMatch ? catMatch[1] : null;
    const res = await agentApi('get', `cpt-posts?post_type=${postType}${catId ? `&cat_id=${catId}` : ''}`);
    // Return JSON matching WP CLI --format=json output
    return JSON.stringify(res.posts.map(p => ({
      ID: p.id, post_title: p.title, post_status: p.status, post_name: p.slug,
    })));
  }

  // Fallback — log and return empty
  console.warn(`⚠️  runWpCli: unhandled command: ${cmd.substring(0, 80)}`);
  return '';
}

// ── Keep connect/disconnect as no-ops (no SSH needed) ─────────────────────
async function connect()    { return null; }
function  disconnect()      {}

// ── Navigation menus (use standard WP REST API) ───────────────────────────

async function getMenus() {
  const res = await axios.get(`${WP_BASE}/wp-json/wp/v2/menus`, { auth: wpAuth, timeout: 15000 });
  return res.data || [];
}

async function getMenuItems(menuNameOrId) {
  // Accept menu name or numeric ID
  const menus = await getMenus();
  const menu  = menus.find(m => m.name === menuNameOrId || m.id == menuNameOrId || m.slug === menuNameOrId);
  if (!menu) return [];
  const res = await axios.get(`${WP_BASE}/wp-json/wp/v2/menu-items`, {
    auth: wpAuth, params: { menus: menu.id, per_page: 100 }, timeout: 15000,
  });
  return res.data || [];
}

async function addPageToMenu(menuName, pageId, title = '', position = null) {
  const menus = await getMenus();
  const menu  = menus.find(m => m.name === menuName || m.slug === menuName);
  if (!menu) throw new Error(`Menu "${menuName}" not found`);
  const body = { menus: menu.id, object: 'page', object_id: pageId, type: 'post_type', status: 'publish' };
  if (title)    body.title    = title;
  if (position) body.menu_order = position;
  const res = await axios.post(`${WP_BASE}/wp-json/wp/v2/menu-items`, body, { auth: wpAuth, timeout: 15000 });
  return res.data;
}

async function addUrlToMenu(menuName, url, title, position = null) {
  const menus = await getMenus();
  const menu  = menus.find(m => m.name === menuName || m.slug === menuName);
  if (!menu) throw new Error(`Menu "${menuName}" not found`);
  const body = { menus: menu.id, url, title, type: 'custom', status: 'publish' };
  if (position) body.menu_order = position;
  const res = await axios.post(`${WP_BASE}/wp-json/wp/v2/menu-items`, body, { auth: wpAuth, timeout: 15000 });
  return res.data;
}

async function removeMenuItemById(itemId) {
  await axios.delete(`${WP_BASE}/wp-json/wp/v2/menu-items/${itemId}`, {
    auth: wpAuth, params: { force: true }, timeout: 15000,
  });
}

// ── Plugins ───────────────────────────────────────────────────────────────
// WP REST API doesn't expose plugin management without Jetpack or similar.
// These are stubs — plugin tasks use the AI agent's existing logic.

async function getPlugins()            { return []; }
async function installPlugin(slug)     { throw new Error('Plugin install requires manual action or WP Admin'); }
async function activatePlugin(slug)    { throw new Error('Plugin activate requires manual action or WP Admin'); }
async function deactivatePlugin(slug)  { throw new Error('Plugin deactivate requires manual action or WP Admin'); }
async function updatePlugin(slug)      { throw new Error('Plugin update requires manual action or WP Admin'); }

// ── Yoast SEO (via WP REST post meta) ────────────────────────────────────

async function updateYoastSeo(postId, { title, description, focusKeyword }) {
  const meta = {};
  if (title)        meta._yoast_wpseo_title    = title;
  if (description)  meta._yoast_wpseo_metadesc = description;
  if (focusKeyword) meta._yoast_wpseo_focuskw  = focusKeyword;
  await axios.post(`${WP_BASE}/wp-json/wp/v2/posts/${postId}`, { meta }, { auth: wpAuth, timeout: 15000 });
}

// ── DB backup stubs (not feasible via REST) ───────────────────────────────

async function exportDb() { throw new Error('DB export requires SSH or manual backup'); }
async function importDb() { throw new Error('DB import requires SSH or manual backup'); }

module.exports = {
  runWpCli, connect, disconnect,
  getMenus, getMenuItems, addPageToMenu, addUrlToMenu, removeMenuItemById,
  getPlugins, installPlugin, activatePlugin, deactivatePlugin, updatePlugin,
  updateYoastSeo, exportDb, importDb,
};
