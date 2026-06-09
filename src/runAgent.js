const OpenAI = require('openai');
const { detectTaskType, TASK_TYPES } = require('./taskRouter');
const { getIssue, addComment, setRevertMeta, transitionIssue } = require('./jira');
const { cloneRepo, getCurrentSha, readFile, editFile, commitAndDeploy, cleanup } = require('./wpEngineDeploy');
const { createPost, updatePost, getPost, createPage, updatePage, getPage, searchContent, getPageBySlug, findPageByTitle } = require('./wpRest');
const { revertTask } = require('./revert');

// Initialize lazily so missing key doesn't crash the server at startup
let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

async function runAgent(issueKey) {
  console.log(`\n🤖 Processing Jira issue: ${issueKey}`);

  // 1. Fetch issue details
  const issue = await getIssue(issueKey);
  const title = issue.fields.summary;
  const description = issue.fields.description?.content
    ?.map(b => b.content?.map(c => c.text).join(''))
    .join('\n') || '';

  console.log(`📋 Task: ${title}`);

  // 2. Move to In Progress
  await transitionIssue(issueKey, 'In Progress').catch(() => {});
  await addComment(issueKey, `🤖 Agent started working on: "${title}"`);

  // 3. Detect task type
  const taskType = detectTaskType(title, description);
  console.log(`🔍 Detected task type: ${taskType}`);

  try {
    switch (taskType) {

      // ── FILE: Edit child theme CSS/PHP ──────────────────────────────
      case TASK_TYPES.FILE: {
        const { cloneDir, keyPath } = await cloneRepo();

        try {
          // Read current style.css as context
          const currentCss = readFile(cloneDir, 'style.css');
          const currentFunctions = readFile(cloneDir, 'functions.php').catch(() => '');

          // Ask OpenAI what to change
          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are a WordPress child theme developer. You will be given a task and the current theme files.
                Return a JSON object with the files to modify: { "file": "filename", "content": "full new file content" }[]
                Only modify files inside the child theme. Never touch parent theme or core files.`
              },
              {
                role: 'user',
                content: `Task: ${title}\n\nDescription: ${description}\n\nCurrent style.css:\n${currentCss}\n\nCurrent functions.php:\n${currentFunctions}`
              }
            ],
            response_format: { type: 'json_object' }
          });

          const changes = JSON.parse(aiResponse.choices[0].message.content);
          const fileChanges = Array.isArray(changes.files) ? changes.files : [changes];

          // Get current SHA before making changes (for revert)
          const oldSha = await getCurrentSha(cloneDir);

          // Apply changes
          for (const change of fileChanges) {
            editFile(cloneDir, change.file, change.content);
            console.log(`✏️  Edited: ${change.file}`);
          }

          // Commit and deploy to staging
          const newSha = await commitAndDeploy(cloneDir, keyPath, `[AI Agent] ${title} (BRIN: ${issueKey})`);

          // Store revert metadata
          await setRevertMeta(issueKey, {
            type: 'file',
            oldSha,
            newSha,
            timestamp: new Date().toISOString(),
            filesChanged: fileChanges.map(f => f.file)
          });

          await transitionIssue(issueKey, 'In Review').catch(() => {});
          await addComment(issueKey,
            `✅ Theme files updated and deployed to staging.\n\n` +
            `Files changed: ${fileChanges.map(f => f.file).join(', ')}\n` +
            `Staging URL: ${process.env.WP_STAGING_URL}\n\n` +
            `──────────────────────\n` +
            `💬 Available commands (add as a comment):\n` +
            `• \`approve\` — mark this change as approved and close the issue\n` +
            `• \`revert\` — undo this change completely\n` +
            `• \`run\` — re-run the agent on this issue`
          );
        } finally {
          cleanup(cloneDir);
        }
        break;
      }

      // ── CONTENT: Create/update posts or pages ──────────────────────
      case TASK_TYPES.CONTENT: {

        // Step 1 — Try to find the existing page intelligently
        // Extract page name hint from task title (e.g. "contact", "about", "services")
        const slugHints = title.toLowerCase().match(/\b(contact|about|services|home|pricing|blog|faq|gallery|team|booking|schedule|classes|yoga|meditation)\b/g) || [];
        const titleWords = title.replace(/[^a-z0-9 ]/gi, ' ').split(' ').filter(w => w.length > 3);

        let existingPage = null;

        // Try slug match first (most accurate)
        for (const slug of slugHints) {
          existingPage = await getPageBySlug(slug);
          if (existingPage) break;
        }

        // Fall back to title search
        if (!existingPage) {
          const searchResults = await findPageByTitle(slugHints[0] || titleWords[0] || title);
          if (searchResults.length > 0) existingPage = searchResults[0];
        }

        // Also try general search
        if (!existingPage) {
          const generalSearch = await searchContent(title);
          if (generalSearch.length > 0) {
            const pageResult = generalSearch.find(r => r.subtype === 'page');
            if (pageResult) {
              existingPage = await getPage(pageResult.id);
            }
          }
        }

        let savedContent = null;
        let postId = null;
        let contentIsPage = true;
        let action = 'create';

        if (existingPage) {
          // ── UPDATE existing page ──────────────────────────────────
          postId = existingPage.id;
          contentIsPage = true;
          action = 'update';

          // Save current content for revert
          savedContent = {
            title: existingPage.title?.rendered || existingPage.title?.raw,
            content: existingPage.content?.rendered || existingPage.content?.raw
          };

          const currentContent = existingPage.content?.rendered || '';
          const currentTitle = existingPage.title?.rendered || '';

          // Ask OpenAI to make ONLY the requested change — preserve everything else
          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are a precise WordPress page editor for Brinda Yoga website.
Your job is to make ONLY the specific change requested. Do NOT rewrite or redesign the page.
Preserve all existing HTML structure, CSS classes, design, and all other content exactly as-is.
Only modify the specific text, address, phone number, or element mentioned in the task.
Return JSON: { "title": "page title (unchanged unless title needs updating)", "content": "full updated HTML with ONLY the requested change made" }`
              },
              {
                role: 'user',
                content: `Task: ${title}\n\nAdditional details: ${description}\n\nCurrent page title: ${currentTitle}\n\nCurrent page HTML content:\n${currentContent}`
              }
            ],
            response_format: { type: 'json_object' }
          });

          const result = JSON.parse(aiResponse.choices[0].message.content);

          // Update as draft first for preview
          await updatePage(postId, {
            title: result.title,
            content: result.content,
            status: 'draft'
          });

        } else {
          // ── CREATE new page ───────────────────────────────────────
          contentIsPage = true;
          action = 'create';

          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are a WordPress content writer for Brinda Yoga, a yoga studio website.
Write clean, well-structured HTML content that matches a professional yoga studio design.
Return JSON: { "title": "page title", "content": "full HTML content" }`
              },
              {
                role: 'user',
                content: `Create a new page for this task: ${title}\n\nDetails: ${description}`
              }
            ],
            response_format: { type: 'json_object' }
          });

          const result = JSON.parse(aiResponse.choices[0].message.content);
          const created = await createPage(result.title, result.content, 'draft');
          postId = created.id;
        }

        // Store revert metadata
        await setRevertMeta(issueKey, {
          type: 'content',
          postId,
          postType: 'page',
          savedContent,
          timestamp: new Date().toISOString()
        });

        // Move to In Review
        await transitionIssue(issueKey, 'In Review').catch(() => {});

        const previewUrl = `${process.env.WP_STAGING_URL}/?page_id=${postId}&preview=true`;

        await addComment(issueKey,
          `✅ Page ${action === 'update' ? 'updated' : 'created'} as draft.\n\n` +
          `${existingPage ? `Existing page found: "${existingPage.title?.rendered}"` : 'New page created'}\n` +
          `Preview: ${previewUrl}\n\n` +
          `──────────────────────\n` +
          `💬 Next steps:\n` +
          `• Review the preview link above\n` +
          `• Drag this issue to *Deployment* column to publish live\n` +
          `• Comment \`revert\` to undo this change`
        );
        break;
      }

      // ── REVERT ──────────────────────────────────────────────────────
      case TASK_TYPES.REVERT: {
        await revertTask(issueKey);
        break;
      }

      // ── UNSUPPORTED (Phase 2/3/4 tasks) ─────────────────────────────
      default: {
        await addComment(issueKey,
          `⚠️ Task type "${taskType}" is not yet implemented in Phase 1.\n` +
          `Coming in a future phase: SEO, Nav, Elementor, Plugin management.`
        );
      }
    }
  } catch (err) {
    console.error(`❌ Error processing ${issueKey}:`, err.message);
    await addComment(issueKey, `❌ Agent encountered an error: ${err.message}`);
    await transitionIssue(issueKey, 'To Do').catch(() => {});
  }
}

module.exports = { runAgent };
