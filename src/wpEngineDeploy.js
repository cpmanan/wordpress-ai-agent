const simpleGit = require('simple-git');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { validatePath } = require('./guard');

const REPO_URL = process.env.CHILD_THEME_REPO;
const THEME_NAME = process.env.CHILD_THEME_NAME;
const BRANCH = process.env.CHILD_THEME_BRANCH || 'master';
const WPE_REMOTE = process.env.WPENGINE_GIT_REMOTE;
const WPE_INSTALL_ID = process.env.WPENGINE_INSTALL_ID;
const WPE_API_USER = process.env.WPENGINE_API_USER;
const WPE_API_PASSWORD = process.env.WPENGINE_API_PASSWORD;

// Write SSH private key to a temp file and set GIT_SSH_COMMAND env var
function setupSshKey() {
  const keyPath = path.join(os.tmpdir(), 'wpengine_agent_key');
  fs.writeFileSync(keyPath, process.env.SSH_PRIVATE_KEY + '\n', { mode: 0o600 });
  // Set globally so all git operations in this process use this key
  process.env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  return keyPath;
}

// Clone the child theme repo to a temp directory
async function cloneRepo() {
  const keyPath = setupSshKey();
  const cloneDir = path.join(os.tmpdir(), `theme-${Date.now()}`);

  const git = simpleGit();
  await git.clone(REPO_URL, cloneDir, ['--branch', BRANCH]);
  return { cloneDir, keyPath };
}

// Get current git SHA (stored before making changes for revert)
async function getCurrentSha(cloneDir) {
  const git = simpleGit(cloneDir);
  const log = await git.log(['-1']);
  return log.latest.hash;
}

// Edit a file inside the cloned child theme
function editFile(cloneDir, relativePath, newContent) {
  // relativePath is relative to the child theme folder, e.g. "style.css"
  const fullRelative = `wp-content/themes/${THEME_NAME}/${relativePath}`;
  validatePath(fullRelative);

  const filePath = path.join(cloneDir, relativePath);
  fs.writeFileSync(filePath, newContent, 'utf8');
}

// Read a file from the cloned child theme
function readFile(cloneDir, relativePath) {
  const filePath = path.join(cloneDir, relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

// Commit and push to Bitbucket + WP Engine staging
async function commitAndDeploy(cloneDir, keyPath, commitMessage) {
  // GIT_SSH_COMMAND already set by setupSshKey()
  const git = simpleGit({ baseDir: cloneDir });

  await git.addConfig('user.name', 'AI Agent');
  await git.addConfig('user.email', process.env.ATLASSIAN_EMAIL);

  await git.add('.');
  await git.commit(commitMessage);

  // Push to Bitbucket (source of truth)
  await git.push('origin', BRANCH);

  // Push to WP Engine staging
  await git.addRemote('wpengine', WPE_REMOTE).catch(() => {});
  await git.push('wpengine', `${BRANCH}:master`);

  // Get new SHA for revert metadata
  const log = await git.log(['-1']);
  return log.latest.hash;
}

// Purge WP Engine cache after deploy
async function purgeCache() {
  try {
    await axios.post(
      `https://api.wpengineapi.com/v1/installs/${WPE_INSTALL_ID}/purge_cache`,
      { type: 'object' },
      {
        auth: { username: WPE_API_USER, password: WPE_API_PASSWORD }
      }
    );
    console.log('WP Engine cache purged');
  } catch (e) {
    console.warn('Cache purge failed (non-fatal):', e.message);
  }
}

// Revert to a previous git SHA on WP Engine
async function revertToSha(oldSha) {
  const keyPath = setupSshKey();
  const { cloneDir } = await cloneRepo();

  const git = simpleGit({ baseDir: cloneDir });
  await git.addRemote('wpengine', WPE_REMOTE).catch(() => {});
  await git.push('wpengine', `${oldSha}:master`, ['--force']);
  await purgeCache();
}

// Clean up cloned directory
function cleanup(cloneDir) {
  fs.rmSync(cloneDir, { recursive: true, force: true });
}

module.exports = { cloneRepo, getCurrentSha, editFile, readFile, commitAndDeploy, purgeCache, revertToSha, cleanup };
