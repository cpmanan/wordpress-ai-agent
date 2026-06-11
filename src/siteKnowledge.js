/**
 * siteKnowledge.js
 *
 * Builds a structured knowledge base of the WordPress site via WP CLI over SSH.
 * SSH connection is now confirmed working (Railway → WP Engine).
 *
 * Captures:
 *   - All pages (ID, title, slug, status, template, Elementor flag)
 *   - Navigation menus + items
 *   - All plugins (active/inactive)
 *   - Active theme (child + parent)
 *   - Custom post types
 *   - Site options (front page, blog page, site name, siteurl)
 *   - Elementor-enabled pages
 *   - Recent posts
 */

const fs   = require('fs');
const path = require('path');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'site-knowledge.json');

// ── WP CLI helpers ────────────────────────────────────────────────────────────

async function cliJson(runWpCli, cmd) {
  try {
    const out = await runWpCli(cmd + ' --format=json');
    return JSON.parse(out || '[]');
  } catch (e) {
    console.warn(`  ⚠️  WP CLI "${cmd.substring(0, 60)}": ${e.message.split('\n')[0]}`);
    return [];
  }
}

async function cliVal(runWpCli, cmd) {
  try {
    return (await runWpCli(cmd)).trim();
  } catch {
    return '';
  }
}

// ── Main builder ──────────────────────────────────────────────────────────────

async function buildKnowledge() {
  const { runWpCli } = require('./wpCli');
  console.log('🔍 Building site knowledge base via SSH + WP CLI...');

  const kb = {
    generated_at:      new Date().toISOString(),
    site:              {},
    pages:             [],
    posts:             [],
    menus:             [],
    plugins:           [],
    theme:             {},
    custom_post_types: [],
    elementor_pages:   [],
    front_page_id:     null,
    blog_page_id:      null,
  };

  // ── 1. Site options (parallel) ─────────────────────────────────────────
  const [blogname, siteurl, frontPageId, blogPageId, template, stylesheet] = await Promise.all([
    cliVal(runWpCli, 'option get blogname'),
    cliVal(runWpCli, 'option get siteurl'),
    cliVal(runWpCli, 'option get page_on_front'),
    cliVal(runWpCli, 'option get page_for_posts'),
    cliVal(runWpCli, 'option get template'),
    cliVal(runWpCli, 'option get stylesheet'),
  ]);

  kb.site          = { blogname, siteurl };
  kb.front_page_id = parseInt(frontPageId) || null;
  kb.blog_page_id  = parseInt(blogPageId)  || null;
  kb.theme         = { child: stylesheet, parent: template };
  console.log(`  ✅ Site: "${blogname}" (${siteurl})`);
  console.log(`  ✅ Theme: child=${stylesheet}  parent=${template}`);
  console.log(`  ✅ Front page ID: ${kb.front_page_id}`);

  // ── 2. All pages ───────────────────────────────────────────────────────
  const rawPages = await cliJson(runWpCli,
    'post list --post_type=page --post_status=publish,draft --fields=ID,post_title,post_name,post_status,page_template --posts_per_page=-1'
  );
  kb.pages = rawPages.map(p => ({
    id:       parseInt(p.ID),
    title:    p.post_title,
    slug:     p.post_name,
    status:   p.post_status,
    template: p.page_template || 'default',
  }));
  console.log(`  ✅ Pages: ${kb.pages.length}`);

  // ── 3. Elementor pages ─────────────────────────────────────────────────
  const rawElem = await cliJson(runWpCli,
    'post list --post_type=page --meta_key=_elementor_edit_mode --meta_value=builder --fields=ID,post_title,post_name --posts_per_page=-1'
  );
  kb.elementor_pages = rawElem.map(p => ({
    id:    parseInt(p.ID),
    title: p.post_title,
    slug:  p.post_name,
  }));
  const elemIds = new Set(kb.elementor_pages.map(p => p.id));
  kb.pages.forEach(p => {
    p.uses_elementor = elemIds.has(p.id);
    p.is_front_page  = p.id === kb.front_page_id;
  });
  console.log(`  ✅ Elementor pages: ${kb.elementor_pages.length}`);

  // ── 4. Recent posts ────────────────────────────────────────────────────
  const rawPosts = await cliJson(runWpCli,
    'post list --post_type=post --post_status=publish --fields=ID,post_title,post_name,post_date --posts_per_page=30'
  );
  kb.posts = rawPosts.map(p => ({
    id:    parseInt(p.ID),
    title: p.post_title,
    slug:  p.post_name,
    date:  p.post_date,
  }));
  console.log(`  ✅ Posts: ${kb.posts.length} recent`);

  // ── 5. Navigation menus ────────────────────────────────────────────────
  const rawMenus = await cliJson(runWpCli, 'menu list --fields=term_id,name,slug,count');
  kb.menus = [];
  for (const menu of rawMenus) {
    const items = await cliJson(runWpCli,
      `menu item list "${menu.name}" --fields=ID,title,url,object,object_id,menu_item_parent`
    );
    kb.menus.push({
      id:    parseInt(menu.term_id),
      name:  menu.name,
      slug:  menu.slug,
      items: items.map(i => ({
        id:        parseInt(i.ID),
        title:     i.title,
        url:       i.url,
        type:      i.object,
        object_id: parseInt(i.object_id),
        parent_id: parseInt(i.menu_item_parent) || null,
      })),
    });
  }
  console.log(`  ✅ Menus: ${kb.menus.length} (${kb.menus.map(m => m.name).join(', ')})`);

  // ── 6. Plugins ─────────────────────────────────────────────────────────
  const rawPlugins = await cliJson(runWpCli, 'plugin list --fields=name,title,status,version');
  kb.plugins = rawPlugins.map(p => ({
    slug:    p.name,
    title:   p.title,
    status:  p.status,
    version: p.version,
  }));
  const active = kb.plugins.filter(p => p.status === 'active');
  console.log(`  ✅ Plugins: ${kb.plugins.length} total | Active: ${active.map(p => p.title).slice(0, 6).join(', ')}`);

  // ── 7. Custom post types ───────────────────────────────────────────────
  const rawCpts = await cliJson(runWpCli, 'post-type list --fields=name,label,public');
  kb.custom_post_types = rawCpts
    .filter(c => c.public === '1' && !['post', 'page', 'attachment'].includes(c.name))
    .map(c => ({ slug: c.name, label: c.label }));
  if (kb.custom_post_types.length) {
    console.log(`  ✅ Custom post types: ${kb.custom_post_types.map(c => c.slug).join(', ')}`);
  }

  // ── Save ──────────────────────────────────────────────────────────────
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(kb, null, 2));
  console.log(`\n✅ Knowledge base saved → ${KNOWLEDGE_FILE}`);
  console.log(`   Pages: ${kb.pages.length} | Elementor: ${kb.elementor_pages.length} | Menus: ${kb.menus.length} | Plugins active: ${active.length}`);

  return kb;
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

