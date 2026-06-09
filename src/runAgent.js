const OpenAI = require('openai');
const { detectTaskType, TASK_TYPES } = require('./taskRouter');
const { getIssue, addComment, setRevertMeta, transitionIssue } = require('./jira');
const { cloneRepo, getCurrentSha, readFile, editFile, commitAndDeploy, cleanup } = require('./wpEngineDeploy');
const { createPost, updatePost, getPost, createPage, updatePage, getPage, searchContent } = require('./wpRest');
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

          await transitionIssue(issueKey, 'Review');
          await addComment(issueKey,
            `✅ Theme files updated and deployed to staging.\n\n` +
            `Files changed: ${fileChanges.map(f => f.file).join(', ')}\n` +
            `Staging URL: ${process.env.WP_STAGING_URL}\n\n` +
            `To revert, comment: \`revert\``
          );
        } finally {
          cleanup(cloneDir);
        }
        break;
      }

      // ── CONTENT: Create/update posts or pages ──────────────────────
      case TASK_TYPES.CONTENT: {
        const isPage = title.toLowerCase().includes('page');

        // Search for existing content first so OpenAI knows the page ID
        const searchResults = await searchContent(title);
        const existingItems = searchResults
          .slice(0, 5)
          .map(r => `ID: ${r.id} | Type: ${r.subtype} | Title: ${r.title?.rendered || r.title}`)
          .join('\n');

        // Ask OpenAI to generate/update the content
        const aiResponse = await getOpenAI().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are a WordPress content editor for a yoga studio website called Brinda Yoga.
              You will be given a task and a list of existing pages/posts found by search.
              Return JSON: { "title": "post title", "content": "HTML content", "action": "create" or "update", "id": null or the exact post ID from the search results if updating, "type": "post" or "page" }`
            },
            {
              role: 'user',
              content: `Task: ${title}\nDescription: ${description}\n\nExisting content found:\n${existingItems || 'None found'}`
            }
          ],
          response_format: { type: 'json_object' }
        });

        const result = JSON.parse(aiResponse.choices[0].message.content);
        let savedContent = null;
        let postId = result.id;
        const contentIsPage = result.type === 'page' || isPage;

        if (result.action === 'update' && postId) {
          // Save existing content before update (for revert)
          const existing = contentIsPage ? await getPage(postId) : await getPost(postId);
          savedContent = { title: existing.title.raw, content: existing.content.raw };

          contentIsPage
            ? await updatePage(postId, { title: result.title, content: result.content })
            : await updatePost(postId, { title: result.title, content: result.content });
        } else {
          // Create new
          const created = contentIsPage
            ? await createPage(result.title, result.content, 'draft')
            : await createPost(result.title, result.content, 'draft');
          postId = created.id;
        }

        // Store revert metadata
        await setRevertMeta(issueKey, {
          type: 'content',
          postId,
          postType: isPage ? 'page' : 'post',
          savedContent,
          timestamp: new Date().toISOString()
        });

        await transitionIssue(issueKey, 'Review');
        const previewUrl = contentIsPage
          ? `${process.env.WP_STAGING_URL}/?page_id=${postId}&preview=true`
          : `${process.env.WP_STAGING_URL}/?p=${postId}&preview=true`;

        await addComment(issueKey,
          `✅ ${contentIsPage ? 'Page' : 'Post'} ${result.action === 'update' ? 'updated' : 'created'} as draft.\n\n` +
          `Title: "${result.title}"\n` +
          `Preview: ${previewUrl}\n\n` +
          `To revert, comment: \`revert\``
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
    await transitionIssue(issueKey, 'Inbox').catch(() => {});
  }
}

module.exports = { runAgent };
