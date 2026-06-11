const OpenAI = require('openai');
const { detectTaskType, TASK_TYPES } = require('./taskRouter');
const { getIssue, addComment, setRevertMeta, transitionIssue, getRevertMeta, getIssueImages } = require('./jira');
const { cloneRepo, getCurrentSha, readFile, readAgentContext, editFile, commitAndDeploy, purgeCache, cleanup, pollPipelineUntilDone } = require('./wpEngineDeploy');
const { getParentThemeContext } = require('./viharaContext');
const { capturePreview } = require('./screenshotter');
const { createPost, updatePost, getPost, createPage, updatePage, getPage, searchContent, getPageBySlug, findPageByTitle, getMenus, addPageToMenu, addUrlToMenu } = require('./wpRest');
const { revertTask } = require('./revert');
const { getPlugins, installPlugin, deactivatePlugin, updateYoastSeo, exportDb } = require('./wpCli');
const { getKnowledge, getContextForTask, isStale, buildKnowledge } = require('./siteKnowledge');
const { recallPage, rememberPage, rememberWidgetLearning, rememberQuirk, recordOutcome, getMemoryContext } = require('./agentMemory');

// Initialize lazily so missing key doesn't crash the server at startup
let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * Prepend site knowledge context to a system prompt.
 * kbCtx comes from getContextForTask() — injected into every GPT call
 * so the model knows exact page IDs, menu names, plugin states, etc.
 */
function withKb(systemContent, kbCtx) {
  if (!kbCtx) return systemContent;
  return `${kbCtx}\n\n---\n\n${systemContent}`;
}

