const { getRevertMeta, addComment, transitionIssue } = require('./jira');
const { revertToSha } = require('./wpEngineDeploy');
const { updatePost, updatePage } = require('./wpRest');
const { importDb, deactivatePlugin, runWpCli } = require('./wpCli');

// Execute the correct revert strategy based on stored metadata
async function revertTask(issueKey) {
  const meta = await getRevertMeta(issueKey);

  if (!meta) {
    await addComment(issueKey, '⚠️ No revert data found for this issue. Cannot revert automatically.');
    return;
  }

  const { type, timestamp } = meta;

  try {
    switch (type) {
      // Revert a child theme file change (git SHA rollback)
      case 'file': {
        const { oldSha } = meta;
        await revertToSha(oldSha);
        await addComment(issueKey, `✅ Reverted theme files to git SHA ${oldSha.substring(0, 8)} (state from ${timestamp})`);
        break;
      }

      // Revert a post content change (restore saved JSON)
      case 'content': {
        const { postId, postType, savedContent } = meta;
        if (postType === 'page') {
          await updatePage(postId, { title: savedContent.title, content: savedContent.content });
        } else {
          await updatePost(postId, { title: savedContent.title, content: savedContent.content });
        }
        await addComment(issueKey, `✅ Reverted ${postType} #${postId} to previous content (state from ${timestamp})`);
        break;
      }

      // DB revert (WP CLI / Yoast / Elementor) — via SSH
      case 'db': {
        const { backupFile } = meta;
        await importDb(backupFile);
        await addComment(issueKey, `✅ Reverted database from backup (state from ${timestamp})`);
        break;
      }

      // Plugin revert — deactivate and uninstall
      case 'plugin': {
        const { pluginSlug } = meta;
        await deactivatePlugin(pluginSlug);
        await runWpCli(`plugin uninstall ${pluginSlug}`);
        await addComment(issueKey, `✅ Plugin "${pluginSlug}" deactivated and removed (state from ${timestamp})`);
        await transitionIssue(issueKey, 'Done').catch(() => {});
        break;
      }

      // Nav revert — remove menu item (page stays)
      case 'nav': {
        const { pageId, menuName } = meta;
        const { getMenuItems } = require('./wpCli');
        const items = await getMenuItems(menuName);
        const item = items.find(i => i.object_id == pageId);
        if (item) {
          await runWpCli(`menu item delete ${item.db_id}`);
        }
        await addComment(issueKey, `✅ Removed page from navigation menu "${menuName}" (state from ${timestamp})`);
        await transitionIssue(issueKey, 'Done').catch(() => {});
        break;
      }

      // WP Engine full backup restore (plugin/core updates)
      case 'backup': {
        const { backupId } = meta;
        const { restoreBackup } = require('./wpEngineBackup');
        await restoreBackup(backupId);
        await addComment(issueKey, `✅ Restored WP Engine backup ${backupId} (state from ${timestamp})`);
        break;
      }

      default:
        await addComment(issueKey, `⚠️ Unknown revert type "${type}". Please revert manually.`);
    }
  } catch (err) {
    await addComment(issueKey, `❌ Revert failed: ${err.message}`);
    throw err;
  }
}

module.exports = { revertTask };
