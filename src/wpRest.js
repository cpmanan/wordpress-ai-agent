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
async function createPost(title, content, status = 'draft') {
  const res = await axios.post(
    `${BASE_URL}/wp-json/wp/v2/posts`,
    { title, content, status },
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
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    throw new Error(`WP updatePage failed (${err.response?.status}): ${detail}`);
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

module.exports = { getPost, getPage, getPageBySlug, findPageByTitle, searchContent, createPost, updatePost, createPage, updatePage, listPosts };