async function runAgent(issueKey, feedbackContext = null, forcedTaskType = null) {
  const isReroute = !!forcedTaskType; // skip duplicate comment/transition on re-routes
  console.log(`\n🤖 Processing Jira issue: ${issueKey}${isReroute ? ` (re-route → ${forcedTaskType})` : ''}`);

  // 1. Fetch issue details
  const issue = await getIssue(issueKey);
  const title = issue.fields.summary;
  const description = issue.fields.description?.content
    ?.map(b => b.content?.map(c => c.text).join(''))
    .join('\n') || '';

  console.log(`📋 Task: ${title}`);

  // 2. Move to In Progress + post started comment (skip on re-route — already posted)
  if (!isReroute) {
    await transitionIssue(issueKey, 'In Progress');
    await addComment(issueKey, `🤖 Agent started working on: "${title}"`);
  }

  // 3. Detect task type (can be overridden when re-routing e.g. content → elementor)
  const taskType = forcedTaskType || detectTaskType(title, description);
  console.log(`🔍 Detected task type: ${taskType}${forcedTaskType ? ' (forced)' : ''}`);

  // 3b. Load site knowledge base — build it if missing or stale (>24h)
  let siteKb = getKnowledge();
  if (!siteKb) {
    console.log('📚 No knowledge base found — building one now...');
    try {
      siteKb = await buildKnowledge();
      await addComment(issueKey, `📚 Site knowledge base built (${siteKb.pages?.length} pages, ${siteKb.plugins?.filter(p=>p.status==='active').length} active plugins). Agent now has full site context.`);
    } catch (kbErr) {
      console.warn(`⚠️ Knowledge base build failed (non-fatal): ${kbErr.message}`);
    }
  } else if (isStale(24)) {
    // Refresh in background — don't block the task
    buildKnowledge().then(kb => {
      console.log(`📚 Knowledge base refreshed in background (${kb.pages?.length} pages)`);
    }).catch(e => console.warn(`⚠️ Background KB refresh failed: ${e.message}`));
  }
  const kbContext     = siteKb ? getContextForTask(taskType, siteKb) : '';
  const memoryContext = getMemoryContext();

  try {
    switch (taskType) {

      // ── FILE: Edit child theme CSS/PHP ──────────────────────────────
      case TASK_TYPES.FILE: {
        const { cloneDir } = await cloneRepo();

        try {
          // Read current theme files — readFile returns null if file doesn't exist
          const currentCss       = readFile(cloneDir, 'style.css') || '/* style.css is empty */';
          const currentFunctions = readFile(cloneDir, 'functions.php') || '<?php // functions.php is empty';

          // Read the agent context reference file from child theme repo
          const agentContext = readAgentContext(cloneDir);

          // Fetch relevant parent theme CSS rules live from the staging site
          const parentCssContext = await getParentThemeContext(title, description);

          // Get SHA before changes (for revert)
          const oldSha = await getCurrentSha(cloneDir);

          // Build context sections for the prompt
          const contextSection = [
            agentContext ? `## CHILD THEME SELECTOR REFERENCE (from _agent-context.md):\n${agentContext}` : '',
            parentCssContext ? `## PARENT THEME EXISTING RULES (live from staging — DO NOT duplicate these, only override):\n\`\`\`css\n${parentCssContext}\n\`\`\`` : '',
          ].filter(Boolean).join('\n\n---\n\n');

          // Ask OpenAI what to change
          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: withKb(`You are a WordPress child theme developer for Brinda Yoga website.
The site uses the VIHARA theme (v1.3.5) by ThemeREX. You MUST use Vihara-specific CSS selectors.
You will receive:
1. A task to complete
2. A selector reference guide (_agent-context.md)
3. Relevant parent theme CSS rules already in effect (so you know what to override)
4. The current child theme files

Make ONLY the specific change requested — do not rewrite unrelated styles.

CRITICAL RULES:
1. Always use !important on color/background/font overrides — parent theme has high specificity
2. Use ONLY the Vihara selectors from the reference (e.g. .sc_button NOT .btn)
3. Check the parent theme CSS provided — your override must be MORE specific or use !important
4. Return COMPLETE file content (not just the diff)
5. Only touch: style.css, functions.php, or custom PHP template files
6. Never modify parent theme files
7. Preserve the child theme header comment block in style.css (/* Theme Name: Vihara Child */ etc.)

Return JSON exactly like this:
{
  "files": [
    { "file": "style.css", "content": "/* full updated content */" },
    { "file": "functions.php", "content": "<?php // full updated content" }
  ],
  "summary": "brief description of what was changed"
}`, kbContext)
              },
              {
                role: 'user',
                content: `Task: ${title}\n\nDetails: ${description}${feedbackContext ? `\n\nPrevious attempt feedback: ${feedbackContext}` : ''}\n\n${contextSection}\n\n---\n\n## CURRENT CHILD THEME FILES:\n\nCurrent style.css:\n${currentCss}\n\nCurrent functions.php:\n${currentFunctions}`
              }
            ],
            response_format: { type: 'json_object' }
          });

          const aiResult = JSON.parse(aiResponse.choices[0].message.content);

          // Normalize — handle both {files:[]} and {file, content} shapes
          let fileChanges = [];
          if (Array.isArray(aiResult.files)) {
            fileChanges = aiResult.files;
          } else if (aiResult.file && aiResult.content) {
            fileChanges = [{ file: aiResult.file, content: aiResult.content }];
          } else {
            // Fallback: find any key that looks like a filename
            fileChanges = Object.entries(aiResult)
              .filter(([k]) => k.endsWith('.css') || k.endsWith('.php'))
              .map(([file, content]) => ({ file, content }));
          }

          if (fileChanges.length === 0) {
            throw new Error('OpenAI did not return any file changes. Try rephrasing the task.');
          }

          // Apply changes
          for (const change of fileChanges) {
            editFile(cloneDir, change.file, change.content);
          }

          // Commit → push to Bitbucket (pipeline auto-deploys to WP Engine)
          const { sha: newSha, wpeDeployed, noChanges } = await commitAndDeploy(
            cloneDir,
            `[AI Agent] ${title} (${issueKey})`
          );

          // ── Step comment: pipeline triggered (or no-op if nothing changed) ──
          if (noChanges) {
            await addComment(issueKey,
              `ℹ️ No file changes needed — staging already reflects this state.\n\n` +
              `Taking a fresh screenshot to confirm...`
            );
          } else {
            await addComment(issueKey,
              `🚀 Code committed and pushed to Bitbucket.\n\n` +
              `Files changed: ${fileChanges.map(f => f.file).join(', ')}\n` +
              `Commit: \`${newSha.slice(0, 8)}\`\n\n` +
              `⏳ Bitbucket Pipeline is now running — deploying to WP Engine staging...\n` +
              `[View pipeline →|https://bitbucket.org/${process.env.BITBUCKET_WORKSPACE || 'cp-jira'}/${process.env.BITBUCKET_REPO_SLUG || 'brindayoga'}/pipelines]`
            );
          }

          // Store revert metadata
          await setRevertMeta(issueKey, {
            type: 'file',
            oldSha,
            newSha,
            filesChanged: fileChanges.map(f => f.file),
            timestamp: new Date().toISOString()
          });

          // ── Poll Bitbucket until pipeline finishes (skip if no changes) ──
          const pipelineResult = noChanges ? 'SUCCESSFUL' : await pollPipelineUntilDone(newSha);

          if (pipelineResult === 'FAILED' || pipelineResult === 'STOPPED') {
            await addComment(issueKey,
              `❌ Bitbucket Pipeline ${pipelineResult.toLowerCase()}.\n\n` +
              `[Check pipeline logs →|https://bitbucket.org/${process.env.BITBUCKET_WORKSPACE || 'cp-jira'}/${process.env.BITBUCKET_REPO_SLUG || 'brindayoga'}/pipelines]`
            );
            await transitionIssue(issueKey, 'In Review');
            break;
          }

          // ── Pipeline succeeded (or UNKNOWN = no app password, assumed OK) ──
          const pipelineNote = pipelineResult === 'UNKNOWN'
            ? `✅ Deploy wait complete (pipeline polling not configured — set BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD in Railway for real-time pipeline status).`
            : `✅ Pipeline completed successfully — changes are live on staging.`;

          await addComment(issueKey, `${pipelineNote}\n\n⏳ Waiting 15s for WP Engine cache to settle, then taking screenshot...`);

          // Purge WP Engine page cache
          if (wpeDeployed) await purgeCache();

          // Short wait for WP Engine to settle after pipeline
          await new Promise(r => setTimeout(r, 15000));

          await transitionIssue(issueKey, 'In Review');

          // ── Screenshot: resolve page URL from task context
          let changedPageUrl = process.env.WP_STAGING_URL; // default: homepage
          const base = (process.env.WP_STAGING_URL || '').replace(/\/$/, '');

          // 1. Explicit URL in task title or description
          const pageUrlMatch = (title + ' ' + description).match(/https?:\/\/[^\s|"')>\]\n]+/);
          if (pageUrlMatch) {
            changedPageUrl = pageUrlMatch[0].replace(/[|"')>\]]+$/, '');
          } else {
            // 2. Known slug keyword → build URL directly (no API lookup needed)
            const slugHintMatch = (title + ' ' + description).toLowerCase()
              .match(/\b(faq|about|about-us|contact|services|classes|blog|schedule|team|gallery|pricing|booking)\b/);
            if (slugHintMatch) {
              changedPageUrl = `${base}/${slugHintMatch[0]}/`;
              console.log(`📸 Using slug-based URL: ${changedPageUrl}`);
            }
          }
          console.log(`📸 Taking screenshot of ${changedPageUrl}...`);
          const screenshotUrl = await capturePreview(issueKey, changedPageUrl);

          const screenshotLine = screenshotUrl
            ? `\n\n📸 *Full-page preview screenshot:*\n!${screenshotUrl}!`
            : '\n\n_(Screenshot could not be captured)_';

          await addComment(issueKey,
            `🖼️ Screenshot captured — here is the updated page:\n` +
            `Preview URL: ${changedPageUrl}${screenshotLine}\n\n` +
            `──────────────────────\n` +
            `Changed: ${aiResult.summary || fileChanges.map(f => f.file).join(', ')}\n` +
            `Files: ${fileChanges.map(f => f.file).join(', ')}\n\n` +
            `💬 Commands:\n` +
            `• Drag to *Deployment* to mark as approved\n` +
            `• \`redo: <feedback>\` — request a change\n` +
            `• \`revert\` — undo this change`
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

        // Detect if this is a blog post vs page
        const isBlogPost = /\b(blog post|article|news|post)\b/i.test(title + ' ' + description);
        console.log(`📝 Content type: ${isBlogPost ? 'blog post' : 'page'}`);

        let existingPage = null;

        if (!isBlogPost) {
          // 0. Explicit page ID in description — most specific, try first
          const explicitIdMatch = (description).match(/page\s+id[:\s]+(\d+)/i);
          if (explicitIdMatch) {
            try {
              existingPage = await getPage(parseInt(explicitIdMatch[1]));
              console.log(`✅ Found page by explicit ID ${explicitIdMatch[1]}: "${existingPage.title?.rendered}"`);
            } catch (e) { console.warn(`⚠️  Explicit page ID ${explicitIdMatch[1]} not found:`, e.message); }
          }

          // 1. Slug match
          if (!existingPage) {
            for (const slug of slugHints) {
              existingPage = await getPageBySlug(slug);
              if (existingPage) break;
            }
          }

          // 2. Title search
          if (!existingPage) {
            const searchResults = await findPageByTitle(slugHints[0] || titleWords[0] || title);
            if (searchResults.length > 0) existingPage = searchResults[0];
          }

          // 3. General search
          if (!existingPage) {
            const generalSearch = await searchContent(title);
            if (generalSearch.length > 0) {
              const pageResult = generalSearch.find(r => r.subtype === 'page');
              if (pageResult) existingPage = await getPage(pageResult.id);
            }
          }
        }

        let savedContent = null;
        let postId = null;
        let contentIsPage = !isBlogPost;
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
            // Page is Elementor-built — re-run through ELEMENTOR path automatically
            console.log(`🔄 Page ${postId} uses Elementor — re-routing to ELEMENTOR handler`);
            await runAgent(issueKey, null, 'elementor');
            return;
          }

          // Detect full-replace intent: "replace", "rewrite", or page ID explicitly specified in description
          const isFullReplace = /\b(replace|rewrite|rebuild|new content|full content)\b/i.test(title + ' ' + description)
            || /page id\s*\d+/i.test(description)
            || currentContent.trim() === '';

          // Ask OpenAI to edit the page content
          const systemPrompt = isFullReplace
            ? `You are a WordPress content writer for Brinda Yoga. Your job is to write completely new page content as specified in the task.
Return JSON: {
  "title": "page title (keep existing unless task specifies a new one)",
  "content": "full new HTML content for the page",
  "changed": true,
  "what_changed": "Replaced entire page content as requested"
}`
            : `You are a surgical WordPress page editor. Your ONLY job is to find and change the specific text mentioned in the task.

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
}`;

          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: withKb(systemPrompt, kbContext) },
              {
                role: 'user',
                content: isFullReplace
                  ? `Task: ${title}\n\nDetails: ${description}\n\nCurrent title: ${currentTitle}`
                  : `Task: ${title}\n\nDetails: ${description}\n\nCurrent title: ${currentTitle}\n\nCurrent HTML:\n${currentContent}`
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

        } else if (isBlogPost) {
          // ── CREATE new blog post ──────────────────────────────────
          contentIsPage = false;
          action = 'create';

          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: withKb(`You are a content writer for Brinda Yoga, a professional yoga studio website.
Write an engaging, informative blog post that reflects the brand voice of a mindful yoga studio.
Use well-structured HTML with headings, paragraphs, and lists where appropriate.
Return JSON: { "title": "blog post title", "content": "full HTML content", "excerpt": "brief summary (1-2 sentences)" }`, kbContext)
              },
              {
                role: 'user',
                content: `Create a blog post for: ${title}\n\nDetails: ${description}`
              }
            ],
            response_format: { type: 'json_object' }
          });

          const result = JSON.parse(aiResponse.choices[0].message.content);
          const created = await createPost(result.title, result.content, 'draft', result.excerpt);
          postId = created.id;

        } else {
          // ── CREATE new page ───────────────────────────────────────
          contentIsPage = true;
          action = 'create';

          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: withKb(`You are a WordPress content writer for Brinda Yoga, a yoga studio website.
Write clean, well-structured HTML content that matches a professional yoga studio design.
Return JSON: { "title": "page title", "content": "full HTML content" }`, kbContext)
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
        const postType = contentIsPage ? 'page' : 'post';
        await setRevertMeta(issueKey, {
          type: 'content',
          postId,
          postType,
          savedContent,
          timestamp: new Date().toISOString()
        });

        // Move to In Review
        await transitionIssue(issueKey, 'In Review');

        const previewUrl = contentIsPage
          ? `${process.env.WP_STAGING_URL}/?page_id=${postId}&preview=true`
          : `${process.env.WP_STAGING_URL}/?p=${postId}&preview=true`;

        // Screenshot: only works for published pages (preview URLs require WP auth)
        // Use the page's public link if it's already published, skip for drafts
        const existingStatus = existingPage?.status || 'draft';
        const publicLink = existingPage?.link || null;
        const contentScreenshotUrl = (existingStatus === 'publish' && publicLink)
          ? await capturePreview(issueKey, publicLink)
          : null;
        const contentScreenshotLine = contentScreenshotUrl
          ? `\n\n📸 *Page screenshot:*\n!${contentScreenshotUrl}!`
          : '';

        const contentLabel = contentIsPage ? 'Page' : 'Blog post';
        await addComment(issueKey,
          `✅ ${contentLabel} ${action === 'update' ? 'updated' : 'created'} as draft.\n\n` +
          `${existingPage ? `Page: "${existingPage.title?.rendered}"` : `New ${contentLabel.toLowerCase()} created`}\n` +
          `Preview: ${previewUrl}${contentScreenshotLine}\n\n` +
          `──────────────────────\n` +
          `💬 Commands:\n` +
          `• Drag to *Deployment* column to publish live\n` +
          `• \`redo: <feedback>\` — something not right? describe the fix\n` +
          `• \`revert\` — undo all changes`
        );
        break;
      }

      // ── NAV: Create page + add to navigation menu ───────────────────
      case TASK_TYPES.NAV: {
        // Ask OpenAI what page to create and which menu to add it to
        const menus = await getMenus();
        const menuList = menus.map(m => `ID: ${m.id} | Name: ${m.name} | Slug: ${m.slug}`).join('\n');

        const aiResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: withKb(`You are a WordPress site manager for Brinda Yoga website.
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
  "menuId": numeric menu ID from the list above,
  "menuItemTitle": "title to show in the menu",
  "menuPosition": null or number
}`, kbContext)
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
        if (pageId && (navPlan.menuId || navPlan.menuName)) {
          await addPageToMenu(navPlan.menuId || navPlan.menuName, pageId, navPlan.menuItemTitle, navPlan.menuPosition);
          console.log(`✅ Added to menu: "${navPlan.menuName}"`);
        }

        // Store revert metadata
        await setRevertMeta(issueKey, {
          type: 'nav',
          pageId,
          menuId:   navPlan.menuId || navPlan.menuName,
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
          `• \`redo: <feedback>\` — make changes\n` +
          `• \`revert\` — undo everything`
        );
        break;
      }

      // ── SEO: Update Yoast SEO metadata via REST API ─────────────────
      case TASK_TYPES.SEO: {
        const axios = require('axios');
        const WP_BASE = process.env.WP_STAGING_URL;
        const wpAuth  = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };

        let targetPage = null;

        // Helper: list all published pages (for homepage detection fallback)
        async function getAllPages() {
          const res = await axios.get(`${WP_BASE}/wp-json/wp/v2/pages`, {
            auth: wpAuth,
            params: { per_page: 100, status: 'publish', _fields: 'id,title,slug,link,content,meta' }
          });
          return res.data;
        }

        // 1. Homepage — try WP settings first, then slug/title fallbacks
        // Only check title for homepage intent — description often mentions "homepage" as context/example text
        const isHomepage = /\b(homepage|home page|front page)\b/i.test(title) ||
                           /\bfor (the )?(home ?page|front page)\b/i.test(description);
        if (isHomepage) {
          // 1a. WP Reading Settings → page_on_front
          try {
            const settingsRes = await axios.get(`${WP_BASE}/wp-json/wp/v2/settings`, { auth: wpAuth });
            const frontPageId = settingsRes.data?.page_on_front;
            if (frontPageId && frontPageId !== 0) {
              targetPage = await getPage(frontPageId);
              console.log(`✅ Homepage via settings (page_on_front=${frontPageId}): "${targetPage.title?.rendered}"`);
            }
          } catch (e) {
            console.warn('⚠️  WP settings API failed:', e.message);
          }

          // 1b. Try common homepage slugs
          if (!targetPage) {
            for (const slug of ['home', 'homepage', 'front-page', 'welcome']) {
              targetPage = await getPageBySlug(slug);
              if (targetPage) { console.log(`✅ Homepage via slug "${slug}"`); break; }
            }
          }

          // 1c. Find page whose URL is the root (site URL without path)
          if (!targetPage) {
            try {
              const allPages = await getAllPages();
              const siteUrl  = WP_BASE.replace(/\/$/, '');
              targetPage = allPages.find(p => p.link?.replace(/\/$/, '') === siteUrl) || null;
              if (targetPage) console.log(`✅ Homepage via root URL match: "${targetPage.title?.rendered}"`);
            } catch (e) {
              console.warn('⚠️  getAllPages fallback failed:', e.message);
            }
          }
        }

        // Extract the target page name from the task title once — used in steps 2, 3, 4
        const cleanTitle = title
          .replace(/phase \d+\s*test \d+\s*:?\s*/i, '')
          .replace(/update\s+(seo\s+)?(meta\s*(description\s*)?)?(and\s+seo\s+title\s*)?(for\s+(the\s+)?)?/i, '')
          .replace(/\bseo\s+(title|meta|description|metadata)\s*(for\s+(the\s+)?)?/i, '')
          .replace(/\s+page\s*$/i, '')
          .trim();
        console.log(`🔍 Target page name extracted: "${cleanTitle}"`);

        // Get the front page ID once so we can exclude it from non-homepage searches
        let frontPageId = null;
        try {
          const settingsRes = await axios.get(`${WP_BASE}/wp-json/wp/v2/settings`, { auth: wpAuth });
          frontPageId = settingsRes.data?.page_on_front || null;
        } catch (e) { /* ignore */ }

        // 2. Slug search — try common slug variants of the extracted page name
        if (!targetPage) {
          const slugVariants = [
            cleanTitle.toLowerCase().replace(/\s+/g, '-'),  // "about us" → "about-us"
            cleanTitle.toLowerCase().replace(/\s+/g, ''),   // "about us" → "aboutus"
            cleanTitle.toLowerCase().split(/\s+/)[0],       // first word: "about"
          ];
          // Also pull known slugs from the title text
          const knownSlugs = (title + ' ' + description).toLowerCase()
            .match(/\b(contact|about|services|pricing|blog|faq|gallery|team|booking|schedule|classes|yoga|meditation|about-us|our-story|who-we-are)\b/g) || [];
          const allSlugs = [...new Set([...slugVariants, ...knownSlugs])];

          for (const slug of allSlugs) {
            const found = await getPageBySlug(slug);
            if (found && found.id !== frontPageId) {
              targetPage = found;
              console.log(`✅ Found page by slug "${slug}": "${targetPage.title?.rendered}"`);
              break;
            }
          }
        }

        // 3. Title search with the extracted page name
        if (!targetPage) {
          console.log(`🔍 Searching pages by title: "${cleanTitle}"`);
          const results = await findPageByTitle(cleanTitle);
          // Exclude the front page unless we're explicitly looking for the homepage
          const filtered = results.filter(p => p.id !== frontPageId);
          if (filtered.length > 0) {
            targetPage = filtered[0];
            console.log(`✅ Found page by title search: "${targetPage.title?.rendered}"`);
          } else if (results.length > 0 && results[0].id !== frontPageId) {
            targetPage = results[0];
            console.log(`✅ Found page by title search: "${targetPage.title?.rendered}"`);
          }
        }

        // 4. Content search — use cleanTitle, exclude homepage
        if (!targetPage) {
          const searchResults = await searchContent(cleanTitle);
          const pageResult = searchResults.find(r => r.subtype === 'page' && r.id !== frontPageId);
          if (pageResult) {
            targetPage = await getPage(pageResult.id);
            console.log(`✅ Found page via content search: "${targetPage.title?.rendered}"`);
          }
        }

        if (!targetPage) {
          await addComment(issueKey,
            `⚠️ Could not find a page matching *"${cleanTitle}"*.\n\n` +
            `Tried slugs, title search, and content search — no match found (homepage excluded).\n\n` +
            `Please check the exact page title in WP Admin → Pages and update the task title to match. Examples:\n` +
            `• "Update SEO for the *About* page" (if slug is /about/)\n` +
            `• "Update SEO for the *Our Story* page"\n` +
            `• "Update SEO for the *Contact* page"`
          );
          await transitionIssue(issueKey, 'In Review');
          break;
        }

        // 3. Save current Yoast meta for revert (read before overwriting)
        let savedSeoMeta = {};
        try {
          const pageData = await axios.get(`${WP_BASE}/wp-json/wp/v2/pages/${targetPage.id}`, {
            auth: wpAuth,
            params: { _fields: 'id,yoast_head_json,meta' }
          });
          savedSeoMeta = pageData.data?.meta || {};
        } catch (e) {
          console.warn('⚠️  Could not read existing Yoast meta:', e.message);
        }

        // 4. Ask OpenAI to generate SEO metadata
        const seoResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: withKb(`You are an SEO expert for Brinda Yoga, a yoga studio website.
Generate optimized Yoast SEO metadata. Use the task requirements if specific values are provided,
otherwise generate appropriate values based on the page content.
Return JSON: {
  "seoTitle": "SEO title (max 60 chars)",
  "metaDescription": "Meta description (max 155 chars)",
  "focusKeyword": "primary focus keyword"
}`, kbContext)
            },
            {
              role: 'user',
              content: `Task: ${title}\n\nDetails: ${description}\n\nPage: "${targetPage.title?.rendered}"\nPage content snippet: ${(targetPage.content?.rendered || '').replace(/<[^>]+>/g, '').substring(0, 500)}`
            }
          ],
          response_format: { type: 'json_object' }
        });

        const seoData = JSON.parse(seoResponse.choices[0].message.content);

        // 5. Ensure the custom agent SEO endpoint exists in functions.php, then deploy.
        // Background: WordPress REST API silently blocks writes to _-prefixed meta keys
        // (Yoast's convention) unless the plugin registers auth_callback. Yoast does not.
        // WP CLI (SSH) is also unavailable on Railway. Solution: deploy a tiny custom
        // REST endpoint to the child theme that calls update_post_meta() directly —
        // no meta key restrictions, no SSH needed.
        const AGENT_SEO_ENDPOINT_MARKER = '// brinda-agent: SEO endpoint v1';
        const agentSeoEndpointPhp = `

${AGENT_SEO_ENDPOINT_MARKER}
add_action('rest_api_init', function() {
    register_rest_route('brinda-agent/v1', '/update-seo', [
        'methods'             => 'POST',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
        'callback'            => function(WP_REST_Request $req) {
            $post_id = intval($req->get_param('post_id'));
            if (!$post_id) return new WP_Error('invalid', 'post_id required', ['status' => 400]);
            if ($req->get_param('seo_title'))
                update_post_meta($post_id, '_yoast_wpseo_title',    sanitize_text_field($req->get_param('seo_title')));
            if ($req->get_param('meta_desc'))
                update_post_meta($post_id, '_yoast_wpseo_metadesc', sanitize_text_field($req->get_param('meta_desc')));
            if ($req->get_param('focus_kw'))
                update_post_meta($post_id, '_yoast_wpseo_focuskw',  sanitize_text_field($req->get_param('focus_kw')));
            return ['success' => true, 'post_id' => $post_id];
        },
    ]);
});
`;

        // Clone theme, inject endpoint if missing, deploy
        const { cloneDir: seoCloneDir } = await cloneRepo();
        let endpointDeployed = false;
        let newSeoSha;
        try {
          const currentFunctions = readFile(seoCloneDir, 'functions.php') || '';
          if (!currentFunctions.includes(AGENT_SEO_ENDPOINT_MARKER)) {
            const updated = currentFunctions.trimEnd() + '\n' + agentSeoEndpointPhp;
            editFile(seoCloneDir, 'functions.php', updated);
            const { sha, noChanges } = await commitAndDeploy(seoCloneDir, '[AI Agent] Add brinda-agent SEO REST endpoint');
            newSeoSha = sha;
            endpointDeployed = !noChanges;
            console.log(`✅ SEO endpoint deployed (SHA: ${sha?.slice(0, 8)})`);
          } else {
            console.log('✅ SEO endpoint already present in functions.php — skipping deploy');
            endpointDeployed = false; // already there
          }
        } finally {
          cleanup(seoCloneDir);
        }

        // If we just deployed, wait for the Bitbucket pipeline to finish
        if (endpointDeployed && newSeoSha) {
          await addComment(issueKey, `⚙️ Deploying SEO endpoint to staging — waiting for pipeline...`);
          const pipelineResult = await pollPipelineUntilDone(newSeoSha);
          console.log(`Pipeline result: ${pipelineResult}`);
          await purgeCache();
          // Brief settle time for WP to load new functions.php
          await new Promise(r => setTimeout(r, 5000));
        }

        // 5b. Call the custom endpoint — now writes directly to wp_postmeta
        let metaWriteConfirmed = false;
        try {
          const seoEndpointRes = await axios.post(
            `${WP_BASE}/wp-json/brinda-agent/v1/update-seo`,
            {
              post_id:   targetPage.id,
              seo_title: seoData.seoTitle,
              meta_desc: seoData.metaDescription,
              focus_kw:  seoData.focusKeyword,
            },
            { auth: wpAuth }
          );
          metaWriteConfirmed = seoEndpointRes.data?.success === true;
          console.log(`✅ SEO endpoint response:`, JSON.stringify(seoEndpointRes.data));
        } catch (endpointErr) {
          throw new Error(`SEO endpoint call failed (${endpointErr.response?.status}): ${endpointErr.response?.data?.message || endpointErr.message}`);
        }

        // 5c. Verify via REST GET — confirm the meta is now stored
        let yoastHeadJson = null;
        let verifiedTitle = null;
        try {
          const verifyRes = await axios.get(
            `${WP_BASE}/wp-json/wp/v2/pages/${targetPage.id}`,
            { auth: wpAuth, params: { _fields: 'id,yoast_head_json,meta' } }
          );
          verifiedTitle = verifyRes.data?.meta?._yoast_wpseo_title || null;
          yoastHeadJson = verifyRes.data?.yoast_head_json || null;
          if (verifiedTitle) metaWriteConfirmed = true;
          console.log(`🔍 Verified — stored title: "${verifiedTitle}", yoast: "${yoastHeadJson?.title || '?'}"`);
        } catch (e) {
          console.warn('⚠️  Could not verify stored meta:', e.message);
        }

        // 6. Store revert metadata (saved meta for rollback)
        await setRevertMeta(issueKey, {
          type: 'seo',
          pageId: targetPage.id,
          savedSeoMeta,
          timestamp: new Date().toISOString()
        });

        await transitionIssue(issueKey, 'In Review');

        // Build preview & verification URLs
        const pageUrl      = targetPage.link || `${WP_BASE}/?page_id=${targetPage.id}`;
        const wpAdminUrl   = `${WP_BASE}/wp-admin/post.php?post=${targetPage.id}&action=edit`;
        const viewSourceTip = `To verify: open the page → right-click → View Page Source → search for \`og:title\` or \`description\``;

        const writeStatus = metaWriteConfirmed
          ? `✅ Meta written directly to database via custom agent endpoint`
          : `⚠️ Meta write unconfirmed — stored: "${verifiedTitle || '(empty)'}"\n  → Check WP Admin → Edit page → Yoast SEO section`;

        const yoastTitleOutput = yoastHeadJson?.title
          ? `🔍 Yoast \`<title>\` will render as: *${yoastHeadJson.title}*`
          : `🔍 Changes saved — refresh the page to see updated \`<title>\` and \`<meta name="description">\` in view-source`;

        await addComment(issueKey,
          `✅ SEO metadata updated for *"${targetPage.title?.rendered}"* (page ID: ${targetPage.id})\n\n` +
          `*SEO Title:* ${seoData.seoTitle}\n` +
          `*Meta Description:* ${seoData.metaDescription}\n` +
          `*Focus Keyword:* ${seoData.focusKeyword}\n\n` +
          `──────────────────────\n` +
          `*Write Verification:*\n${writeStatus}\n\n` +
          `${yoastTitleOutput}\n\n` +
          `──────────────────────\n` +
          `🔗 *Preview & Verify:*\n` +
          `• [View page|${pageUrl}] — check the live page\n` +
          `• [WP Admin → Edit|${wpAdminUrl}] — scroll to Yoast SEO section to confirm\n` +
          `• ${viewSourceTip}\n\n` +
          `──────────────────────\n` +
          `💬 Commands:\n` +
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
              content: withKb(`You are a WordPress admin. Parse the plugin task and return JSON: {
  "action": "install" or "activate" or "deactivate" or "list",
  "pluginSlug": "wordpress-plugin-slug-from-wordpress.org",
  "pluginName": "Human readable plugin name"
}`, kbContext)
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
        // Support two patterns:
        // 1. Comment "revert" on the ORIGINAL issue → revert that issue itself
        // 2. New task with "revert BRIN-XX" in title/description → extract target key
        const referencedKey = (`${title} ${description}`.match(/\b(BRIN-\d+)\b/i) || [])[1];
        const targetKey = (referencedKey && referencedKey.toUpperCase() !== issueKey.toUpperCase())
          ? referencedKey.toUpperCase()
          : issueKey;

        if (targetKey !== issueKey) {
          await addComment(issueKey, `🔄 Reverting changes from *${targetKey}*...`);
        }

        await revertTask(targetKey, issueKey);
        break;
      }

      // ── ELEMENTOR: Edit Elementor page builder content ───────────────
      case TASK_TYPES.ELEMENTOR: {
        const axios      = require('axios');
        const WP_BASE    = process.env.WP_STAGING_URL;
        const wpAuth     = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };
        const agentHdrs  = { 'X-Agent-Token': process.env.AGENT_TOKEN || '' };

        // 1. Find the target page — explicit page ID in description takes priority
        const elemIdMatch = (description).match(/page\s+id[:\s]+(\d+)/i);
        let elemPage = null;
        if (elemIdMatch) {
          elemPage = await getPage(parseInt(elemIdMatch[1]));
        } else {
          // Helper: pick the best match from a list, preferring Elementor pages
          const elemPageIds = new Set((siteKb?.elementor_pages || []).map(p => p.id));
          function bestMatch(pages) {
            if (!pages?.length) return null;
            // Prefer Elementor pages; within that prefer exact title match
            const elems = pages.filter(p => elemPageIds.has(p.id || p.ID));
            return (elems[0] || pages[0]);
          }

          // Try slug/title search using knowledge base first (avoids REST round-trips)
          const taskText = (title + ' ' + description).toLowerCase();

          // ── Priority 0: agent memory — confirmed page from a past task ──────
          const rememberedPage = recallPage(taskText);
          if (rememberedPage) {
            elemPage = await getPage(rememberedPage.id);
            console.log(`🧠 Memory match: "${rememberedPage.title}" (ID: ${rememberedPage.id}) — confirmed by ${rememberedPage.confirmed_by}`);
          }

          // ── Priority 1: explicit page ID in description e.g. "page ID: 193" ──
          const pageIdMatch = description.match(/page\s+id[:\s]+(\d+)/i);
          if (pageIdMatch) {
            const forcedId = parseInt(pageIdMatch[1]);
            elemPage = await getPage(forcedId);
            console.log(`🎯 Using explicit page ID from description: ${forcedId}`);
          }

          // ── Priority 2: URL in description — extract slug or post ID ──
          // Handles: https://site.com/about-us/  OR  ?page_id=193  OR  post=193
          if (!elemPage) {
            const urlMatch = description.match(/https?:\/\/[^\s]+/i);
            if (urlMatch) {
              const url = urlMatch[0];
              const postIdFromUrl = url.match(/[?&](?:page_id|p|post)=(\d+)/)?.[1]
                                 || url.match(/post\.php\?post=(\d+)/)?.[1];
              if (postIdFromUrl) {
                elemPage = await getPage(parseInt(postIdFromUrl));
                console.log(`🎯 Extracted page ID ${postIdFromUrl} from URL in description`);
              } else {
                // Extract slug from URL path e.g. /about-us/ → "about-us"
                const slugFromUrl = url.replace(/[?#].*/, '').replace(/\/$/, '').split('/').pop();
                if (slugFromUrl && slugFromUrl.length > 1) {
                  const bySlug = await getPageBySlug(slugFromUrl);
                  if (bySlug) {
                    elemPage = bySlug;
                    console.log(`🎯 Matched slug "${slugFromUrl}" from URL in description → page ID ${bySlug.id}`);
                  }
                }
              }
            }
          }

          if (siteKb?.elementor_pages?.length && !elemPage) {
            // Score each Elementor page by how many task words match its title
            // Skip auto-generated Elementor library titles like "Elementor Page #7402"
            const taskWords = taskText.split(/\W+/).filter(w => w.length > 2);
            const scoredPages = siteKb.elementor_pages
              .filter(p => !/^elementor\s+page\s+#\d+$/i.test(p.title.trim()))
              .map(p => ({
                page:  p,
                score: taskWords.filter(w => p.title.toLowerCase().includes(w)).length,
              }))
              .filter(x => x.score > 0)
              .sort((a, b) => b.score - a.score);

            // If top 2 scores are close (within 1), agent is uncertain — ask for clarification
            const CONFIDENCE_THRESHOLD = 2; // minimum score to proceed without asking
            const topScore = scoredPages[0]?.score || 0;
            const secondScore = scoredPages[1]?.score || 0;
            const isAmbiguous = topScore < CONFIDENCE_THRESHOLD || (topScore - secondScore) <= 1;

            if (isAmbiguous && scoredPages.length > 0) {
              // Ask user which page to edit instead of guessing
              const options = scoredPages.slice(0, 4).map((x, i) =>
                `• *${x.page.title}* (ID: ${x.page.id}) — /${x.page.slug}/`
              ).join('\n');
              await addComment(issueKey,
                `🤔 I found multiple possible pages for this task and I'm not confident which one to edit.\n\n` +
                `*Top matches:*\n${options}\n\n` +
                `Please reply with one of:\n` +
                `• \`page: <ID>\` — e.g. \`page: 193\`\n` +
                `• Paste the Elementor editor URL: \`https://…/post.php?post=193&action=elementor\`\n` +
                `• Add \`page ID: 193\` to the task description and comment \`run\``
              );
              await transitionIssue(issueKey, 'In Review');
              break;
            }

            // Confident enough — try pages in score order, skip those with no Elementor data
            for (const { page: kbPage, score } of scoredPages) {
              const candidate = await getPage(kbPage.id);
              let hasData = false;
              try {
                const chkRes = await axios.get(`${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`, {
                  headers: agentHdrs, params: { post_id: kbPage.id }
                });
                hasData = !!(chkRes.data?.elementor_data);
              } catch {}
              if (hasData) {
                elemPage = candidate;
                console.log(`✅ Matched Elementor page from KB: "${kbPage.title}" (ID: ${kbPage.id}, score: ${score})`);
                break;
              } else {
                console.log(`⏭️  Skipping "${kbPage.title}" (ID: ${kbPage.id}) — no Elementor data, trying next match`);
              }
            }
          }

          // Fall back to REST search if KB match failed
          if (!elemPage) {
            const slugMatch = taskText.match(/\b(contact|about|services|classes|home|faq|gallery|team|booking|schedule|programs|buy)\b/);
            if (slugMatch) {
              const bySlug = await getPageBySlug(slugMatch[0]);
              elemPage = bySlug && elemPageIds.has(bySlug.id) ? bySlug : null;
            }
          }
          if (!elemPage) {
            const results = await findPageByTitle(title.replace(/phase \d+\s*test \d+\s*:?\s*/i, '').trim());
            elemPage = bestMatch(results) || null;
          }
        }

        if (!elemPage) {
          await addComment(issueKey,
            `🤔 I couldn't find a matching Elementor page for this task.\n\n` +
            `Please add one of these to the task description and comment \`run\`:\n` +
            `• \`page ID: 193\`\n` +
            `• The Elementor editor URL: \`https://…/post.php?post=193&action=elementor\`\n\n` +
            `*All Elementor pages:*\n` +
            (siteKb?.elementor_pages || [])
              .filter(p => !/^elementor\s+page\s+#\d+$/i.test(p.title.trim()))
              .slice(0, 10)
              .map(p => `• *${p.title}* (ID: ${p.id})`)
              .join('\n')
          );
          await transitionIssue(issueKey, 'In Review');
          break;
        }

        // 2. Ensure the custom Elementor endpoint is deployed in functions.php
        // v2 marker — forces redeploy if only v1 was present
        const ELEMENTOR_ENDPOINT_MARKER = '// brinda-agent: Elementor endpoint v2';
        const elementorEndpointPhp = `

${ELEMENTOR_ENDPOINT_MARKER}
add_action('rest_api_init', function() {
    register_rest_route('brinda-agent/v1', '/elementor-data', [
        'methods'             => ['GET', 'POST'],
        'permission_callback' => function() { return current_user_can('edit_posts'); },
        'callback'            => function(WP_REST_Request $req) {
            $post_id = intval($req->get_param('post_id'));
            if (!$post_id) return new WP_Error('invalid', 'post_id required', ['status' => 400]);
            if ($req->get_method() === 'GET') {
                return [
                    'post_id'        => $post_id,
                    'elementor_data' => get_post_meta($post_id, '_elementor_data', true),
                    'edit_mode'      => get_post_meta($post_id, '_elementor_edit_mode', true),
                ];
            }
            // POST: write new elementor data
            $data = $req->get_param('elementor_data');
            if ($data !== null) {
                update_post_meta($post_id, '_elementor_data', wp_slash($data));
                // Clear ALL Elementor caches so front-end picks up the new data
                delete_post_meta($post_id, '_elementor_css');
                delete_post_meta($post_id, '_elementor_element_cache');
                delete_post_meta($post_id, '_elementor_page_assets');
                // Clear WP object cache
                wp_cache_flush();
                // Trigger Elementor CSS regeneration if plugin is active
                if (class_exists('\\Elementor\\Plugin')) {
                    \\Elementor\\Plugin::$instance->files_manager->clear_cache();
                }
            }
            return ['success' => true, 'post_id' => $post_id, 'cache_cleared' => true];
        },
    ]);
});
`;

        // Deploy endpoint if not already in functions.php
        const { cloneDir: elCloneDir } = await cloneRepo();
        try {
          const currentFunctions = readFile(elCloneDir, 'functions.php') || '';
          if (!currentFunctions.includes(ELEMENTOR_ENDPOINT_MARKER)) {
            editFile(elCloneDir, 'functions.php', currentFunctions.trimEnd() + '\n' + elementorEndpointPhp);
            const { sha, noChanges } = await commitAndDeploy(elCloneDir, '[AI Agent] Add brinda-agent Elementor REST endpoint');
            if (!noChanges) {
              await addComment(issueKey, `⚙️ Deploying Elementor endpoint — waiting for pipeline...`);
              await pollPipelineUntilDone(sha);
              await purgeCache();
              await new Promise(r => setTimeout(r, 5000));
            }
          }
        } finally {
          cleanup(elCloneDir);
        }

        // 3. SSH INSPECT FIRST — understand what's on the page before touching anything
        //    This is how the agent self-diagnoses: reads raw data, maps every widget,
        //    identifies data sources (Elementor JSON vs CPT vs shortcode), then chooses
        //    the correct approach. No more guessing.
        const { inspectPage, formatPageMapForGpt } = require('./pageInspector');
        const pageMap = await inspectPage(elemPage.id);
        const pageMapContext = formatPageMapForGpt(pageMap);
        console.log(`🔬 Page map:\n${pageMapContext}`);

        // Combined context: site KB + live SSH page map (used in ALL Elementor GPT calls)
        const fullContext = `${kbContext}\n\n${pageMapContext}\n\n${memoryContext}`;

        // 4. Read current Elementor data via REST (for widget indexing + revert backup)
        let elementorData = null;
        try {
          const getRes = await axios.get(`${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`, {
            headers: agentHdrs, params: { post_id: elemPage.id }
          });
          elementorData = getRes.data?.elementor_data;
          console.log(`✅ Read Elementor data for page ${elemPage.id} (${typeof elementorData === 'string' ? elementorData.length : 0} chars)`);
        } catch (e) {
          throw new Error(`Could not read Elementor data: ${e.response?.data?.message || e.message}`);
        }

        if (!elementorData || elementorData === '') {
          // Try to find any other Elementor page in the KB that matches the task
          const taskWords2 = (title + ' ' + description).toLowerCase().split(/\W+/).filter(w => w.length > 2);
          const fallbackPage = (siteKb?.elementor_pages || [])
            .filter(p => p.id !== elemPage.id && !/^elementor\s+page\s+#\d+$/i.test(p.title.trim()))
            .map(p => ({ page: p, score: taskWords2.filter(w => p.title.toLowerCase().includes(w)).length }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)[0];

          await addComment(issueKey,
            `⚠️ Page "${elemPage.title?.rendered}" (ID: ${elemPage.id}) has no Elementor data.\n\n` +
            `${fallbackPage
              ? `Closest alternative: *"${fallbackPage.page.title}"* (ID: ${fallbackPage.page.id})\nComment \`run\` to retry, or add "page ID: ${fallbackPage.page.id}" to the task description.`
              : `No matching Elementor page found. Please add "page ID: X" to the task description.`}`
          );
          await transitionIssue(issueKey, 'In Review');
          break;
        }

        // 5. Save original data for revert
        await setRevertMeta(issueKey, {
          type: 'elementor',
          pageId: elemPage.id,
          savedElementorData: elementorData,
          timestamp: new Date().toISOString()
        });

        // 6. Parse Elementor data — CPT-backed shortcode detection now uses pageMap
        const parsed = JSON.parse(typeof elementorData === 'string' ? elementorData : JSON.stringify(elementorData));

        // ── Detect CPT-backed shortcodes via pageMap (inspector already did the SSH work)
        const CPT_SHORTCODE_TYPES = ['trx_sc_services', 'trx_sc_courses', 'trx_sc_team', 'trx_sc_portfolio'];
        const cptWidgets = pageMap.widgets.filter(w => w.dataSource === 'cpt');

        // Legacy findCptWidgets kept for fallback (in case inspector couldn't SSH)
        function findCptWidgets(els) {
          for (const el of (els || [])) {
            if (el.elType === 'widget' && CPT_SHORTCODE_TYPES.includes(el.widgetType)) {
              if (!cptWidgets.find(c => c.widgetType === el.widgetType))
                cptWidgets.push({ widgetType: el.widgetType, settings: el.settings || {} });
            }
            findCptWidgets(el.elements);
          }
        }
        findCptWidgets(parsed);

        // Check if this is an add_card task that targets a CPT-backed section
        // CPT_MAP defines which widget types support add-card (trx_sc_price is NOT add-card)
        const CPT_MAP = {
          trx_sc_services:  'cpt_services',
          trx_sc_courses:   'cpt_courses',
          trx_sc_team:      'cpt_team',
          trx_sc_portfolio: 'cpt_portfolio',
        };
        const isAddCardTask = /\b(add|new card|fourth|insert|create another|duplicate)\b/i.test(title + ' ' + description);
        // Only enter PATH C if: task says add-card AND the CPT widget is in CPT_MAP AND has a category
        const addCardWidget = cptWidgets.find(w => CPT_MAP[w.widgetType] && (w.settings?.cat || w.settings?.category));
        if (isAddCardTask && addCardWidget) {
          // ── PATH C: CPT-based add_card ────────────────────────────────────────
          // The trx_sc_services widget pulls posts from a WP category — create a new post there
          const targetWidget = addCardWidget;
          const catId = targetWidget.settings.cat || targetWidget.settings.category || '';
          const cptType = CPT_MAP[targetWidget.widgetType];

          console.log(`📋 CPT-backed section detected: widget=${targetWidget.widgetType}, cpt=${cptType}, cat=${catId}`);

          // Ask GPT for new card content
          const cptCardRes = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: withKb(`You are writing content for a new service/program card on a yoga studio website.
Return JSON: {
  "title": "card heading",
  "excerpt": "short description shown on the card (1-2 sentences, plain text)",
  "content": "full HTML body for the detail page",
  "image_search_query": "keywords to find a relevant photo"
}`, fullContext) },
              { role: 'user', content: `Task: ${title}\n\nDetails: ${description}` }
            ],
            response_format: { type: 'json_object' }
          });
          const cardContent = JSON.parse(cptCardRes.choices[0].message.content);
          console.log(`🤖 GPT CPT card: "${cardContent.title}"`);

          // Upload image first
          let featuredImageId = null;
          if (cardContent.image_search_query) {
            try {
              console.log(`🔍 Searching image: "${cardContent.image_search_query}"`);
              const imgResult  = await searchImage(cardContent.image_search_query);
              const fname      = cardContent.image_search_query.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.jpg';
              const attachment = await uploadImageToWP(imgResult.url, fname);
              featuredImageId  = attachment.id;
              console.log(`✅ Featured image uploaded: ID ${featuredImageId}`);
            } catch (imgErr) {
              console.warn(`⚠️ Image upload failed (non-fatal): ${imgErr.message}`);
            }
          }

          // Create the CPT post via brinda-agent plugin endpoint
          // This handles wp_insert_post + taxonomy assignment + featured image server-side
          let newPost = null;
          try {
            const postRes = await axios.post(
              `${WP_BASE}/wp-json/brinda-agent/v1/create-cpt-post`,
              {
                post_type:         cptType,
                title:             cardContent.title,
                excerpt:           cardContent.excerpt || '',
                content:           cardContent.content || '',
                cat_id:            catId ? parseInt(catId) : 0,
                featured_media_id: featuredImageId || 0,
              },
              { headers: agentHdrs }
            );
            newPost = postRes.data;
            console.log(`✅ CPT post created via plugin: ID ${newPost.id} "${newPost.title}"`);
          } catch (postErr) {
            throw new Error(`Failed to create ${cptType} post: ${postErr.response?.data?.message || postErr.message}`);
          }

          console.log(`✅ New ${cptType} post created: ID ${newPost?.id} "${cardContent.title}"`);

          // ── Increment the widget's `count` in Elementor JSON so the new card shows ──
          // Find the matching trx_sc_* widget node in the parsed JSON and bump count by 1
          let updatedCountJson = null;
          let countBumped = false;
          const targetWidgetType = targetWidget.widgetType;

          const bumpCount = (elements) => {
            for (const el of (elements || [])) {
              if (el.elType === 'widget' && el.widgetType === targetWidgetType) {
                const s = el.settings || {};
                // Dump ALL numeric/string settings so we can see what field holds the count
                const settingsSnapshot = Object.entries(s)
                  .filter(([,v]) => typeof v === 'string' || typeof v === 'number')
                  .filter(([,v]) => !isNaN(parseInt(v)) || String(v).length < 30)
                  .slice(0, 20)
                  .map(([k,v]) => `${k}="${v}"`)
                  .join(', ');
                console.log(`🔍 ${el.widgetType} settings: ${settingsSnapshot}`);

                // Try all possible count field names ThemeREX uses
                // NOTE: trx_sc_services stores count as "size" (data-setting="size" in Elementor editor)
                const countFields = ['size', 'count', 'posts_count', 'number', 'posts_per_page', 'num'];
                for (const field of countFields) {
                  const raw = s[field];
                  if (raw === undefined || raw === null || raw === '') continue;
                  const currentCount = parseInt(raw);
                  if (!isNaN(currentCount) && currentCount > 0) {
                    const newCount = currentCount + 1;
                    s[field] = typeof raw === 'number' ? newCount : String(newCount);
                    countBumped = true;
                    console.log(`📈 Bumped ${el.widgetType}.${field}: ${currentCount} → ${newCount}`);
                    break; // only bump the first matching field
                  }
                }
                if (!countBumped) {
                  // ThemeREX uses 3 as PHP default without writing the field to JSON.
                  // DB confirms the field is called "count" (from elementor_controls_usage).
                  // Explicitly add count = existingPosts + 1 so the new card shows.
                  const newTotal = (targetWidget.existingPosts || []).length + 1;
                  s.count = String(newTotal);
                  countBumped = true;
                  console.log(`📈 Set ${el.widgetType}.count explicitly to ${newTotal} (confirmed field name from DB elementor_controls_usage)`);
                }
              }
              bumpCount(el.elements);
            }
          };
          bumpCount(parsed);
          console.log(`📊 Count bump result: ${countBumped ? 'updated ✅' : 'no count field found ❌'}`);
          updatedCountJson = JSON.stringify(parsed);

          // Write updated count back to Elementor JSON (trx_sc_services uses "size" field)
          try {
            await axios.post(`${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`, {
              post_id:        elemPage.id,
              elementor_data: updatedCountJson,
            }, { headers: agentHdrs });
            if (countBumped) {
              console.log(`✅ Elementor "size" count bumped and saved on page ${elemPage.id}`);
            } else {
              console.log(`ℹ️  No count field found — widget may show all posts automatically`);
            }
          } catch (writeErr) {
            console.warn(`⚠️ Could not update count in Elementor JSON: ${writeErr.message}`);
          }

          // Save revert meta — stores BOTH the new post ID AND original Elementor JSON
          // Revert will: delete the CPT post AND restore the original count in JSON
          await setRevertMeta(issueKey, {
            type:               'elementor',
            pageId:             elemPage.id,
            savedElementorData: elementorData, // original JSON (restores count on revert)
            cptPostId:          newPost?.id,   // new post to delete on revert
            timestamp:          new Date().toISOString(),
          });

          // Flush caches
          await axios.post(`${WP_BASE}/wp-json/brinda-agent/v1/flush-cache`,
            { post_id: elemPage.id }, { headers: agentHdrs }).catch(() => {});
          await transitionIssue(issueKey, 'In Review');
          await purgeCache();
          await new Promise(r => setTimeout(r, 4000));

          const pageUrl = elemPage.link || `${WP_BASE}/?page_id=${elemPage.id}`;
          const screenshot = await capturePreview(issueKey, pageUrl);
          const screenshotLine = screenshot ? `\n\n📸 *Preview:*\n!${screenshot}!` : '';

          await addComment(issueKey,
            `✅ New program card created for *"${elemPage.title?.rendered}"*\n\n` +
            `*New post:* "${cardContent.title}" (ID: ${newPost?.id}, type: ${cptType})\n` +
            `*Category:* ${catId} (same as existing cards)\n` +
            `*Image:* ${featuredImageId ? `Uploaded (ID: ${featuredImageId})` : 'Not uploaded'}\n` +
            `*Excerpt:* ${cardContent.excerpt}\n\n` +
            `🔗 [View page|${pageUrl}] | [Edit in Elementor|${WP_BASE}/wp-admin/post.php?post=${elemPage.id}&action=elementor]` +
            screenshotLine + `\n\n` +
            `──────────────────────\n` +
            `💬 Commands:\n` +
            `• \`redo: <feedback>\` — adjust the content\n` +
            `• \`revert\` — delete the new card`
          );
          break;
        }

        // ── Helper: generate a random Elementor-style 7-char hex ID ──────────
        function elemId() {
          return Math.floor(Math.random() * 0xFFFFFFF).toString(16).padStart(7, '0');
        }

        // ── Helper: deep-clone an element and assign brand-new IDs everywhere ─
        function cloneWithNewIds(el) {
          const clone = JSON.parse(JSON.stringify(el));
          function reId(node) {
            node.id = elemId();
            (node.elements || []).forEach(reId);
          }
          reId(clone);
          return clone;
        }

        // ── Helper: build a nodeMap id→{el, parentId} for tree traversal ─────
        const nodeMap = new Map();
        function buildNodeMap(elements, parentId = null) {
          for (const el of (elements || [])) {
            nodeMap.set(el.id, { el, parentId });
            buildNodeMap(el.elements, el.id);
          }
        }
        buildNodeMap(parsed);

        // ── Helper: walk up the tree to find the nearest ancestor of elType ───
        function findAncestor(startId, targetType) {
          let entry = nodeMap.get(startId);
          while (entry) {
            const parent = entry.parentId ? nodeMap.get(entry.parentId) : null;
            if (!parent) return null;
            if (parent.el.elType === targetType) return parent.el;
            entry = parent;
          }
          return null;
        }

        // ── Helper: upload an image to WP Media Library ───────────────────────
        async function uploadImageToWP(imageUrl, filename) {
          const FormData = require('form-data');
          const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
          const form   = new FormData();
          form.append('file', Buffer.from(imgRes.data), { filename, contentType: imgRes.headers['content-type'] || 'image/jpeg' });
          const uploadRes = await axios.post(`${WP_BASE}/wp-json/wp/v2/media`, form, {
            auth: wpAuth, headers: form.getHeaders(), maxContentLength: Infinity
          });
          console.log(`✅ Uploaded image: ${uploadRes.data.source_url}`);
          return { id: uploadRes.data.id, url: uploadRes.data.source_url };
        }

        // ── Helper: search Pexels for an image (uses PEXELS_API_KEY env var) ──
        async function searchImage(query) {
          const pexelsKey = process.env.PEXELS_API_KEY;
          if (pexelsKey) {
            const r = await axios.get('https://api.pexels.com/v1/search', {
              headers: { Authorization: pexelsKey },
              params: { query, per_page: 3, orientation: 'landscape' }
            });
            const photo = r.data?.photos?.[0];
            if (photo) return { url: photo.src.large, credit: `Photo by ${photo.photographer} on Pexels` };
          }
          // Fallback: Unsplash direct (no API key needed for single image)
          const unsplashSlug = query.replace(/\s+/g, ',');
          return { url: `https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&q=80`, credit: 'Photo via Unsplash' };
        }

        // ── Build indexed widget list (with elId for tree traversal) ─────────
        // Handles both standard Elementor widgets AND ThemeREX trx_sc_* widgets
        // that store multiple cards as an `items` array inside one widget.
        const widgetRefs = [];
        const TOP_FIELDS  = ['title', 'editor', 'text', 'description', 'caption', 'subtitle', 'content'];
        const ITEM_FIELDS = ['title', 'description', 'text', 'subtitle', 'content', 'name'];

        function indexWidgets(elements) {
          for (const el of (elements || [])) {
            if (el.elType === 'widget') {
              const s = el.settings || {};

              // A) ThemeREX / custom widgets that store cards as items[]
              //    e.g. trx_sc_services, trx_sc_columns, trx_sc_courses
              if (Array.isArray(s.items) && s.items.length > 0) {
                s.items.forEach((item, itemIdx) => {
                  for (const field of ITEM_FIELDS) {
                    if (item[field]) {
                      widgetRefs.push({
                        index:      widgetRefs.length,
                        widgetType: `${el.widgetType}[item ${itemIdx}]`,
                        field,
                        preview:    String(item[field]).replace(/<[^>]+>/g, '').substring(0, 120),
                        node:       item,   // mutate item directly
                        elId:       el.id,
                        isItem:     true,
                        itemsArray: s.items,  // reference to parent items array (for add_card)
                        itemIndex:  itemIdx,
                        parentSettings: s
                      });
                      break;
                    }
                  }
                  // Also expose image field of each item so GPT can reference it
                  if (item.image || item.bg_image) {
                    const imgField = item.image ? 'image' : 'bg_image';
                    widgetRefs.push({
                      index:      widgetRefs.length,
                      widgetType: `${el.widgetType}[item ${itemIdx} image]`,
                      field:      imgField,
                      preview:    `[image: ${String(item[imgField]).substring(0, 60)}]`,
                      node:       item,
                      elId:       el.id,
                      isItem:     true,
                      isImage:    true,
                      itemsArray: s.items,
                      itemIndex:  itemIdx,
                      parentSettings: s
                    });
                  }
                });
                // Also index the widget-level title/description if present
                for (const field of TOP_FIELDS) {
                  if (s[field]) {
                    widgetRefs.push({
                      index: widgetRefs.length, widgetType: el.widgetType, field,
                      preview: String(s[field]).replace(/<[^>]+>/g,'').substring(0,120),
                      node: s, elId: el.id
                    });
                    break;
                  }
                }
                // B) Standard Elementor widgets (heading, text-editor, button, image, etc.)
              } else {
                // Special: image-gallery widget — expose wp_gallery array
                if (el.widgetType === 'image-gallery' || el.widgetType === 'gallery') {
                  const gallery = s.wp_gallery || s.gallery || [];
                  widgetRefs.push({
                    index:      widgetRefs.length,
                    widgetType: el.widgetType,
                    field:      'wp_gallery',
                    preview:    `[Gallery: ${gallery.length} image${gallery.length !== 1 ? 's' : ''}]`,
                    node:       s,
                    elId:       el.id,
                    isGallery:  true,
                    galleryCount: gallery.length,
                  });
                } else {
                  for (const field of TOP_FIELDS) {
                    if (s[field]) {
                      widgetRefs.push({
                        index:      widgetRefs.length,
                        widgetType: el.widgetType,
                        field,
                        preview:    String(s[field]).replace(/<[^>]+>/g, '').substring(0, 120),
                        node:       s,
                        elId:       el.id
                      });
                      break;
                    }
                  }
                }
              }
            }
            if (el.elements?.length) indexWidgets(el.elements);
          }
        }
        indexWidgets(parsed);
        console.log(`📋 Found ${widgetRefs.length} text/item widgets in Elementor data`);

        // All widgets — used for edit path
        const widgetSummary = widgetRefs.map(w => ({
          index:      w.index,
          widgetType: w.widgetType,
          field:      w.field,
          preview:    w.preview,
          isItem:     w.isItem || false,
        }));

        // Card-items only — used for add_card path so GPT can't pick a section heading
        const cardItemSummary = widgetRefs
          .filter(w => w.isItem && !w.isImage)
          .map(w => ({ index: w.index, widgetType: w.widgetType, field: w.field, preview: w.preview }));

        // 6a. CALL 1 — detect action (edit vs add_card vs add_gallery_images) — uses REAL page map
        const galleryWidgets = widgetRefs.filter(w => w.isGallery);
        const actionResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are an Elementor task classifier. You have been given the REAL page structure (inspected via SSH).
Use the page map to understand what data sources exist before deciding the action.
Return JSON: { "action": "edit" | "add_card" | "add_gallery_images", "reason": "one sentence" }
Choose "add_gallery_images" when the task mentions adding photos/images to a gallery and the page has a gallery widget.
Choose "add_card" when task says: add, new card, fourth, insert, create another, duplicate a card.
Choose "edit" for everything else.

Gallery widgets on this page: ${galleryWidgets.length} (${galleryWidgets.map(w => `[${w.index}] ${w.preview}`).join(', ') || 'none'})\n\n${pageMapContext}`
            },
            { role: 'user', content: `Task: ${title}\n\nDetails: ${description}` }
          ],
          response_format: { type: 'json_object' }
        });
        const actionDecision = JSON.parse(actionResponse.choices[0].message.content);
        console.log(`🤖 GPT action decision: ${actionDecision.action} — ${actionDecision.reason}`);

        let elemResult;

        if (actionDecision.action === 'add_card') {
          // 6b. CALL 2 (add_card) — show ONLY card items so GPT picks from the right group
          if (cardItemSummary.length === 0) {
            // No items[] found — fall back to full widget list with column-based approach
            const r = await getOpenAI().chat.completions.create({
              model: 'gpt-4o',
              messages: [
                { role: 'system', content: withKb(`You are adding a new card to an Elementor page.
Pick a widget index from an EXISTING card to clone (heading widget inside a card column).
Return JSON: { "clone_from_widget_index": <number>, "new_heading": "...", "new_description": "...", "new_button_text": "...", "image_search_query": "...", "what_changed": "..." }`, fullContext) },
                { role: 'user', content: `Task: ${title}\n\nDetails: ${description}\n\nPage: "${elemPage.title?.rendered}"\n\nWidgets:\n${JSON.stringify(widgetSummary, null, 2).substring(0, 6000)}` }
              ],
              response_format: { type: 'json_object' }
            });
            elemResult = { action: 'add_card', ...JSON.parse(r.choices[0].message.content) };
          } else {
            // Items[] found — show ONLY those widgets, eliminating wrong-index risk
            const r = await getOpenAI().chat.completions.create({
              model: 'gpt-4o',
              messages: [
                { role: 'system', content: withKb(`You are adding a new card to an Elementor page.
The list below shows ONLY the existing card items (sub-cards inside a widget group).
Pick which one to clone — choose the one from the same group as where the new card belongs.
Return JSON: { "clone_from_widget_index": <index from the list below>, "new_heading": "...", "new_description": "...", "new_button_text": "...", "image_search_query": "...", "what_changed": "..." }`, fullContext) },
                { role: 'user', content: `Task: ${title}\n\nDetails: ${description}\n\nPage: "${elemPage.title?.rendered}"\n\nCard items to clone from:\n${JSON.stringify(cardItemSummary, null, 2)}` }
              ],
              response_format: { type: 'json_object' }
            });
            elemResult = { action: 'add_card', ...JSON.parse(r.choices[0].message.content) };
          }
        } else if (actionDecision.action === 'add_gallery_images') {
          // PATH D — gallery; elemResult not needed (handled directly in PATH D below)
          elemResult = { action: 'add_gallery_images' };
        } else {
          // 6b. CALL 2 (edit) — check if a previous section clarification was given
          // If user replied "section: 3" it was stored in feedbackContext as "section:3"
          const sectionReply = feedbackContext?.match(/^section:(\d+)$/i);
          const forcedWidgetIndex = sectionReply ? parseInt(sectionReply[1]) : null;

          // ── Image-based section targeting ─────────────────────────────────────
          // If the ticket has image attachments, use GPT-4o Vision to identify
          // which widget the screenshot corresponds to — no guessing needed.
          let imageTargetIndex = null;
          if (!forcedWidgetIndex) {
            const attachedImages = await getIssueImages(issueKey).catch(() => []);
            if (attachedImages.length > 0) {
              console.log(`🖼️  Found ${attachedImages.length} image(s) in ticket — using Vision to identify target section`);
              const img = attachedImages[0]; // use first image
              try {
                const visionRes = await getOpenAI().chat.completions.create({
                  model: 'gpt-4o',
                  messages: [
                    {
                      role: 'system',
                      content:
                        `You are identifying which Elementor widget matches a screenshot.\n` +
                        `The user attached a screenshot of the section they want to edit.\n` +
                        `Compare the image content against the widget text previews below and return the index of the best match.\n` +
                        `Return JSON: { "widget_index": <number>, "confidence": "high|medium|low", "reason": "one sentence" }\n\n` +
                        `Widgets:\n${widgetSummary.slice(0, 30).map(w =>
                          `[${w.index}] ${w.widgetType} — "${w.preview}"`
                        ).join('\n')}`
                    },
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: `Task: ${title}\n\nWhich widget does this screenshot show?` },
                        { type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'low' } }
                      ]
                    }
                  ],
                  response_format: { type: 'json_object' },
                  max_tokens: 200,
                });
                const visionResult = JSON.parse(visionRes.choices[0].message.content);
                console.log(`🖼️  Vision result: index=${visionResult.widget_index}, confidence=${visionResult.confidence}, reason=${visionResult.reason}`);
                if (visionResult.confidence !== 'low' && visionResult.widget_index != null) {
                  imageTargetIndex = visionResult.widget_index;
                  console.log(`✅ Image matched widget [${imageTargetIndex}]: "${widgetSummary[imageTargetIndex]?.preview?.substring(0, 60)}"`);
                } else {
                  console.log(`⚠️  Vision confidence too low — falling back to text matching`);
                }
              } catch (visionErr) {
                console.warn(`⚠️  Vision analysis failed: ${visionErr.message}`);
              }
            }
          }

          const resolvedWidgetIndex = forcedWidgetIndex ?? imageTargetIndex;

          if (resolvedWidgetIndex !== null) {
            // Widget identified via image or user reply — skip GPT pick, go straight to content
            const source = imageTargetIndex !== null && forcedWidgetIndex === null ? 'image' : 'user reply';
            console.log(`🎯 Widget [${resolvedWidgetIndex}] identified via ${source}`);
            elemResult = { action: 'edit', widget_index: resolvedWidgetIndex, new_text: null, what_changed: `Section identified via ${source}` };
          } else {
            // Score editable widgets against task keywords to detect ambiguity
            const taskWords = (title + ' ' + description).toLowerCase().split(/\W+/).filter(w => w.length > 3);
            const editableWidgets = widgetSummary.filter(w =>
              ['text-editor', 'heading', 'trx_sc_title', 'text'].some(t => w.widgetType.includes(t))
              && w.preview?.length > 10
            );

            const scoredWidgets = editableWidgets.map(w => ({
              ...w,
              score: taskWords.filter(word => w.preview.toLowerCase().includes(word)).length
            })).sort((a, b) => b.score - a.score);

            const topScore    = scoredWidgets[0]?.score || 0;
            const secondScore = scoredWidgets[1]?.score || 0;
            const isAmbiguous = editableWidgets.length > 2 && topScore < 2 && (topScore - secondScore) <= 0;

            if (isAmbiguous && editableWidgets.length > 1) {
              // Multiple paragraphs look equally relevant — ask user to pick
              const options = editableWidgets.slice(0, 5).map((w, i) =>
                `*${w.index}.* [${w.widgetType}] "${w.preview.substring(0, 80)}${w.preview.length > 80 ? '…' : ''}"`
              ).join('\n');

              await addComment(issueKey,
                `🤔 I found ${editableWidgets.length} text sections on this page. Which one should I update?\n\n` +
                `${options}\n\n` +
                `Reply with: \`section: <number>\` — e.g. \`section: ${editableWidgets[0]?.index}\`\n\n` +
                `💡 *Tip:* Attach a screenshot of the section and I'll identify it automatically next time.`
              );
              recordOutcome(issueKey, title, 'elementor', 'clarification_needed', {
                pageId: elemPage.id, note: `Section ambiguous — ${editableWidgets.length} candidates`
              });
              await transitionIssue(issueKey, 'In Review');
              break;
            }

            // Confident enough — let GPT pick
            const r = await getOpenAI().chat.completions.create({
              model: 'gpt-4o',
              messages: [
                { role: 'system', content: withKb(`You are an Elementor widget editor.
Return JSON: { "widget_index": <number from the list>, "new_text": "replacement text", "what_changed": "brief description" }`, fullContext) },
                { role: 'user', content: `Task: ${title}\n\nDetails: ${description}\n\nPage: "${elemPage.title?.rendered}"\n\nWidgets:\n${JSON.stringify(widgetSummary, null, 2).substring(0, 8000)}` }
              ],
              response_format: { type: 'json_object' }
            });
            elemResult = { action: 'edit', ...JSON.parse(r.choices[0].message.content) };
          }

          // If GPT chose a widget but no new_text yet (forced index case) — ask GPT for content only
          if (elemResult.widget_index != null && !elemResult.new_text) {
            const tw = widgetRefs[elemResult.widget_index];
            if (tw) {
              const r2 = await getOpenAI().chat.completions.create({
                model: 'gpt-4o',
                messages: [
                  { role: 'system', content: withKb(`You are a WordPress content writer for Brinda Yoga.
Write replacement text for the specified widget. Return JSON: { "new_text": "...", "what_changed": "..." }`, fullContext) },
                  { role: 'user', content: `Task: ${title}\n\nDetails: ${description}\n\nCurrent text: "${tw.preview}"` }
                ],
                response_format: { type: 'json_object' }
              });
              const r2data = JSON.parse(r2.choices[0].message.content);
              elemResult.new_text    = r2data.new_text;
              elemResult.what_changed = r2data.what_changed;
            }
          }
        }

        console.log(`🤖 GPT Elementor result:`, JSON.stringify(elemResult));

        // ════════════════════════════════════════════════════════════════
        // PATH A — EDIT: update a single widget field in-place
        // ════════════════════════════════════════════════════════════════
        let updatedJson;
        let successComment;

        if (elemResult.action === 'edit') {
          if (elemResult.widget_index == null) {
            await addComment(issueKey,
              `⚠️ Could not identify which widget to change.\n\n` +
              `Widgets:\n${widgetSummary.slice(0, 8).map(w => `• [${w.index}] [${w.widgetType}] "${w.preview}"`).join('\n')}\n\n` +
              `[Edit in Elementor|${WP_BASE}/wp-admin/post.php?post=${elemPage.id}&action=elementor]`
            );
            await transitionIssue(issueKey, 'In Review');
            break;
          }
          const tw = widgetRefs[elemResult.widget_index];
          if (!tw) {
            await addComment(issueKey, `⚠️ Widget index ${elemResult.widget_index} not found. Please edit manually.`);
            await transitionIssue(issueKey, 'In Review');
            break;
          }
          const oldValue = tw.node[tw.field];
          tw.node[tw.field] = elemResult.new_text;
          updatedJson    = JSON.stringify(parsed);
          successComment =
            `✅ Elementor widget updated on *"${elemPage.title?.rendered}"*\n\n` +
            `*Changed:* ${elemResult.what_changed}\n` +
            `*Widget:* [${elemResult.widget_index}] ${tw.widgetType}.${tw.field}\n` +
            `*Old:* ${String(oldValue).replace(/<[^>]+>/g,'').substring(0, 80)}\n` +
            `*New:* ${String(elemResult.new_text).substring(0, 80)}`;

          // 🧠 Record learnings from this edit
          rememberPage(title, elemPage.id, elemPage.title?.rendered, elemPage.slug, issueKey);
          recordOutcome(issueKey, title, 'elementor', 'success', {
            pageId: elemPage.id, widgetType: tw.widgetType,
            widgetIndex: elemResult.widget_index,
            note: `Edited ${tw.widgetType}.${tw.field} on "${elemPage.title?.rendered}"`
          });

        // ════════════════════════════════════════════════════════════════
        // PATH B — ADD CARD
        // B1: ThemeREX items[] — all cards in one widget's settings.items
        // B2: Column-based — each card is its own Elementor column
        // ════════════════════════════════════════════════════════════════
        } else if (elemResult.action === 'add_card') {
          const refWidget = widgetRefs[elemResult.clone_from_widget_index];
          if (!refWidget) {
            await addComment(issueKey, `⚠️ Reference widget index ${elemResult.clone_from_widget_index} not found.`);
            await transitionIssue(issueKey, 'In Review');
            break;
          }

          // Upload image first (shared between both paths)
          let imageAttachment = null;
          if (elemResult.image_search_query) {
            try {
              console.log(`🔍 Searching image: "${elemResult.image_search_query}"`);
              const imgResult   = await searchImage(elemResult.image_search_query);
              const safeFilename = elemResult.image_search_query.replace(/[^a-z0-9]/gi,'-').toLowerCase() + '.jpg';
              imageAttachment   = await uploadImageToWP(imgResult.url, safeFilename);
              imageAttachment.credit = imgResult.credit;
              console.log(`✅ Image uploaded: ID ${imageAttachment.id}`);
            } catch (imgErr) {
              console.warn(`⚠️ Image upload failed (non-fatal): ${imgErr.message}`);
            }
          }

          // ── B1: ThemeREX items[] pattern ──────────────────────────────
          if (refWidget.isItem && refWidget.itemsArray) {
            const itemsArray = refWidget.itemsArray;
            const clonedItem = JSON.parse(JSON.stringify(itemsArray[refWidget.itemIndex]));
            if (elemResult.new_heading)     { clonedItem.title       = elemResult.new_heading; }
            if (elemResult.new_description) { clonedItem.description = elemResult.new_description;
                                              clonedItem.text        = elemResult.new_description; }
            if (elemResult.new_button_text) { clonedItem.link_text   = elemResult.new_button_text; }
            if (imageAttachment) {
              if ('image'    in clonedItem) clonedItem.image    = imageAttachment.url;
              if ('bg_image' in clonedItem) clonedItem.bg_image = imageAttachment.url;
            }
            itemsArray.push(clonedItem);
            console.log(`✅ TRX items[] card added — array now has ${itemsArray.length} items`);

          // ── B2: Column-based layout ───────────────────────────────────
          } else {
            const parentColumn = findAncestor(refWidget.elId, 'column')
                              || findAncestor(refWidget.elId, 'container');
            if (!parentColumn) {
              await addComment(issueKey, `⚠️ Could not find parent column. Please add the card manually.`);
              await transitionIssue(issueKey, 'In Review');
              break;
            }
            const parentSection = findAncestor(parentColumn.id, 'section')
                               || findAncestor(parentColumn.id, 'container');
            if (!parentSection) {
              await addComment(issueKey, `⚠️ Could not find parent section. Please add the card manually.`);
              await transitionIssue(issueKey, 'In Review');
              break;
            }
            console.log(`📐 Cloning column ${parentColumn.id} in section ${parentSection.id}`);
            const newColumn = cloneWithNewIds(parentColumn);
            function updateClonedWidgets(elements) {
              for (const el of (elements || [])) {
                if (el.elType === 'widget') {
                  const s = el.settings || {};
                  if (el.widgetType === 'heading'     && elemResult.new_heading)     s.title  = elemResult.new_heading;
                  if (el.widgetType === 'text-editor' && elemResult.new_description) s.editor = elemResult.new_description;
                  if (el.widgetType === 'text'        && elemResult.new_description) s.text   = elemResult.new_description;
                  if (el.widgetType === 'button'      && elemResult.new_button_text) s.text   = elemResult.new_button_text;
                  if (el.widgetType === 'image' && imageAttachment) {
                    s.image = { url: imageAttachment.url, id: imageAttachment.id, alt: elemResult.new_heading || '', source: 'library' };
                  }
                }
                if (el.elements?.length) updateClonedWidgets(el.elements);
              }
            }
            updateClonedWidgets(newColumn.elements || []);
            parentSection.elements = parentSection.elements || [];
            parentSection.elements.push(newColumn);
            console.log(`✅ New column appended — section now has ${parentSection.elements.length} columns`);
          }

          updatedJson    = JSON.stringify(parsed);
          successComment =
            `✅ New program card added to *"${elemPage.title?.rendered}"*\n\n` +
            `*Added:* ${elemResult.what_changed}\n` +
            `*Heading:* ${elemResult.new_heading}\n` +
            `*Image:* ${imageAttachment ? `Uploaded (ID: ${imageAttachment.id}) — ${imageAttachment.credit}` : 'Kept from cloned card (no PEXELS_API_KEY set)'}`;

        // ════════════════════════════════════════════════════════════════
        // PATH D — ADD GALLERY IMAGES
        // Finds the image-gallery widget, searches Pexels for relevant
        // yoga photos, uploads them to WP media library, and appends
        // {id, url} entries to settings.wp_gallery.
        // ════════════════════════════════════════════════════════════════
        } else if (elemResult?.action === 'add_gallery_images' || actionDecision.action === 'add_gallery_images') {
          const galleryRef = galleryWidgets[0]; // use first gallery on the page
          if (!galleryRef) {
            await addComment(issueKey,
              `⚠️ No image-gallery widget found on this page.\n\n` +
              `[Edit in Elementor|${WP_BASE}/wp-admin/post.php?post=${elemPage.id}&action=elementor]`
            );
            await transitionIssue(issueKey, 'In Review');
            break;
          }

          const existingGallery = galleryRef.node.wp_gallery || galleryRef.node.gallery || [];
          console.log(`📸 Gallery widget found — currently ${existingGallery.length} images`);

          // Ask GPT how many images to add and what to search for
          const galleryPlan = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: `You are planning gallery image additions for a yoga studio website.
Return JSON: { "count": <number of images to add, default 3>, "search_query": "yoga <relevant keyword>", "what_changed": "brief description" }
Keep count between 1 and 5.` },
              { role: 'user', content: `Task: ${title}\n\nDetails: ${description}\n\nPage: "${elemPage.title?.rendered}"\nCurrent gallery has ${existingGallery.length} images.` }
            ],
            response_format: { type: 'json_object' }
          });
          const plan = JSON.parse(galleryPlan.choices[0].message.content);
          const searchQuery = plan.search_query || 'yoga meditation';
          const addCount    = Math.min(Math.max(1, plan.count || 3), 5);
          console.log(`🔍 Searching Pexels for "${searchQuery}" — adding ${addCount} images`);

          // Search Pexels and upload images
          const newGalleryEntries = [];
          const pexelsKey = process.env.PEXELS_API_KEY;
          if (!pexelsKey) {
            await addComment(issueKey,
              `⚠️ PEXELS_API_KEY is not set — cannot search for images automatically.\n\n` +
              `Please add photos manually in Elementor:\n` +
              `[Edit in Elementor|${WP_BASE}/wp-admin/post.php?post=${elemPage.id}&action=elementor]\n\n` +
              `Or set PEXELS_API_KEY and comment \`run\` to retry.`
            );
            await transitionIssue(issueKey, 'In Review');
            break;
          }

          try {
            const pexelsRes = await axios.get('https://api.pexels.com/v1/search', {
              headers: { Authorization: pexelsKey },
              params: { query: searchQuery, per_page: addCount + 2, orientation: 'landscape' }
            });
            const photos = pexelsRes.data.photos || [];
            console.log(`📷 Pexels returned ${photos.length} photos for "${searchQuery}"`);

            // Filter out any already in gallery
            const existingUrls = new Set(existingGallery.map(g => g.url));
            const freshPhotos  = photos.filter(p => !existingUrls.has(p.src.large)).slice(0, addCount);

            for (const photo of freshPhotos) {
              const imgUrl      = photo.src.large || photo.src.medium;
              const safeFilename = searchQuery.replace(/[^a-z0-9]/gi, '-').toLowerCase() + `-${photo.id}.jpg`;
              try {
                const uploaded = await uploadImageToWP(imgUrl, safeFilename);
                newGalleryEntries.push({ id: uploaded.id, url: uploaded.url });
                console.log(`✅ Uploaded gallery image: ID ${uploaded.id}`);
              } catch (uploadErr) {
                console.warn(`⚠️ Failed to upload photo ${photo.id}: ${uploadErr.message}`);
              }
            }
          } catch (pexelsErr) {
            console.warn(`⚠️ Pexels search failed: ${pexelsErr.message}`);
          }

          if (newGalleryEntries.length === 0) {
            await addComment(issueKey,
              `⚠️ Could not upload any new gallery images (search: "${searchQuery}").\n\n` +
              `Please add photos manually:\n[Edit in Elementor|${WP_BASE}/wp-admin/post.php?post=${elemPage.id}&action=elementor]`
            );
            await transitionIssue(issueKey, 'In Review');
            break;
          }

          // Append new images to the gallery array
          const updatedGallery = [...existingGallery, ...newGalleryEntries];
          if (galleryRef.node.wp_gallery !== undefined) {
            galleryRef.node.wp_gallery = updatedGallery;
          } else {
            galleryRef.node.gallery = updatedGallery;
          }

          updatedJson    = JSON.stringify(parsed);
          successComment =
            `✅ Gallery updated on *"${elemPage.title?.rendered}"*\n\n` +
            `*Added:* ${newGalleryEntries.length} new yoga photos\n` +
            `*Gallery total:* ${existingGallery.length} → ${updatedGallery.length} images\n` +
            `*Search query:* "${searchQuery}"\n` +
            `*Photos:* ${newGalleryEntries.map(e => `[View|${e.url}]`).join(' | ')}`;

          rememberPage(title, elemPage.id, elemPage.title?.rendered, elemPage.slug, issueKey);
          recordOutcome(issueKey, title, 'elementor', 'success', {
            pageId: elemPage.id, widgetType: 'image-gallery',
            note: `Added ${newGalleryEntries.length} images to gallery on "${elemPage.title?.rendered}"`
          });

        } else {
          await addComment(issueKey, `⚠️ Unknown Elementor action "${elemResult?.action || actionDecision.action}". Please edit manually.`);
          await transitionIssue(issueKey, 'In Review');
          break;
        }

        // Re-serialize the updated structure
        // updatedJson already set in path A, B or D above

        // 7. Write back
        await axios.post(`${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`, {
          post_id:        elemPage.id,
          elementor_data: updatedJson,
        }, { headers: agentHdrs });

        // Verify the write landed — read back and check data length changed
        const verifyRes = await axios.get(`${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`, {
          headers: agentHdrs, params: { post_id: elemPage.id }
        });
        const verifyData = verifyRes.data?.elementor_data || '';
        const verifyStr  = typeof verifyData === 'string' ? verifyData : JSON.stringify(verifyData);
        const verifyOk   = verifyStr.length >= updatedJson.length - 100; // allow small diff
        console.log(`🔍 Write verification: stored=${verifyStr.length} chars, sent=${updatedJson.length} chars, ok=${verifyOk}`);
        if (!verifyOk) console.warn(`⚠️ Write may not have landed — sizes differ significantly`);

        console.log(`✅ Elementor data updated for page ${elemPage.id}: ${elemResult.what_changed}`);

        // Flush all WP caches
        try {
          const { runWpCli } = require('./wpCli');
          await runWpCli('cache flush');
          await runWpCli(`post meta delete ${elemPage.id} _elementor_css`);
          await runWpCli(`post meta delete ${elemPage.id} _elementor_element_cache`);
          console.log('✅ WP + Elementor caches flushed');
        } catch (cacheErr) {
          console.warn(`⚠️ Cache flush warning (non-fatal): ${cacheErr.message}`);
        }

        await transitionIssue(issueKey, 'In Review');
        await purgeCache();
        await new Promise(r => setTimeout(r, 4000));

        const elemPageUrl = elemPage.link || `${WP_BASE}/?page_id=${elemPage.id}`;
        const elemScreenshot = await capturePreview(issueKey, elemPageUrl);
        const elemScreenshotLine = elemScreenshot ? `\n\n📸 *Preview:*\n!${elemScreenshot}!` : '';

        await addComment(issueKey,
          successComment + `\n\n` +
          `🔗 [View page|${elemPageUrl}] | [Edit in Elementor|${WP_BASE}/wp-admin/post.php?post=${elemPage.id}&action=elementor]` +
          elemScreenshotLine + `\n\n` +
          `──────────────────────\n` +
          `💬 Commands:\n` +
          `• \`redo: <feedback>\` — adjust the change\n` +
          `• \`revert\` — restore original Elementor layout`
        );
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
    // Move to In Review (not To Do) so it's visible and doesn't auto-retrigger
    await addComment(issueKey,
      `❌ Agent encountered an error:\n\n${err.message}\n\n` +
      `💬 Comment \`run\` to retry, or \`redo: <description>\` to try differently.`
    );
    await transitionIssue(issueKey, 'In Review').catch(() => {});
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

    if (!meta) {
      await addComment(issueKey,
        `⚠️ Could not find previous edit data to redo.\n` +
        `Please comment \`run\` to start fresh.`
      );
      await transitionIssue(issueKey, 'In Review');
      return;
    }

    // For FILE type redos — update the issue description and re-run agent
    if (meta.type === 'file') {
      const issue = await getIssue(issueKey);
      const originalTitle = issue.fields.summary;
      await addComment(issueKey, `🔄 Applying feedback to theme files: "${feedback}"`);
      // Re-run agent with feedback appended to context
      await runAgent(issueKey, feedback);
      return;
    }

    if (meta.type !== 'content') {
      await addComment(issueKey,
        `⚠️ Redo not supported for task type "${meta.type}".\n` +
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
          content: withKb(`You are a WordPress page editor fixing content based on client feedback.
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
}`, kbContext)
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
