const axios = require('axios');

const BASE_URL = process.env.WP_STAGING_URL;
const auth = {
  username: process.env.WP_USERNAME,
  password: process.env.WP_APP_PASSWORD
};

// Get a post/page by ID
async function getPost(id) {
  const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts/${id}`, { auth });
  return res.data;
}

// Get a page by ID
async function getPage(id) {
  const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/pages/${id}`, { auth });
  return res.data;
}

// Search posts/pages by title
async function searchContent(query) {
  const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/search`, {
    auth,
    params: { search: query, per_page: 5 }
  });
  return res.data;
}

// Create a new post
async function createPost(title, content, status = 'draft', excerpt = '') {
  const res = await axios.post(
    `${BASE_URL}/wp-json/wp/v2/posts`,
    { title, content, status, excerpt },
    { auth }
  );
  return res.data;
}

// Update an existing post
async function updatePost(id, fields) {
  try {
    const res = await axios.post(
      `${BASE_URL}/wp-json/wp/v2/posts/${id}`,
      fields,
      { auth }
    );
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    throw new Error(`WP updatePost failed (${err.response?.status}): ${detail}`);
  }
}

// Create a new page
async function createPage(title, content, status = 'draft') {
  try {
    const res = await axios.post(
      `${BASE_URL}/wp-json/wp/v2/pages`,
      { title, content, status },
      { auth }
    );
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    throw new Error(`WP createPage failed (${err.response?.status}): ${detail}`);
  }
}

// Update an existing page
async function updatePage(id, fields) {
  try {
    const res = await axios.post(
      `${BASE_URL}/wp-json/wp/v2/pages/${id}`,
      fields,
      { auth }
    );
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    // Log full response for debugging 403/401 issues
    if (status === 403 || status === 401) {
      console.error(`🔐 Auth error ${status} on page ${id}:`, JSON.stringify(err.response?.data || {}));
      console.error(`   WP_USERNAME="${process.env.WP_USERNAME}" | WP_APP_PASSWORD set=${!!process.env.WP_APP_PASSWORD}`);
      // Fallback: try via brinda-agent plugin (update-content endpoint)
      try {
        const agentRes = await axios.post(
          `${BASE_URL}/wp-json/brinda-agent/v1/update-content`,
          { post_id: id, fields },
          { headers: { 'X-Agent-Token': process.env.AGENT_TOKEN || '' } }
        );
        console.log(`✅ updatePage fallback via brinda-agent succeeded for page ${id}`);
        return agentRes.data;
      } catch (fallbackErr) {
        console.error(`   Fallback also failed: ${fallbackErr.response?.status} — ${fallbackErr.response?.data?.message || fallbackErr.message}`);
      }
    }
    throw new Error(`WP updatePage failed (${status}): ${detail}`);
  }
}

// Find a page by slug (e.g. "contact", "about", "services")
async function getPageBySlug(slug) {
  const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/pages`, {
    auth,
    params: { slug, _fields: 'id,title,content,slug,status', per_page: 1 }
  });
  return res.data[0] || null;
}

// Find a page by partial title match
async function findPageByTitle(titleKeyword) {
  const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/pages`, {
    auth,
    params: { search: titleKeyword, per_page: 5, _fields: 'id,title,content,slug,status' }
  });
  return res.data;
}

// List all posts (for bulk operations)
async function listPosts(perPage = 100) {
  const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
    auth,
    params: { per_page: perPage, _fields: 'id,title,excerpt,slug' }
  });
  return res.data;
}

// ── Navigation Menu REST API (WordPress 5.9+) ─────────────────────────────────
// Uses wp/v2/menus and wp/v2/menu-items — no SSH or WP CLI needed.

// List all registered nav menus
async function getMenus() {
  try {
    const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/menus`, { auth });
    return res.data; // array of { id, name, slug, locations, ... }
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`getMenus failed (${err.response?.status}): ${detail}`);
  }
}

// Get all items in a menu by menu ID
async function getMenuItems(menuId) {
  try {
    const res = await axios.get(`${BASE_URL}/wp-json/wp/v2/menu-items`, {
      auth,
      params: { menus: menuId, per_page: 100 }
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`getMenuItems failed: ${detail}`);
  }
}

// Add a page to a nav menu by menu ID
async function addPageToMenu(menuIdOrName, pageId, title = '', position = null) {
  try {
    // If menuIdOrName is a string name, look up the ID first
    let menuId = menuIdOrName;
    if (typeof menuIdOrName === 'string' && isNaN(menuIdOrName)) {
      const menus = await getMenus();
      const found = menus.find(m =>
        m.name.toLowerCase() === menuIdOrName.toLowerCase() ||
        m.slug.toLowerCase() === menuIdOrName.toLowerCase()
      );
      if (!found) throw new Error(`Menu "${menuIdOrName}" not found. Available: ${menus.map(m => m.name).join(', ')}`);
      menuId = found.id;
    }

    // Get current item count to determine position if not specified
    if (!position) {
      const items = await getMenuItems(menuId);
      position = items.length + 1;
    }

    const body = {
      title:  title || undefined,
      url:    '',
      object: 'page',
      object_id: pageId,
      menus:  menuId,
      menu_order: position,
      type:   'post_type',
      status: 'publish',
    };

    const res = await axios.post(`${BASE_URL}/wp-json/wp/v2/menu-items`, body, { auth });
    console.log(`✅ Added page ${pageId} to menu ${menuId} as item ${res.data.id}`);
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    throw new Error(`addPageToMenu failed (${err.response?.status}): ${detail}`);
  }
}

// Add a custom URL to a nav menu
async function addUrlToMenu(menuIdOrName, url, title, position = null) {
  try {
    let menuId = menuIdOrName;
    if (typeof menuIdOrName === 'string' && isNaN(menuIdOrName)) {
      const menus = await getMenus();
      const found = menus.find(m =>
        m.name.toLowerCase() === menuIdOrName.toLowerCase() ||
        m.slug.toLowerCase() === menuIdOrName.toLowerCase()
      );
      if (!found) throw new Error(`Menu "${menuIdOrName}" not found.`);
      menuId = found.id;
    }

    if (!position) {
      const items = await getMenuItems(menuId);
      position = items.length + 1;
    }

    const body = {
      title,
      url,
      object: 'custom',
      menus:  menuId,
      menu_order: position,
      type:   'custom',
      status: 'publish',
    };

    const res = await axios.post(`${BASE_URL}/wp-json/wp/v2/menu-items`, body, { auth });
    console.log(`✅ Added custom URL "${url}" to menu ${menuId}`);
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    throw new Error(`addUrlToMenu failed (${err.response?.status}): ${detail}`);
  }
}

module.exports = {
  getPost, getPage, getPageBySlug, findPageByTitle, searchContent,
  createPost, updatePost, createPage, updatePage, listPosts,
  getMenus, getMenuItems, addPageToMenu, addUrlToMenu,
};
