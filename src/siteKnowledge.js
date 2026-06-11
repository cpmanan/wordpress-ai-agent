/**
 * siteKnowledge.js
 *
 * Builds and caches a structured knowledge base of the WordPress site.
 * Connects via WP CLI (SSH) + REST API to capture:
 *   - All pages (ID, title, slug, template, Elementor flag)
 *   - Navigation menus and their items
 *   - Installed plugins (active/inactive)
 *   - Active theme info
 *   - Custom post types
 *   - Site options (front page, blog page, site name)
 *   - Elementor-enabled pages
 *
 * Usage:
 *   const { buildKnowledge, getKnowledge, getContextForTask } = require('./siteKnowledge');
 *
 *   await buildKnowledge();          // scan & save
 *   const kb = getKnowledge();       // load cached version
 *   const ctx = getContextForTask('elementor');  // focused subset for GPT
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'site-knowledge.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function wpBase()  { return process.env.WP_STAGING_URL; }
function wpAuth()  { return { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD }; }

async function safeCliJson(runWpCli, cmd) {
  try {
    const out = await runWpCli(cmd + ' --format=json');
    return JSON.parse(out || '[]');
  } catch (e) {
    console.warn(`⚠️  WP CLI warning for "${cmd}": ${e.message}`);
    return [];
  }
}

async function safeCliValue(runWpCli, cmd) {
  try {
    return (await runWpCli(cmd)).trim();
  } catch (e) {
    return '';
  }
}

// ── Main builder ─────────────────────────────────────────────────────────────

async function buildKnowledge() {
  const { runWpCli } = require('./wpCli');
  console.log('🔍 Building site knowledge base...');

  const knowledge = {
    generated_at: new Date().toISOString(),
    site: {},
    pages: [],
    posts: [],
    menus: [],
    plugins: [],
    theme: {},
    custom_post_types: [],
    elementor_pages: [],
    front_page_id: null,
    blog_page_id: null,
  };

  // ── Site options ────────────────────────────────────────────────────────
  const [blogname, siteurl, frontPageId, blogPageId, template, stylesheet] = await Promise.all([
    safeCliValue(runWpCli, 'option get blogname'),
    safeCliValue(runWpCli, 'option get siteurl'),
    safeCliValue(runWpCli, 'option get page_on_front'),
    safeCliValue(runWpCli, 'option get page_for_posts'),
    safeCliValue(runWpCli, 'option get template'),
    safeCliValue(runWpCli, 'option get stylesheet'),
  ]);

  knowledge.site         = { blogname, siteurl };
  knowledge.front_page_id = parseInt(frontPageId) || null;
  knowledge.blog_page_id  = parseInt(blogPageId)  || null;
  knowledge.theme = { parent: template, child: stylesheet };
  console.log(`  ✅ Site: "${blogname}" | Theme: ${stylesheet} (parent: ${template})`);

  // ── All pages ───────────────────────────────────────────────────────────
  const pages = await safeCliJson(runWpCli,
    'post list --post_type=page --post_status=publish,draft --fields=ID,post_title,post_name,post_status,page_template --numberposts=-1'
  );
  knowledge.pages = pages.map(p => ({
    id:       parseInt(p.ID),
    title:    p.post_title,
    slug:     p.post_name,
    status:   p.post_status,
    template: p.page_template || 'default',
  }));
  console.log(`  ✅ Pages: ${knowledge.pages.length} found`);

  // ── Pages using Elementor ───────────────────────────────────────────────
  const elemPages = await safeCliJson(runWpCli,
    'post list --post_type=page --meta_key=_elementor_edit_mode --meta_value=builder --fields=ID,post_title,post_name --numberposts=-1'
  );
  knowledge.elementor_pages = elemPages.map(p => ({
    id:    parseInt(p.ID),
    title: p.post_title,
    slug:  p.post_name,
  }));
  // Tag the main pages list with Elementor flag
  const elemIds = new Set(knowledge.elementor_pages.map(p => p.id));
  knowledge.pages.forEach(p => { p.uses_elementor = elemIds.has(p.id); });
  // Add front_page / home flag
  knowledge.pages.forEach(p => { p.is_front_page = p.id === knowledge.front_page_id; });
  console.log(`  ✅ Elementor pages: ${knowledge.elementor_pages.length}`);

  // ── Recent posts ────────────────────────────────────────────────────────
  const posts = await safeCliJson(runWpCli,
    'post list --post_type=post --post_status=publish --fields=ID,post_title,post_name,post_date --numberposts=30'
  );
  knowledge.posts = posts.map(p => ({
    id:    parseInt(p.ID),
    title: p.post_title,
    slug:  p.post_name,
    date:  p.post_date,
  }));
  console.log(`  ✅ Posts: ${knowledge.posts.length} recent`);

  // ── Navigation menus ────────────────────────────────────────────────────
  const menus = await safeCliJson(runWpCli, 'menu list --fields=term_id,name,slug,count');
  knowledge.menus = [];
  for (const menu of menus) {
    const items = await safeCliJson(runWpCli,
      `menu item list "${menu.name}" --fields=ID,title,url,object,object_id,menu_item_parent`
    );
    knowledge.menus.push({
      id:   parseInt(menu.term_id),
      name: menu.name,
      slug: menu.slug,
      items: items.map(i => ({
        id:        parseInt(i.ID),
        title:     i.title,
        url:       i.url,
        type:      i.object,       // 'page', 'custom', 'category'
        object_id: parseInt(i.object_id),
        parent_id: parseInt(i.menu_item_parent) || null,
      }))
    });
  }
  console.log(`  ✅ Menus: ${knowledge.menus.length} (${knowledge.menus.map(m=>m.name).join(', ')})`);

  // ── Plugins ─────────────────────────────────────────────────────────────
  const plugins = await safeCliJson(runWpCli, 'plugin list --fields=name,title,status,version');
  knowledge.plugins = plugins.map(p => ({
    slug:    p.name,
    title:   p.title,
    status:  p.status,   // 'active', 'inactive', 'must-use'
    version: p.version,
  }));
  const active = knowledge.plugins.filter(p => p.status === 'active').map(p => p.title);
  console.log(`  ✅ Plugins: ${knowledge.plugins.length} total | Active: ${active.slice(0,8).join(', ')}`);

  // ── Custom post types ───────────────────────────────────────────────────
  const cpts = await safeCliJson(runWpCli, 'post-type list --fields=name,label,public --format=json');
  knowledge.custom_post_types = cpts
    .filter(c => c.public === '1' && !['post','page','attachment'].includes(c.name))
    .map(c => ({ slug: c.name, label: c.label }));
  if (knowledge.custom_post_types.length > 0) {
    console.log(`  ✅ Custom post types: ${knowledge.custom_post_types.map(c=>c.slug).join(', ')}`);
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
  console.log(`\n✅ Knowledge base saved → ${KNOWLEDGE_FILE}`);
  console.log(`   Pages: ${knowledge.pages.length} | Menus: ${knowledge.menus.length} | Plugins: ${knowledge.plugins.length} active`);

  return knowledge;
}

// ── Load cached knowledge ─────────────────────────────────────────────────────

function getKnowledge() {
  if (!fs.existsSync(KNOWLEDGE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ── Build focused context string for GPT per task type ───────────────────────
// Only injects what's relevant — keeps token count low

function getContextForTask(taskType, kb) {
  if (!kb) return '';
  const lines = [];

  lines.push(`## WordPress Site Knowledge Base`);
  lines.push(`Site: ${kb.site?.blogname} (${kb.site?.siteurl})`);
  lines.push(`Front page ID: ${kb.front_page_id}`);
  lines.push(`Knowledge snapshot: ${kb.generated_at ? kb.generated_at.substring(0, 10) : 'unknown'}`);
  lines.push('');

  // Pages — always useful
  lines.push(`### All Pages (${kb.pages?.length})`);
  (kb.pages || []).forEach(p => {
    const flags = [
      p.is_front_page      ? '🏠 FRONT PAGE'   : '',
      p.uses_elementor     ? '⚡ Elementor'     : '',
      p.status === 'draft' ? '📝 draft'         : '',
    ].filter(Boolean).join(' ');
    lines.push(`  • ID ${p.id}: "${p.title}" /${p.slug}/ ${flags}`);
  });
  lines.push('');

  // Menus — for nav/content tasks
  if (['nav', 'content', 'elementor'].includes(taskType) && kb.menus?.length) {
    lines.push(`### Navigation Menus`);
    (kb.menus || []).forEach(m => {
      lines.push(`  Menu: "${m.name}" (ID ${m.id})`);
      (m.items || []).forEach(i => {
        lines.push(`    - "${i.title}" → ${i.url} (type: ${i.type}, object_id: ${i.object_id})`);
      });
    });
    lines.push('');
  }

  // Plugins — for plugin/seo/elementor tasks
  if (['plugin', 'backup', 'seo', 'elementor', 'file'].includes(taskType) && kb.plugins?.length) {
    const active = (kb.plugins || []).filter(p => p.status === 'active');
    lines.push(`### Active Plugins (${active.length})`);
    active.forEach(p => lines.push(`  • ${p.title} (${p.slug}) v${p.version}`));
    lines.push('');
  }

  // Elementor pages — for elementor tasks
  if (taskType === 'elementor' && kb.elementor_pages?.length) {
    lines.push(`### Pages Using Elementor`);
    (kb.elementor_pages || []).forEach(p => {
      lines.push(`  • ID ${p.id}: "${p.title}" /${p.slug}/`);
    });
    lines.push('');
  }

  // Custom post types
  if (kb.custom_post_types?.length) {
    lines.push(`### Custom Post Types`);
    kb.custom_post_types.forEach(c => lines.push(`  • ${c.slug}: ${c.label}`));
    lines.push('');
  }

  // Theme
  lines.push(`### Active Theme`);
  lines.push(`  Child theme: ${kb.theme?.child}  |  Parent theme: ${kb.theme?.parent}`);

  return lines.join('\n');
}

// ── Age check ─────────────────────────────────────────────────────────────────

function isStale(maxAgeHours = 24) {
  const kb = getKnowledge();
  if (!kb?.generated_at) return true;
  const age = (Date.now() - new Date(kb.generated_at).getTime()) / 3600000;
  return age > maxAgeHours;
}

module.exports = { buildKnowledge, getKnowledge, getContextForTask, isStale };
