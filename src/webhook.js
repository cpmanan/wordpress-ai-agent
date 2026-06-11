require('dotenv').config();
const express = require('express');
const { runAgent, redoTask } = require('./runAgent');
const { revertTask } = require('./revert');
const { getIssue, addComment, getRevertMeta, transitionIssue } = require('./jira');
const { updatePost, updatePage } = require('./wpRest');
const { buildKnowledge, getKnowledge } = require('./siteKnowledge');

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

  // Log every incoming webhook so we can debug
  console.log(`📨 Webhook received: ${webhookEvent} | issue: ${issue?.key || 'none'} | hasComment: ${!!comment} | hasChangelog: ${!!changelog}`);

  if (!issue) {
    console.log(`⚠️  No issue in webhook payload. Keys: ${Object.keys(req.body).join(', ')}`);
    return;
  }

  const issueKey = issue.key;
  const projectKey = issue.fields?.project?.key;
  const projectName = issue.fields?.project?.name;

  console.log(`   Project key: "${projectKey}" | name: "${projectName}" | expected: "${PROJECT_KEY}"`);

  // Accept both project key (BRIN) and project name (brindayoga)
  if (projectKey !== PROJECT_KEY && projectName?.toLowerCase() !== PROJECT_KEY.toLowerCase()) return;

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
        // Ignore transitions made BY the agent (In Progress, In Review, Done)
        // Only act on transitions made BY YOU (To Do re-queue, Deployment approval)
        const agentTransitions = ['in progress', 'in review', 'done'];
        if (agentTransitions.includes(currentStatus?.toLowerCase())) {
          console.log(`⏭️  Ignoring agent-triggered transition to: ${currentStatus}`);
          return;
        }

        console.log(`🔄 ${issueKey} status changed to: ${currentStatus}`);

        // ── Moved to Deployment → publish live ──────────────────
        if (currentStatus?.toLowerCase() === STATUS.DEPLOYMENT.toLowerCase()) {
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
          } else if (meta.type === 'seo' || meta.type === 'nav') {
            // SEO and NAV changes are already applied — no publish step needed
            await transitionIssue(issueKey, STATUS.LIVE).catch(() => {});
            await addComment(issueKey,
              `✅ ${meta.type === 'seo' ? 'SEO metadata' : 'Navigation change'} approved and marked as Done.\n\n` +
              `• \`revert\` — undo this change`
            );
          } else {
            // Unknown type — just move to Done
            await transitionIssue(issueKey, STATUS.LIVE).catch(() => {});
          }
        }

        // NOTE: We do NOT auto-rerun when moved to "To Do".
        // Rerun is only triggered by: issue_created, comment "run", or comment "redo:"
        // Auto-rerun caused infinite loops when error handler moved issue back to To Do.
      }
    }

    // ── 3. Comment added ───────────────────────────────────────────
    // Jira sends comments as 'jira:issue_updated' with comment field
    // OR as separate 'comment_created' event — handle both
    const isCommentEvent = (webhookEvent === 'jira:issue_updated' && comment)
      || webhookEvent === 'comment_created';

    const commentData = comment || req.body.comment;

    if (isCommentEvent && commentData) {
      const comment = commentData; // normalize

      // Extract text from Jira comment body
      // Jira sends body as: plain string (comment_created) OR ADF object (issue_updated)
      function extractText(node) {
        if (!node) return '';
        if (typeof node === 'string') return node; // plain string
        if (node.type === 'text') return node.text || '';
        if (node.content && Array.isArray(node.content)) {
          return node.content.map(extractText).join('');
        }
        return '';
      }

      const commentRaw = extractText(comment.body).trim();
      const commentText = commentRaw.toLowerCase().trim();

      console.log(`💬 Comment on ${issueKey}: "${commentRaw}"`);

      // ── revert ──────────────────────────────────────────────────
      if (commentText === 'revert') {
        console.log(`↩️  Revert requested on: ${issueKey}`);
        await revertTask(issueKey);
      }

      // ── run — manually re-trigger agent ─────────────────────────
      if (commentText === 'run') {
        console.log(`▶️  Manual run triggered on: ${issueKey}`);
        await runAgent(issueKey);
      }

      // ── redo: <feedback> — fix based on feedback and re-preview ──
      if (commentText.startsWith('redo:') || commentText.startsWith('redo ')) {
        const feedback = commentRaw.replace(/^redo[: ]+/i, '').trim();
        console.log(`🔁 Redo requested on ${issueKey}: "${feedback}"`);
        await redoTask(issueKey, feedback);
      }

      // ── refresh knowledge — rebuild site knowledge base ──────────
      if (commentText === 'refresh knowledge' || commentText === 'rebuild knowledge') {
        console.log(`📚 Knowledge base refresh requested on: ${issueKey}`);
        await addComment(issueKey, `📚 Rebuilding site knowledge base — scanning pages, menus, plugins...`);
        try {
          const kb = await buildKnowledge();
          const activePlugins = (kb.plugins || []).filter(p => p.status === 'active').map(p => p.title);
          const elemPages = (kb.elementor_pages || []).map(p => `• ID ${p.id}: "${p.title}"`).join('\n');
          const menuSummary = (kb.menus || []).map(m => `• "${m.name}" (${m.items?.length} items)`).join('\n');
          await addComment(issueKey,
            `✅ Knowledge base updated!\n\n` +
            `*Site:* ${kb.site?.blogname}\n` +
            `*Pages:* ${kb.pages?.length} total | Front page ID: ${kb.front_page_id}\n` +
            `*Theme:* ${kb.theme?.child} (parent: ${kb.theme?.parent})\n\n` +
            `*Active plugins (${activePlugins.length}):*\n${activePlugins.map(p=>`• ${p}`).join('\n')}\n\n` +
            `*Menus:*\n${menuSummary}\n\n` +
            `*Elementor pages (${kb.elementor_pages?.length}):*\n${elemPages}\n\n` +
            `*Custom post types:* ${(kb.custom_post_types||[]).map(c=>c.slug).join(', ') || 'none'}\n\n` +
            `Agent will now use this knowledge for all future tasks.`
          );
        } catch (kbErr) {
          await addComment(issueKey, `❌ Knowledge base rebuild failed: ${kbErr.message}`);
        }
      }

      // ── show knowledge — display current knowledge base summary ──
      if (commentText === 'show knowledge') {
        const kb = getKnowledge();
        if (!kb) {
          await addComment(issueKey, `📚 No knowledge base found. Comment \`refresh knowledge\` to build one.`);
        } else {
          const activePlugins = (kb.plugins || []).filter(p => p.status === 'active').map(p => p.title);
          await addComment(issueKey,
            `📚 *Current Knowledge Base* (built ${kb.generated_at?.substring(0,10)})\n\n` +
            `*Pages:* ${kb.pages?.length}\n` +
            `*Elementor pages:* ${kb.elementor_pages?.length}\n` +
            `*Active plugins:* ${activePlugins.join(', ')}\n` +
            `*Menus:* ${(kb.menus||[]).map(m=>m.name).join(', ')}\n` +
            `*Front page ID:* ${kb.front_page_id}\n\n` +
            `Comment \`refresh knowledge\` to update.`
          );
        }
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
