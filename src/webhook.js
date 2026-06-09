require('dotenv').config();
const express = require('express');
const { runAgent } = require('./runAgent');
const { revertTask } = require('./revert');
const { getIssue, addComment, getRevertMeta, transitionIssue } = require('./jira');
const { updatePost, updatePage } = require('./wpRest');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

// Exact Jira transition names (confirmed via API)
const STATUS = {
  INBOX:       'To Do',       // new issues land here
  IN_PROGRESS: 'In Progress', // agent working
  IN_REVIEW:   'In Review',   // agent done, awaiting your review
  DEPLOYMENT:  'Deployment',  // you drag here to approve → agent publishes
  LIVE:        'Done'         // agent moves here after publishing
};

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    agent: 'WordPress AI Agent',
    project: PROJECT_KEY,
    workflow: 'Inbox → In Progress → In Review → Deployment → Live'
  });
});

// Publish a draft post/page live on staging
async function publishContent(issueKey, meta) {
  const { postId, postType } = meta;

  if (postType === 'page') {
    await updatePage(postId, { status: 'publish' });
  } else {
    await updatePost(postId, { status: 'publish' });
  }

  const liveUrl = postType === 'page'
    ? `${process.env.WP_STAGING_URL}/?page_id=${postId}`
    : `${process.env.WP_STAGING_URL}/?p=${postId}`;

  await transitionIssue(issueKey, STATUS.LIVE).catch(() => {});
  await addComment(issueKey,
    `🚀 ${postType === 'page' ? 'Page' : 'Post'} is now LIVE on staging!\n\n` +
    `Live URL: ${liveUrl}\n\n` +
    `──────────────────────\n` +
    `💬 Available commands:\n` +
    `• \`revert\` — undo and unpublish this change`
  );
}

// Jira webhook handler
app.post('/webhook/jira', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately so Jira doesn't retry

  const { webhookEvent, issue, comment, changelog } = req.body;

  if (!issue) return;

  const issueKey = issue.key;
  const projectKey = issue.fields?.project?.key;

  // Only handle issues from our project
  if (projectKey !== PROJECT_KEY) return;

  const currentStatus = issue.fields?.status?.name?.toLowerCase();

  try {

    // ── 1. New issue created → agent picks it up ───────────────────
    if (webhookEvent === 'jira:issue_created') {
      console.log(`📥 New issue: ${issueKey} — Status: ${currentStatus}`);
      await runAgent(issueKey);
    }

    // ── 2. Issue status changed ────────────────────────────────────
    if (webhookEvent === 'jira:issue_updated' && changelog) {
      const statusChange = changelog.items?.find(i => i.field === 'status');

      if (statusChange) {
        const newStatus = statusChange.toString?.toLowerCase() || statusChange.to?.toLowerCase();
        const newStatusName = statusChange.toString?.toLowerCase() || currentStatus;

        console.log(`🔄 ${issueKey} status changed to: ${currentStatus}`);

        // ── Moved to Deployment → publish live ──────────────────
        if (currentStatus === STATUS.DEPLOYMENT) {
          console.log(`🚀 Deployment triggered for: ${issueKey}`);
          const meta = await getRevertMeta(issueKey);

          if (!meta) {
            await addComment(issueKey, '⚠️ No draft metadata found. Please check the page/post manually in WP Admin.');
            return;
          }

          if (meta.type === 'content') {
            await addComment(issueKey, '⚙️ Publishing to staging...');
            await publishContent(issueKey, meta);
          } else if (meta.type === 'file') {
            // CSS/theme changes already deployed to staging via git push
            await transitionIssue(issueKey, STATUS.LIVE).catch(() => {});
            await addComment(issueKey,
              `🚀 Theme change is already live on staging!\n\n` +
              `Staging URL: ${process.env.WP_STAGING_URL}\n\n` +
              `• \`revert\` — undo this change`
            );
          }
        }

        // ── Moved back to Inbox → re-run agent ──────────────────
        if (currentStatus === STATUS.INBOX) {
          console.log(`🔁 Issue moved back to Inbox: ${issueKey}`);
          await runAgent(issueKey);
        }
      }
    }

    // ── 3. Comment added ───────────────────────────────────────────
    if (webhookEvent === 'jira:issue_updated' && comment) {
      const commentText = comment.body?.content
        ?.map(b => b.content?.map(c => c.text).join(''))
        .join('')
        .trim()
        .toLowerCase();

      console.log(`💬 Comment on ${issueKey}: "${commentText}"`);

      // revert
      if (commentText === 'revert') {
        console.log(`↩️  Revert requested on: ${issueKey}`);
        await revertTask(issueKey);
      }

      // run — manually re-trigger agent
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
  console.log(`\nWorkflow: Inbox → In Progress → In Review → Deployment → Live`);
  console.log(`Webhook URL: POST /webhook/jira\n`);
});
