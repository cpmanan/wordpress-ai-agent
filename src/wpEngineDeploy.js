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

// Bitbucket HTTPS URL using Repository Access Token
// Username must be x-token-auth (not email) for Bitbucket repo tokens
function getRepoUrl() {
  const token = encodeURIComponent(process.env.BITBUCKET_ACCESS_TOKEN);
  // Convert git@bitbucket.org:cp-jira/brindayoga.git
  //      → https://x-token-auth:token@bitbucket.org/cp-jira/brindayoga.git
  const sshUrl = process.env.CHILD_THEME_REPO;
  const httpsBase = sshUrl
    .replace('git@bitbucket.org:', 'bitbucket.org/')
    .replace('.git', '');
  return `https://x-token-auth:${token}@${httpsBase}.git`;
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

// Read the agent context reference file from the child theme repo
function readAgentContext(cloneDir) {
  const contextPath = path.join(cloneDir, '_agent-context.md');
  if (!fs.existsSync(contextPath)) {
    console.warn('⚠️  _agent-context.md not found in child theme repo');
    return '';
  }
  console.log('📖 Loaded _agent-context.md from child theme repo');
  return fs.readFileSync(contextPath, 'utf8');
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

  // WP Engine deploy is handled by Bitbucket Pipeline automatically on push.
  // No SSH push needed from Railway.
  console.log(`✅ Pushed to Bitbucket — Bitbucket Pipeline will deploy to WP Engine`);

  const log = await git.log(['-1']);
  const sha = log.latest.hash;
  return { sha, wpeDeployed: true };
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
  try {
    await git.addRemote('wpengine', WPE_REMOTE).catch(() => {});
    await git.push('wpengine', `${oldSha}:master`, ['--force']);
    await purgeCache();
  } catch (sshErr) {
    console.warn(`⚠️  WP Engine revert push failed (SSH): ${sshErr.message}`);
    throw new Error(`Revert to Bitbucket succeeded but WP Engine deploy failed: ${sshErr.message}`);
  } finally {
    cleanup(cloneDir);
  }
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
  cloneRepo, getCurrentSha, readFile, readAgentContext, editFile,
  commitAndDeploy, purgeCache, revertToSha, cleanup
};
