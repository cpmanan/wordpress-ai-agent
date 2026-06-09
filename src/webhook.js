require('dotenv').config();
const express = require('express');
const { runAgent } = require('./runAgent');
const { revertTask } = require('./revert');
const { getIssue, addComment } = require('./jira');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AGENT_ACCOUNT_ID = process.env.JIRA_AGENT_ACCOUNT_ID;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', agent: 'WordPress AI Agent', project: PROJECT_KEY });
});

// Jira webhook handler
app.post('/webhook/jira', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately so Jira doesn't retry

  const { webhookEvent, issue, comment } = req.body;

  if (!issue) return;

  const issueKey = issue.key;
  const projectKey = issue.fields?.project?.key;

  // Only handle issues from our project
  if (projectKey !== PROJECT_KEY) return;

  try {
    // ── New issue created in Inbox → run agent ──────────────────────
    if (webhookEvent === 'jira:issue_created') {
      const status = issue.fields?.status?.name?.toLowerCase();
      if (status === 'inbox' || status === 'to do') {
        console.log(`📥 New issue: ${issueKey}`);
        await runAgent(issueKey);
      }
    }

    // ── Comment added → check for "revert" ─────────────────────────
    if (webhookEvent === 'jira:issue_updated' && comment) {
      const commentText = comment.body?.content
        ?.map(b => b.content?.map(c => c.text).join(''))
        .join('')
        .trim()
        .toLowerCase();

      if (commentText === 'revert') {
        // Only allow revert if the issue was last touched by the agent
        const fullIssue = await getIssue(issueKey);
        const assignee = fullIssue.fields?.assignee?.accountId;

        if (assignee === AGENT_ACCOUNT_ID) {
          console.log(`↩️  Revert requested on: ${issueKey}`);
          await revertTask(issueKey);
        } else {
          console.log(`⚠️  Revert on ${issueKey} ignored — not assigned to agent`);
        }
      }

      // ── Comment "run" → manually trigger agent ──────────────────
      if (commentText === 'run') {
        console.log(`▶️  Manual run triggered on: ${issueKey}`);
        await runAgent(issueKey);
      }
    }

  } catch (err) {
    console.error(`Webhook error for ${issueKey}:`, err.message);
    await addComment(issueKey, `❌ Webhook error: ${err.message}`).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 WordPress AI Agent running on port ${PORT}`);
  console.log(`📋 Jira project: ${PROJECT_KEY}`);
  console.log(`🌐 WP Staging: ${process.env.WP_STAGING_URL}`);
  console.log(`\nWebhook URL: POST /webhook/jira\n`);
});
