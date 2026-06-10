const simpleGit = require('simple-git');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { validatePath } = require('./guard');

const THEME_NAME  = process.env.CHILD_THEME_NAME;
const BRANCH      = process.env.CHILD_THEME_BRANCH || 'master';
const WPE_REMOTE  = process.env.WPENGINE_GIT_REMOTE;
const WPE_INSTALL_ID  = process.env.WPENGINE_INSTALL_ID;
const WPE_API_USER    = process.env.WPENGINE_API_USER;
const WPE_API_PASSWORD = process.env.WPENGINE_API_PASSWORD;

// Bitbucket HTTPS URL (avoids SSH key issues on Railway)
function getRepoUrl() {
  const user  = encodeURIComponent(process.env.BITBUCKET_USERNAME);
  const token = encodeURIComponent(process.env.ATLASSIAN_API_TOKEN);
  // Convert git@bitbucket.org:cp-jira/brindayoga.git
  //      → https://user:token@bitbucket.org/cp-jira/brindayoga.git
  const sshUrl = process.env.CHILD_THEME_REPO;
  const httpsBase = sshUrl
    .replace('git@bitbucket.org:', 'bitbucket.org/')
    .replace('.git', '');
  return `https://${user}:${token}@${httpsBase}.git`;
}

// Write SSH private key for WP Engine GitPush (SSH is only needed for wpengine remote push)
function setupSshKey() {
  const keyPath = path.join(os.tmpdir(), 'wpengine_agent_key');
  const rawKey = process.env.SSH_PRIVATE_KEY || '';
  // Handle escaped newlines from Railway env vars
  const key = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
  process.env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  return keyPath;
}

// Clone the child theme repo using HTTPS (reliable on Railway)
async function cloneRepo() {
  setupSshKey(); // still needed for wpengine push later
  const cloneDir = path.join(os.tmpdir(), `theme-${Date.now()}`);
  const repoUrl = getRepoUrl();

  const git = simpleGit();
  await git.clone(repoUrl, cloneDir, ['--branch', BRANCH]);
  console.log(`✅ Cloned theme to ${cloneDir}`);
  return { cloneDir };
}

// Get current git SHA (for revert metadata)
async function getCurrentSha(cloneDir) {
  const git = simpleGit(cloneDir);
  const log = await git.log(['-1']);
  return log.latest.hash;
}

// Read a file from the cloned theme
function readFile(cloneDir, relativePath) {
  const filePath = path.join(cloneDir, relativePath);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// Write a file — validates path first
function editFile(cloneDir, relativePath, newContent) {
  const fullRelative = `wp-content/themes/${THEME_NAME}/${relativePath}`;
  validatePath(fullRelative);
  const filePath = path.join(cloneDir, relativePath);
  // Ensure directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log(`✏️  Wrote: ${relativePath}`);
}

// Commit → push to Bitbucket → push to WP Engine staging
async function commitAndDeploy(cloneDir, commitMessage) {
  const git = simpleGit({ baseDir: cloneDir });

  await git.addConfig('user.name', 'AI Agent');
  await git.addConfig('user.email', process.env.ATLASSIAN_EMAIL || 'agent@brindayoga.com');

  await git.add('.');
  const status = await git.status();
  if (status.staged.length === 0) {
    console.log('⚠️  No changes to commit');
    return await getCurrentSha(cloneDir);
  }

  await git.commit(commitMessage);
  console.log(`✅ Committed: ${commitMessage}`);

  // Push to Bitbucket via HTTPS (source of truth)
  const repoUrl = getRepoUrl();
  await git.push(repoUrl, `HEAD:${BRANCH}`);
  console.log(`✅ Pushed to Bitbucket`);

  // Push to WP Engine via SSH (GIT_SSH_COMMAND already set)
  await git.addRemote('wpengine', WPE_REMOTE).catch(() => {});
  await git.push('wpengine', `HEAD:master`);
  console.log(`✅ Pushed to WP Engine staging`);

  const log = await git.log(['-1']);
  return log.latest.hash;
}

// Purge WP Engine cache after deploy
async function purgeCache() {
  try {
    await axios.post(
      `https://api.wpengineapi.com/v1/installs/${WPE_INSTALL_ID}/purge_cache`,
      { type: 'object' },
      { auth: { username: WPE_API_USER, password: WPE_API_PASSWORD } }
    );
    console.log('✅ WP Engine cache purged');
  } catch (e) {
    console.warn('⚠️  Cache purge failed (non-fatal):', e.message);
  }
}

// Revert to a previous git SHA on WP Engine
async function revertToSha(oldSha) {
  setupSshKey();
  const { cloneDir } = await cloneRepo();
  const git = simpleGit({ baseDir: cloneDir });
  await git.addRemote('wpengine', WPE_REMOTE).catch(() => {});
  await git.push('wpengine', `${oldSha}:master`, ['--force']);
  await purgeCache();
  cleanup(cloneDir);
}

// Remove temp clone directory
function cleanup(cloneDir) {
  try {
    fs.rmSync(cloneDir, { recursive: true, force: true });
  } catch (e) {
    console.warn('Cleanup warning:', e.message);
  }
}

module.exports = {
  cloneRepo, getCurrentSha, readFile, editFile,
  commitAndDeploy, purgeCache, revertToSha, cleanup
};
