const OpenAI = require('openai');
const { detectTaskType, TASK_TYPES } = require('./taskRouter');
const { getIssue, addComment, setRevertMeta, transitionIssue, getRevertMeta } = require('./jira');
const { cloneRepo, getCurrentSha, readFile, editFile, commitAndDeploy, cleanup } = require('./wpEngineDeploy');
const { createPost, updatePost, getPost, createPage, updatePage, getPage, searchContent, getPageBySlug, findPageByTitle } = require('./wpRest');
const { revertTask } = require('./revert');
const { getMenus, addPageToMenu, addUrlToMenu, getPlugins, installPlugin, deactivatePlugin, updateYoastSeo, exportDb } = require('./wpCli');

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

      // ── NAV: Create page + add to navigation menu ───────────────────
      case TASK_TYPES.NAV: {
        // Ask OpenAI what page to create and which menu to add it to
        const menus = await getMenus();
        const menuList = menus.map(m => `ID: ${m.term_id} | Name: ${m.name}`).join('\n');

        const aiResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are a WordPress site manager for Brinda Yoga website.
Given a task, decide:
1. Whether to create a new page or use an existing page
2. Which navigation menu to add it to
3. What the page content should be

Available menus:\n${menuList}

Return JSON: {
  "action": "create_and_add" or "add_existing",
  "pageTitle": "page title",
  "pageContent": "HTML content for the page (if creating new)",
  "menuName": "exact menu name from the list above",
  "menuItemTitle": "title to show in the menu",
  "menuPosition": null or number
}`
            },
            {
              role: 'user',
              content: `Task: ${title}\nDescription: ${description}`
            }
          ],
          response_format: { type: 'json_object' }
        });

        const navPlan = JSON.parse(aiResponse.choices[0].message.content);
        console.log(`📋 Nav plan: ${JSON.stringify(navPlan)}`);

        let pageId = null;

        // Create new page if needed
        if (navPlan.action === 'create_and_add') {
          const newPage = await createPage(navPlan.pageTitle, navPlan.pageContent, 'publish');
          pageId = newPage.id;
          console.log(`✅ Created page: "${navPlan.pageTitle}" (ID: ${pageId})`);
        } else {
          // Find existing page
          const found = await getPageBySlug(navPlan.pageTitle.toLowerCase().replace(/\s+/g, '-'));
          if (found) pageId = found.id;
        }

        // Add to navigation menu
        if (pageId && navPlan.menuName) {
          await addPageToMenu(navPlan.menuName, pageId, navPlan.menuItemTitle, navPlan.menuPosition);
          console.log(`✅ Added to menu: "${navPlan.menuName}"`);
        }

        // Store revert metadata
        await setRevertMeta(issueKey, {
          type: 'nav',
          pageId,
          menuName: navPlan.menuName,
          timestamp: new Date().toISOString()
        });

        await transitionIssue(issueKey, 'In Review');

        const previewUrl = pageId
          ? `${process.env.WP_STAGING_URL}/?page_id=${pageId}&preview=true`
          : process.env.WP_STAGING_URL;

        await addComment(issueKey,
          `✅ Page created and added to navigation.\n\n` +
          `Page: "${navPlan.pageTitle}"\n` +
          `Menu: "${navPlan.menuName}" → "${navPlan.menuItemTitle}"\n` +
          `Preview: ${previewUrl}\n\n` +
          `──────────────────────\n` +
          `💬 Available commands:\n` +
          `• Drag to *Deployment* to publish live\n` +
          `• \`redo: <feedback>\` — make changes\n` +
          `• \`revert\` — undo everything`
        );
        break;
      }

      // ── SEO: Update Yoast SEO metadata ──────────────────────────────
      case TASK_TYPES.SEO: {
        // Find the page/post mentioned in the task
        const slugHints = title.toLowerCase().match(/\b(contact|about|services|home|pricing|blog|faq|gallery|team|booking|schedule|classes|yoga|meditation)\b/g) || [];
        let targetPage = null;

        for (const slug of slugHints) {
          targetPage = await getPageBySlug(slug);
          if (targetPage) break;
        }

        if (!targetPage) {
          const results = await findPageByTitle(slugHints[0] || title);
          if (results.length > 0) targetPage = results[0];
        }

        if (!targetPage) {
          await addComment(issueKey, `⚠️ Could not find the page to update SEO for. Please specify the exact page name.`);
          await transitionIssue(issueKey, 'In Review');
          break;
        }

        // Export DB before SEO changes (for revert)
        const backupFile = await exportDb(issueKey);

        // Ask OpenAI to generate SEO metadata
        const seoResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are an SEO expert for Brinda Yoga, a yoga studio website.
Generate optimized Yoast SEO metadata.
Return JSON: {
  "seoTitle": "SEO title (max 60 chars)",
  "metaDescription": "Meta description (max 155 chars)",
  "focusKeyword": "primary focus keyword"
}`
            },
            {
              role: 'user',
              content: `Task: ${title}\nPage: "${targetPage.title?.rendered}"\nPage content: ${(targetPage.content?.rendered || '').substring(0, 500)}`
            }
          ],
          response_format: { type: 'json_object' }
        });

        const seoData = JSON.parse(seoResponse.choices[0].message.content);

        await updateYoastSeo(targetPage.id, {
          title: seoData.seoTitle,
          description: seoData.metaDescription,
          focusKeyword: seoData.focusKeyword
        });

        await setRevertMeta(issueKey, {
          type: 'db',
          backupFile,
          timestamp: new Date().toISOString()
        });

        await transitionIssue(issueKey, 'In Review');
        await addComment(issueKey,
          `✅ SEO metadata updated for "${targetPage.title?.rendered}".\n\n` +
          `SEO Title: ${seoData.seoTitle}\n` +
          `Meta Description: ${seoData.metaDescription}\n` +
          `Focus Keyword: ${seoData.focusKeyword}\n\n` +
          `──────────────────────\n` +
          `💬 Available commands:\n` +
          `• \`redo: <feedback>\` — adjust the SEO copy\n` +
          `• \`revert\` — restore previous SEO settings`
        );
        break;
      }

      // ── PLUGIN: Install / activate / deactivate ──────────────────────
      case TASK_TYPES.PLUGIN: {
        const pluginResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are a WordPress admin. Parse the plugin task and return JSON: {
  "action": "install" or "activate" or "deactivate" or "list",
  "pluginSlug": "wordpress-plugin-slug-from-wordpress.org",
  "pluginName": "Human readable plugin name"
}`
            },
            { role: 'user', content: `Task: ${title}\nDescription: ${description}` }
          ],
          response_format: { type: 'json_object' }
        });

        const pluginPlan = JSON.parse(pluginResponse.choices[0].message.content);
        console.log(`🔌 Plugin plan: ${JSON.stringify(pluginPlan)}`);

        if (pluginPlan.action === 'list') {
          const plugins = await getPlugins();
          const pluginList = plugins.map(p => `• ${p.name} (${p.status})`).join('\n');
          await addComment(issueKey, `📋 Installed plugins:\n\n${pluginList}`);
          await transitionIssue(issueKey, 'Done');
          break;
        }

        if (pluginPlan.action === 'install') {
          await installPlugin(pluginPlan.pluginSlug);
          await setRevertMeta(issueKey, {
            type: 'plugin',
            action: 'install',
            pluginSlug: pluginPlan.pluginSlug,
            timestamp: new Date().toISOString()
          });
          await transitionIssue(issueKey, 'Done');
          await addComment(issueKey,
            `✅ Plugin installed and activated: "${pluginPlan.pluginName}"\n\n` +
            `• \`revert\` — deactivate and remove this plugin`
          );
        }

        if (pluginPlan.action === 'deactivate') {
          await deactivatePlugin(pluginPlan.pluginSlug);
          await transitionIssue(issueKey, 'Done');
          await addComment(issueKey, `✅ Plugin deactivated: "${pluginPlan.pluginName}"`);
        }
        break;
      }

      // ── REVERT ──────────────────────────────────────────────────────
      case TASK_TYPES.REVERT: {
        await revertTask(issueKey);
        break;
      }

      // ── ELEMENTOR: Not yet supported ─────────────────────────────────
      case TASK_TYPES.ELEMENTOR: {
        await addComment(issueKey,
          `⚠️ Elementor page builder editing is coming in Phase 3.\n\n` +
          `For now, please edit this manually in WP Admin → Elementor editor.\n` +
          `Or rephrase the task as a plain content/CSS change.`
        );
        await transitionIssue(issueKey, 'In Review');
        break;
      }

      default: {
        await addComment(issueKey,
          `⚠️ Could not determine task type for: "${title}"\n\n` +
          `Please rephrase the task more specifically. Examples:\n` +
          `• "Change hero background color to navy" (theme/CSS)\n` +
          `• "Create a new Services page and add to navigation" (nav)\n` +
          `• "Install WooCommerce plugin" (plugin)\n` +
          `• "Update SEO meta for the About page" (SEO)\n` +
          `• "Add phone number to contact page" (content)`
        );
        await transitionIssue(issueKey, 'In Review');
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
