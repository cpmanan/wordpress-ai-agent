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

// Base path inside the cloned repo where theme files live
// Repo structure: wp-content/themes/<THEME_NAME>/style.css etc.
function themeDir(cloneDir) {
  return path.join(cloneDir, 'wp-content', 'themes', THEME_NAME);
}

// Read a file from the cloned theme
function readFile(cloneDir, relativePath) {
  const filePath = path.join(themeDir(cloneDir), relativePath);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// Read the agent context reference file from the child theme repo
function readAgentContext(cloneDir) {
  const contextPath = path.join(themeDir(cloneDir), '_agent-context.md');
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
  const filePath = path.join(themeDir(cloneDir), relativePath);
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

/**
 * Poll Bitbucket Pipelines API until the latest pipeline for the repo completes.
 * Returns 'SUCCESSFUL' | 'FAILED' | 'STOPPED' | 'TIMEOUT'.
 *
 * Requires env vars:
 *   BITBUCKET_WORKSPACE  — e.g. "cp-jira"
 *   BITBUCKET_REPO_SLUG  — e.g. "brindayoga"
 *   BITBUCKET_ACCESS_TOKEN — repo access token
 *
 * @param {string} commitSha  — the SHA we just pushed, so we watch the right pipeline
 * @param {number} timeoutMs  — give up after this many ms (default 10 min)
 */
async function pollPipelineUntilDone(commitSha, timeoutMs = 600000) {
  const workspace = process.env.BITBUCKET_WORKSPACE || 'cp-jira';
  const repoSlug  = process.env.BITBUCKET_REPO_SLUG  || 'brindayoga';
  const token     = process.env.BITBUCKET_ACCESS_TOKEN;

  if (!token) {
    console.warn('⚠️  BITBUCKET_ACCESS_TOKEN not set — skipping pipeline poll, sleeping 90s instead');
    await new Promise(r => setTimeout(r, 90000));
    return 'UNKNOWN';
  }

  const apiBase = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pipelines/`;
  const headers = { Authorization: `Bearer ${token}` };

  const deadline = Date.now() + timeoutMs;
  let pipelineUuid = null;

  // Step 1 — find the pipeline triggered by our commit (poll up to 30s for it to appear)
  console.log(`🔍 Looking for Bitbucket pipeline for commit ${commitSha.slice(0, 8)}...`);
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(apiBase, {
        headers,
        params: { sort: '-created_on', pagelen: 5 },
      });
      const pipelines = res.data?.values || [];
      const match = pipelines.find(p => p.target?.commit?.hash?.startsWith(commitSha.slice(0, 12)));
      if (match) {
        pipelineUuid = match.uuid;
        console.log(`✅ Found pipeline ${pipelineUuid} — state: ${match.state?.name}`);
        break;
      }
    } catch (e) {
      console.warn('⚠️  Pipeline list error:', e.message);
    }
    await new Promise(r => setTimeout(r, 10000)); // check every 10s
  }

  if (!pipelineUuid) {
    console.warn('⚠️  Could not find pipeline for commit — sleeping 90s as fallback');
    await new Promise(r => setTimeout(r, 90000));
    return 'UNKNOWN';
  }

  // Step 2 — poll until COMPLETED
  console.log(`⏳ Polling pipeline ${pipelineUuid} until done...`);
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(`${apiBase}${pipelineUuid}`, { headers });
      const pipeline = res.data;
      const stateName   = pipeline.state?.name;        // PENDING | IN_PROGRESS | COMPLETED
      const resultName  = pipeline.state?.result?.name; // SUCCESSFUL | FAILED | STOPPED

      console.log(`  Pipeline state: ${stateName} / ${resultName || '—'}`);

      if (stateName === 'COMPLETED') {
        console.log(`✅ Pipeline finished: ${resultName}`);
        return resultName || 'COMPLETED';
      }
    } catch (e) {
      console.warn('⚠️  Pipeline poll error:', e.message);
    }
    await new Promise(r => setTimeout(r, 15000)); // check every 15s
  }

  console.warn('⚠️  Pipeline poll timed out');
  return 'TIMEOUT';
}

module.exports = {
  cloneRepo, getCurrentSha, readFile, readAgentContext, editFile,
  commitAndDeploy, purgeCache, revertToSha, cleanup, pollPipelineUntilDone
};
