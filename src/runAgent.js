const OpenAI = require('openai');
const { detectTaskType, TASK_TYPES } = require('./taskRouter');
const { getIssue, addComment, setRevertMeta, transitionIssue, getRevertMeta } = require('./jira');
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
  await transitionIssue(issueKey, 'In Progress');
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

          await transitionIssue(issueKey, 'In Review');
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

          const currentContent = existingPage.content?.raw || existingPage.content?.rendered || '';
          const currentTitle = existingPage.title?.raw || existingPage.title?.rendered || '';

          // Save EXACT current content for revert — before any change
          savedContent = { title: currentTitle, content: currentContent };

          // Skip if page uses Elementor (content will be empty or shortcode)
          const isElementor = (existingPage.meta?._elementor_edit_mode === 'builder')
            || currentContent.includes('elementor')
            || currentContent.trim() === '';

          if (isElementor) {
            await addComment(issueKey,
              `⚠️ This page uses Elementor page builder.\n\n` +
              `Direct content editing is not supported yet (coming in Phase 3).\n` +
              `Please make this change manually in WP Admin → Elementor editor.\n\n` +
              `Page: ${process.env.WP_STAGING_URL}/wp-admin/post.php?post=${postId}&action=elementor`
            );
            await transitionIssue(issueKey, 'To Do');
            break;
          }

          // Ask OpenAI to make ONLY the requested change
          // Rules: preserve ALL existing HTML, only change what was asked
          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are a surgical WordPress page editor. Your ONLY job is to find and change the specific text mentioned in the task.

STRICT RULES:
1. Return the COMPLETE original HTML with ONLY the requested text changed
2. Do NOT add any new HTML elements, sections, or structure
3. Do NOT remove any existing HTML elements
4. Do NOT change any CSS classes, IDs, or attributes
5. Do NOT rewrite or rephrase any other content
6. If you cannot find the specific text to change, return the original content unchanged and set "changed": false

Return JSON: {
  "title": "exact same title unless title itself needs changing",
  "content": "complete HTML with only the specific change applied",
  "changed": true or false,
  "what_changed": "brief description of exactly what was changed"
}`
              },
              {
                role: 'user',
                content: `Task: ${title}\n\nDetails: ${description}\n\nCurrent title: ${currentTitle}\n\nCurrent HTML:\n${currentContent}`
              }
            ],
            response_format: { type: 'json_object' }
          });

          const result = JSON.parse(aiResponse.choices[0].message.content);

          if (!result.changed) {
            await addComment(issueKey,
              `⚠️ Could not find the specific content to change.\n\n` +
              `What I looked for: "${title}"\n` +
              `Please check the page manually: ${process.env.WP_STAGING_URL}/?page_id=${postId}\n\n` +
              `Comment \`run\` with a more specific description to try again.`
            );
            await transitionIssue(issueKey, 'In Review');
            break;
          }

          console.log(`✏️  Changed: ${result.what_changed}`);

          // Update ONLY content field — never touch slug, template, or meta
          await updatePage(postId, {
            title: result.title,
            content: result.content,
            status: existingPage.status  // keep existing status (published stays published as draft copy)
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
        await transitionIssue(issueKey, 'In Review');

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
    await transitionIssue(issueKey, 'To Do');
  }
}

// ── REDO: Fix based on client feedback and generate new preview ──────────────
async function redoTask(issueKey, feedback) {
  console.log(`\n🔁 Redo on ${issueKey}: "${feedback}"`);

  await addComment(issueKey, `🔄 Agent received your feedback — reworking now...\n\n> "${feedback}"`);
  await transitionIssue(issueKey, 'In Progress');

  try {
    // Get revert metadata to find the page/post that was previously edited
    const meta = await getRevertMeta(issueKey);

    if (!meta || meta.type !== 'content') {
      await addComment(issueKey,
        `⚠️ Could not find previously edited content to redo.\n` +
        `Please comment \`run\` to start fresh.`
      );
      await transitionIssue(issueKey, 'In Review');
      return;
    }

    const { postId, postType, savedContent } = meta;

    // Get current state of the page (what agent last produced)
    const currentPage = postType === 'page'
      ? await getPage(postId)
      : await getPost(postId);

    const currentContent = currentPage.content?.raw || currentPage.content?.rendered || '';
    const currentTitle = currentPage.title?.raw || currentPage.title?.rendered || '';

    // Ask OpenAI to apply the feedback correction
    const aiResponse = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a WordPress page editor fixing content based on client feedback.
You will be given:
1. The current page HTML (what the agent last produced)
2. The original page HTML (before any agent changes)
3. The client's feedback on what needs to be fixed

STRICT RULES:
1. Apply ONLY the correction described in the feedback
2. Do NOT change anything else
3. Keep all HTML structure, CSS classes, and attributes intact
4. Return the complete corrected HTML

Return JSON: {
  "title": "page title",
  "content": "complete corrected HTML",
  "what_changed": "brief description of what was fixed based on feedback"
}`
        },
        {
          role: 'user',
          content: `Client feedback: ${feedback}\n\nCurrent page title: ${currentTitle}\n\nCurrent page HTML (needs fixing):\n${currentContent}\n\nOriginal page HTML (before agent changes):\n${savedContent?.content || 'Not available'}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(aiResponse.choices[0].message.content);

    // Apply the fix
    if (postType === 'page') {
      await updatePage(postId, { title: result.title, content: result.content });
    } else {
      await updatePost(postId, { title: result.title, content: result.content });
    }

    console.log(`✏️  Redo applied: ${result.what_changed}`);

    // Update revert meta timestamp
    await setRevertMeta(issueKey, {
      ...meta,
      lastFeedback: feedback,
      timestamp: new Date().toISOString()
    });

    await transitionIssue(issueKey, 'In Review');

    const previewUrl = postType === 'page'
      ? `${process.env.WP_STAGING_URL}/?page_id=${postId}&preview=true`
      : `${process.env.WP_STAGING_URL}/?p=${postId}&preview=true`;

    await addComment(issueKey,
      `✅ Fixed based on your feedback.\n\n` +
      `What was changed: ${result.what_changed}\n` +
      `New preview: ${previewUrl}\n\n` +
      `──────────────────────\n` +
      `💬 Available commands:\n` +
      `• \`redo: <your feedback>\` — request another fix\n` +
      `• Drag to *Deployment* column to publish live\n` +
      `• \`revert\` — undo all changes back to original`
    );

  } catch (err) {
    console.error(`❌ Redo error on ${issueKey}:`, err.message);
    await addComment(issueKey, `❌ Redo failed: ${err.message}`);
    await transitionIssue(issueKey, 'In Review');
  }
}

module.exports = { runAgent, redoTask };
