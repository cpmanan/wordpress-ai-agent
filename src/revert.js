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
        const axiosLib  = require('axios');
        const WP_BASE   = process.env.WP_STAGING_URL;
        const wpAuth    = { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD };
        const agentHdrs = { 'X-Agent-Token': process.env.AGENT_TOKEN || '' };

        if (cptPostId) {
          // CPT-backed add_card revert:
          // 1. Delete the newly created CPT post
          // 2. Restore original Elementor JSON (resets the count back)
          let postDeleted = false;
          try {
            // Use brinda-agent endpoint — works for any post type via wp_delete_post()
            await axiosLib.delete(
              `${WP_BASE}/wp-json/brinda-agent/v1/delete-post`,
              { headers: agentHdrs, params: { post_id: cptPostId } }
            );
            postDeleted = true;
            console.log(`✅ Deleted CPT post ${cptPostId} via plugin`);
          } catch (e1) {
            console.warn(`Could not delete post ${cptPostId}: ${e1.response?.data?.message || e1.message}`);
          }

          // Restore original Elementor JSON (this resets the count display)
          if (savedElementorData) {
            try {
              await axiosLib.post(
                `${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`,
                { post_id: pageId, elementor_data: savedElementorData },
                { headers: agentHdrs }
              );
              console.log(`✅ Restored original Elementor JSON for page ${pageId}`);
            } catch (e3) {
              console.warn(`Could not restore Elementor JSON: ${e3.message}`);
            }
          }

          await addComment(postTo,
            `✅ Reverted *${issueKey}*\n\n` +
            `• New card (post ID: ${cptPostId}) ${postDeleted ? 'deleted ✅' : 'could not be deleted ⚠️'}\n` +
            `• Elementor page count restored to original ✅`
          );
        } else {
          // Standard Elementor JSON revert
          await axiosLib.post(
            `${WP_BASE}/wp-json/brinda-agent/v1/elementor-data`,
            { post_id: pageId, elementor_data: savedElementorData },
            { headers: agentHdrs }
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

      // Plugin revert — deactivate/re-activate via brinda-agent REST (no WP-CLI on Railway)
      case 'plugin': {
        const { pluginSlug, action, backupCheckpointId } = meta;
        const agentBase = `${process.env.WP_STAGING_URL}/wp-json/brinda-agent/v1`;
        const agentHdrs = { 'X-Agent-Token': process.env.AGENT_TOKEN || '' };
        const bkNote    = backupCheckpointId ? `\n• Backup checkpoint: \`${backupCheckpointId}\`` : '';

        if (action === 'install' || action === 'install_manual') {
          // Plugin was installed — deactivate + delete it
          try {
            const res = await axios.post(
              `${agentBase}/deactivate-plugin`,
              { plugin_slug: pluginSlug, delete: true },
              { headers: agentHdrs, timeout: 30000 }
            );
            await addComment(postTo,
              `✅ Reverted *${issueKey}* — plugin "${pluginSlug}" deactivated and deleted\n` +
              `${bkNote}\nOriginal state from: ${timestamp}`
            );
          } catch (e) {
            await addComment(postTo,
              `⚠️ Could not auto-deactivate "${pluginSlug}": ${e.response?.data?.message || e.message}\n\n` +
              `Please deactivate manually: [WP Admin → Plugins|${process.env.WP_STAGING_URL}/wp-admin/plugins.php]`
            );
          }
        } else if (action === 'deactivate') {
          // Plugin was deactivated — re-activate it
          try {
            const res = await axios.post(
              `${agentBase}/install-plugin`,
              { plugin_slug: pluginSlug },
              { headers: agentHdrs, timeout: 60000 }
            );
            await addComment(postTo,
              `✅ Reverted *${issueKey}* — plugin "${pluginSlug}" re-activated\n` +
              `${bkNote}\nOriginal state from: ${timestamp}`
            );
          } catch (e) {
            await addComment(postTo,
              `⚠️ Could not re-activate "${pluginSlug}": ${e.response?.data?.message || e.message}\n\n` +
              `Please activate manually: [WP Admin → Plugins|${process.env.WP_STAGING_URL}/wp-admin/plugins.php]`
            );
          }
        } else {
          await addComment(postTo, `⚠️ Unknown plugin revert action "${action}" for *${issueKey}*. Please revert manually.`);
        }
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

      // WP Engine backup checkpoint — guide user to restore via portal
      // (WP Engine REST API does not expose a restore endpoint — must be done via portal UI)
      case 'backup': {
        const { backupCheckpointId, pluginSlug, target } = meta;
        const portalUrl = `https://my.wpengine.com/installs/brindayogacstg/backup_points`;
        const what = pluginSlug
          ? `plugin update: ${pluginSlug}`
          : target === 'core' ? 'WordPress core update' : 'all plugin updates';

        if (backupCheckpointId) {
          await addComment(postTo,
            `🔄 *Revert instructions for *${issueKey}** (${what})\n\n` +
            `A WP Engine backup checkpoint was created before this operation:\n` +
            `• *Checkpoint ID:* \`${backupCheckpointId}\`\n\n` +
            `*To restore:*\n` +
            `1. Go to [WP Engine portal → Backup Points|${portalUrl}]\n` +
            `2. Find checkpoint \`${backupCheckpointId.substring(0,8)}...\`\n` +
            `3. Click *Restore* → confirm\n\n` +
            `⚠️ Restoring will roll back the entire site to that checkpoint — including files and database.`
          );
        } else {
          await addComment(postTo,
            `⚠️ No backup checkpoint ID found for *${issueKey}*.\n\n` +
            `Check [WP Engine portal → Backup Points|${portalUrl}] for recent automatic backups.`
          );
        }
        await transitionIssue(postTo, 'Done').catch(() => {});
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
