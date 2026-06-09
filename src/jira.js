const axios = require('axios');

const BASE_URL = process.env.JIRA_BASE_URL;
const EMAIL = process.env.ATLASSIAN_EMAIL;
const TOKEN = process.env.ATLASSIAN_API_TOKEN;

const auth = {
  username: EMAIL,
  password: TOKEN
};

// Get a Jira issue by key (e.g. BRIN-12)
async function getIssue(issueKey) {
  const res = await axios.get(`${BASE_URL}/rest/api/3/issue/${issueKey}`, { auth });
  return res.data;
}

// Add a comment to a Jira issue
async function addComment(issueKey, text) {
  await axios.post(
    `${BASE_URL}/rest/api/3/issue/${issueKey}/comment`,
    {
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      }
    },
    { auth }
  );
}

// Store revert metadata on the issue (as an issue property)
async function setRevertMeta(issueKey, data) {
  await axios.put(
    `${BASE_URL}/rest/api/3/issue/${issueKey}/properties/revert-meta`,
    data,
    { auth }
  );
}

// Read revert metadata from the issue
async function getRevertMeta(issueKey) {
  try {
    const res = await axios.get(
      `${BASE_URL}/rest/api/3/issue/${issueKey}/properties/revert-meta`,
      { auth }
    );
    return res.data.value;
  } catch (e) {
    return null;
  }
}

// Transition issue to a new status (e.g. In Progress, Review)
async function transitionIssue(issueKey, statusName) {
  // Get available transitions
  const res = await axios.get(
    `${BASE_URL}/rest/api/3/issue/${issueKey}/transitions`,
    { auth }
  );
  const transition = res.data.transitions.find(
    t => t.name.toLowerCase() === statusName.toLowerCase()
  );
  if (!transition) {
    console.warn(`Transition "${statusName}" not found for ${issueKey}`);
    return;
  }
  await axios.post(
    `${BASE_URL}/rest/api/3/issue/${issueKey}/transitions`,
    { transition: { id: transition.id } },
    { auth }
  );
}

module.exports = { getIssue, addComment, setRevertMeta, getRevertMeta, transitionIssue };
