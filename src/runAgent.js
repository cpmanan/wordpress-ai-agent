const OpenAI = require('openai');
const { detectTaskType, TASK_TYPES } = require('./taskRouter');
const { getIssue, addComment, setRevertMeta, transitionIssue, getRevertMeta } = require('./jira');
const { cloneRepo, getCurrentSha, readFile, readAgentContext, editFile, commitAndDeploy, purgeCache, cleanup, pollPipelineUntilDone } = require('./wpEngineDeploy');
const { getParentThemeContext } = require('./viharaContext');
const { capturePreview } = require('./screenshotter');
const { createPost, updatePost, getPost, createPage, updatePage, getPage, searchContent, getPageBySlug, findPageByTitle, getMenus, addPageToMenu, addUrlToMenu } = require('./wpRest');
const { revertTask } = require('./revert');
const { getPlugins, installPlugin, deactivatePlugin, updateYoastSeo, exportDb } = require('./wpCli');

// Initialize lazily so missing key doesn't crash the server at startup
let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

async function runAgent(issueKey, feedbackContext = null) {
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
                content: `You are a WordPress child theme developer for Brinda Yoga website.
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
}`
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

          // ── Screenshot: screenshotter.js appends ?nocache=<timestamp> automatically
          const stagingUrl = process.env.WP_STAGING_URL || 'https://brindayogacstg.wpenginepowered.com';
          console.log(`📸 Taking screenshot of staging site...`);
          const screenshotUrl = await capturePreview(issueKey, stagingUrl);

          const screenshotLine = screenshotUrl
            ? `\n\n📸 *Full-page preview screenshot:*\n!${screenshotUrl}!`
            : '\n\n_(Screenshot could not be captured)_';

          await addComment(issueKey,
            `🖼️ Screenshot captured — here is the current staging site:\n` +
            `Preview URL: ${stagingUrl}${screenshotLine}\n\n` +
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

        } else if (isBlogPost) {
          // ── CREATE new blog post ──────────────────────────────────
          contentIsPage = false;
          action = 'create';

          const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are a content writer for Brinda Yoga, a professional yoga studio website.
Write an engaging, informative blog post that reflects the brand voice of a mindful yoga studio.
Use well-structured HTML with headings, paragraphs, and lists where appropriate.
Return JSON: { "title": "blog post title", "content": "full HTML content", "excerpt": "brief summary (1-2 sentences)" }`
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

        const contentLabel = contentIsPage ? 'Page' : 'Blog post';
        await addComment(issueKey,
          `✅ ${contentLabel} ${action === 'update' ? 'updated' : 'created'} as draft.\n\n` +
          `${existingPage ? `Page: "${existingPage.title?.rendered}"` : `New ${contentLabel.toLowerCase()} created`}\n` +
          `Preview: ${previewUrl}\n\n` +
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
  "menuId": numeric menu ID from the list above,
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
              content: `You are an SEO expert for Brinda Yoga, a yoga studio website.
Generate optimized Yoast SEO metadata. Use the task requirements if specific values are provided,
otherwise generate appropriate values based on the page content.
Return JSON: {
  "seoTitle": "SEO title (max 60 chars)",
  "metaDescription": "Meta description (max 155 chars)",
  "focusKeyword": "primary focus keyword"
}`
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
