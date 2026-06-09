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
  const res = await axios.post(
    `${BASE_URL}/wp-json/wp/v2/posts/${id}`,
    fields,
    { auth }
  );
  return res.data;
}

// Create a new page
async function createPage(title, content, status = 'draft') {
  const res = await axios.post(
    `${BASE_URL}/wp-json/wp/v2/pages`,
    { title, content, status },
    { auth }
  );
  return res.data;
}

// Update an existing page
async function updatePage(id, fields) {
  const res = await axios.post(
    `${BASE_URL}/wp-json/wp/v2/pages/${id}`,
    fields,
    { auth }
  );
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

module.exports = { getPost, getPage, searchContent, createPost, updatePost, createPage, updatePage, listPosts };
