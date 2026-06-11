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

// Confirmed transition IDs from BRIN project (via API on 2026-06-09)
const TRANSITION_IDS = {
  'to do':       '11',
  'in progress': '21',
  'in review':   '31',
  'deployment':  '2',
  'done':        '41'
};

// Transition issue to a new status using hardcoded IDs for reliability
async function transitionIssue(issueKey, statusName) {
  const id = TRANSITION_IDS[statusName.toLowerCase()];

  if (!id) {
    // Fallback: look up dynamically
    const res = await axios.get(
      `${BASE_URL}/rest/api/3/issue/${issueKey}/transitions`,
      { auth }
    );
    const transition = res.data.transitions.find(
      t => t.name.toLowerCase() === statusName.toLowerCase()
    );
    if (!transition) {
      console.warn(`⚠️  Transition "${statusName}" not found for ${issueKey}`);
      return;
    }
    await axios.post(
      `${BASE_URL}/rest/api/3/issue/${issueKey}/transitions`,
      { transition: { id: transition.id } },
      { auth }
    );
    console.log(`✅ Transitioned ${issueKey} → ${statusName} (dynamic)`);
    return;
  }

  await axios.post(
    `${BASE_URL}/rest/api/3/issue/${issueKey}/transitions`,
    { transition: { id } },
    { auth }
  );
  console.log(`✅ Transitioned ${issueKey} → ${statusName}`);
}

// Append plain text to issue description (used when agent needs page ID clarification)
async function appendToDescription(issueKey, extraText) {
  const issue = await getIssue(issueKey);
  // Get current description as plain text blocks
  const currentBlocks = issue.fields.description?.content || [];
  await axios.put(
    `${BASE_URL}/rest/api/3/issue/${issueKey}`,
    {
      fields: {
        description: {
          type: 'doc', version: 1,
          content: [
            ...currentBlocks,
            { type: 'paragraph', content: [{ type: 'text', text: extraText }] }
          ]
        }
      }
    },
    { auth }
  );
}

module.exports = { getIssue, addComment, setRevertMeta, getRevertMeta, transitionIssue, appendToDescription };
