const { getRevertMeta, addComment, transitionIssue } = require('./jira');
const { revertToSha } = require('./wpEngineDeploy');
const { updatePost, updatePage, getMenuItems } = require('./wpRest');
const { importDb, deactivatePlugin, runWpCli } = require('./wpCli');
const axios = require('axios');

/**
 * Revert a previously applied change.
 * @param {string} issueKey     - issue whose revert metadata to look up (e.g. BRIN-35)
 * @param {string} commentOnKey - issue to post result comments on (defaults to issueKey)
 *                                Pass this when a NEW task (BRIN-40) reverts an OLD one (BRIN-35)
 */
async function revertTask(issueKey, commentOnKey) {
  const postTo = commentOnKey || issueKey;
  const meta   = await getRevertMeta(issueKey);

  if (!meta) {
    await addComment(postTo,
      `⚠️ No revert data found for *${issueKey}*. Cannot revert automatically.\n\n` +
      `This happens if the original task was processed before the revert system was added, ` +
      `or the issue key is incorrect.`
    );
    return;
  }

  const { type, timestamp } = meta;

  try {
    switch (type) {

      // Revert a child theme file change — git SHA rollback + redeploy
      case 'file': {
        const { oldSha } = meta;
        await revertToSha(oldSha);
        await addComment(postTo,
          `✅ Reverted *${issueKey}* — theme files rolled back to git SHA \`${oldSha.substring(0, 8)}\`\n` +
          `Original state from: ${timestamp}`
        );
        break;
      }

      // Revert a post/page content change — restore saved HTML
      case 'content': {
        const { postId, postType, savedContent } = meta;
        if (postType === 'page') {
          await updatePage(postId, { title: savedContent.title, content: savedContent.content });
        } else {
          await updatePost(postId, { title: savedContent.title, content: savedContent.content });
        }
        await addComment(postTo,
          `✅ Reverted *${issueKey}* — ${postType} #${postId} restored to original content\n` +
          `Original state from: ${timestamp}`
        );
        break;
      }

      // Elementor revert — restore _elementor_data OR delete a CPT post
      case 'elementor': {
        const { pageId, savedElementorData, cptPostId } = meta;
        const axiosLib = require('axios');
        const WP_BASE  = process.env.WP_STAGING_URL;
        const wpAuth   = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };

        if (cptPostId) {
          // CPT-backed add_card revert: delete the newly created post
          try {
            await axiosLib.delete(`${WP_BASE}/wp-json/wp/v2/posts/${cptPostId}`, {
              auth: wpAuth, params: { force: true }
            });
          } catch {
            // Try as 'pages' endpoint, or use WP CLI
            try {
              const { runWpCli } = require('./wpCli');
              await runWpCli(`post delete ${cptPostId} --force`);
            } catch (e2) {
              console.warn(`Could not delete CPT post ${cptPostId}: ${e2.message}`);
            }
          }
          await addComment(postTo, `✅ Reverted *${issueKey}* — new program card (ID: ${cptPostId}) deleted`);
        } else {
          // Standard Elementor JSON revert
          await axiosLib.post(
            `${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`,
            { post_id: pageId, elementor_data: savedElementorData },
            { auth: wpAuth }
          );
          await addComment(postTo, `✅ Reverted *${issueKey}* — Elementor layout restored to original state`);
        }
        await transitionIssue(postTo, 'Done').catch(() => {});
        break;
      }

      // SEO revert — restore previous Yoast meta via REST API
      case 'seo': {
        const { pageId, savedSeoMeta } = meta;
        const axiosLib = require('axios');
        const WP_BASE  = process.env.WP_STAGING_URL;
        const wpAuth   = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };
        await axiosLib.post(
          `${WP_BASE}/wp-json/wp/v2/pages/${pageId}`,
          { meta: savedSeoMeta },
          { auth: wpAuth }
        );
        await addComment(postTo, `✅ Reverted *${issueKey}* — SEO metadata restored to previous values`);
        await transitionIssue(postTo, 'Done').catch(() => {});
        break;
      }

      // DB revert (legacy) — restore from WP CLI export
      case 'db': {
        const { backupFile } = meta;
        await importDb(backupFile);
        await addComment(postTo, `✅ Reverted *${issueKey}* — database restored from backup (${timestamp})`);
        break;
      }

      // Plugin revert — deactivate and uninstall
      case 'plugin': {
        const { pluginSlug } = meta;
        await deactivatePlugin(pluginSlug);
        await runWpCli(`plugin uninstall ${pluginSlug}`);
        await addComment(postTo, `✅ Reverted *${issueKey}* — plugin "${pluginSlug}" deactivated and removed`);
        await transitionIssue(postTo, 'Done').catch(() => {});
        break;
      }

      // Nav revert — remove menu item via REST API (no SSH needed)
      case 'nav': {
        const { pageId, menuId } = meta;
        const BASE_URL = process.env.WP_STAGING_URL;
        const auth = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };

        const items = await getMenuItems(menuId);
        const item  = items.find(i => i.object_id == pageId);
        if (item) {
          await axios.delete(`${BASE_URL}/wp-json/wp/v2/menu-items/${item.id}`, {
            auth,
            params: { force: true }
          });
          console.log(`✅ Deleted menu item ${item.id} for page ${pageId}`);
        } else {
          console.warn(`⚠️  Menu item for page ${pageId} not found — may already be removed`);
        }
        await addComment(postTo, `✅ Reverted *${issueKey}* — page removed from navigation menu`);
        await transitionIssue(postTo, 'Done').catch(() => {});
        break;
      }

      // WP Engine full backup restore
      case 'backup': {
        const { backupId } = meta;
        const { restoreBackup } = require('./wpEngineBackup');
        await restoreBackup(backupId);
        await addComment(postTo, `✅ Reverted *${issueKey}* — WP Engine backup ${backupId} restored`);
        break;
      }

      default:
        await addComment(postTo, `⚠️ Unknown revert type "${type}" on *${issueKey}*. Please revert manually.`);
    }
  } catch (err) {
    await addComment(postTo, `❌ Revert of *${issueKey}* failed: ${err.message}`);
    throw err;
  }
}

module.exports = { revertTask };
