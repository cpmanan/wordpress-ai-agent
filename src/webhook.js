require('dotenv').config();
const express = require('express');
const { runAgent } = require('./runAgent');
const { revertTask } = require('./revert');
const { getIssue, addComment, getRevertMeta, transitionIssue } = require('./jira');
const { updatePost, updatePage } = require('./wpRest');

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

      // ── Comment "approve" → publish the draft live ──────────────
      if (commentText === 'approve') {
        console.log(`✅ Approve requested on: ${issueKey}`);
        const meta = await getRevertMeta(issueKey);

        if (!meta) {
          await addComment(issueKey, '⚠️ No draft found to approve. Nothing to publish.');
        } else if (meta.type === 'content') {
          const { postId, postType } = meta;
          if (postType === 'page') {
            await updatePage(postId, { status: 'publish' });
          } else {
            await updatePost(postId, { status: 'publish' });
          }
          const liveUrl = `${process.env.WP_STAGING_URL}/?page_id=${postId}`;
          await transitionIssue(issueKey, 'Done').catch(() => {});
          await addComment(issueKey,
            `🚀 ${postType === 'page' ? 'Page' : 'Post'} published live on staging!\n\n` +
            `Live URL: ${liveUrl}\n\n` +
            `To revert, comment: \`revert\``
          );
        } else {
          // For file/CSS changes — already live on staging after git push
          await transitionIssue(issueKey, 'Done').catch(() => {});
          await addComment(issueKey, '🚀 Change is already live on staging. Issue marked as Done.');
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