// ── Focused context string injected into every GPT system prompt ──────────────

function getContextForTask(taskType, kb) {
  if (!kb) return '';
  const lines = [];

  lines.push('## WordPress Site Knowledge Base');
  lines.push(`Site: ${kb.site?.blogname} (${kb.site?.siteurl})`);
  lines.push(`Front page ID: ${kb.front_page_id} | Snapshot: ${(kb.generated_at || '').substring(0, 10)}`);
  lines.push('');

  // Pages — always included
  lines.push(`### All Pages (${kb.pages?.length})`);
  (kb.pages || []).forEach(p => {
    const flags = [
      p.is_front_page  ? '🏠 FRONT PAGE' : '',
      p.uses_elementor ? '⚡ Elementor'  : '',
      p.status === 'draft' ? '📝 draft'  : '',
    ].filter(Boolean).join(' ');
    lines.push(`  • ID ${p.id}: "${p.title}" /${p.slug}/ ${flags}`.trimEnd());
  });
  lines.push('');

  // Menus
  if (['nav', 'content', 'elementor'].includes(taskType) && kb.menus?.length) {
    lines.push('### Navigation Menus');
    (kb.menus || []).forEach(m => {
      lines.push(`  Menu: "${m.name}" (ID ${m.id})`);
      (m.items || []).forEach(i => {
        lines.push(`    - "${i.title}" → ${i.url} (${i.type}, page_id: ${i.object_id})`);
      });
    });
    lines.push('');
  }

  // Active plugins
  if (['plugin', 'backup', 'seo', 'elementor', 'file'].includes(taskType)) {
    const active = (kb.plugins || []).filter(p => p.status === 'active');
    if (active.length) {
      lines.push(`### Active Plugins (${active.length})`);
      active.forEach(p => lines.push(`  • ${p.title} v${p.version} [${p.slug}]`));
      lines.push('');
    }
  }

  // Elementor pages
  if (taskType === 'elementor' && kb.elementor_pages?.length) {
    lines.push('### Elementor Pages');
    (kb.elementor_pages || []).forEach(p => lines.push(`  • ID ${p.id}: "${p.title}" /${p.slug}/`));
    lines.push('');
  }

  // Custom post types
  if (kb.custom_post_types?.length) {
    lines.push('### Custom Post Types');
    kb.custom_post_types.forEach(c => lines.push(`  • ${c.slug}: ${c.label}`));
    lines.push('');
  }

  lines.push('### Active Theme');
  lines.push(`  Child: ${kb.theme?.child}  |  Parent: ${kb.theme?.parent}`);

  return lines.join('\n');
}

// ── Stale check ───────────────────────────────────────────────────────────────

function isStale(maxAgeHours = 24) {
  const kb = getKnowledge();
  if (!kb?.generated_at) return true;
  return (Date.now() - new Date(kb.generated_at).getTime()) / 3_600_000 > maxAgeHours;
}

module.exports = { buildKnowledge, getKnowledge, getContextForTask, isStale };
