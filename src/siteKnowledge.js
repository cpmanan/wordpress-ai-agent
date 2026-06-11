/**
 * siteKnowledge.js
 *
 * Builds a structured knowledge base of the WordPress site.
 * Uses the brinda-agent REST API plugin (HTTPS) — no SSH needed.
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
const axios = require('axios');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'site-knowledge.json');

const WP_BASE    = () => process.env.WP_STAGING_URL;
const wpAuth     = () => ({ username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD });
const agentHdrs  = () => ({ 'X-Agent-Token': process.env.AGENT_TOKEN || '' });

// ── Main builder ──────────────────────────────────────────────────────────────

async function buildKnowledge() {
  console.log('🔍 Building site knowledge base via REST API...');

  let siteInfo;
  try {
    const res = await axios.get(
      `${WP_BASE()}/wp-json/brinda-agent/v1/site-info`,
      { headers: agentHdrs(), timeout: 30000 }
    );
    siteInfo = res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Could not fetch site info: ${msg}`);
  }

  const kb = {
    generated_at:      new Date().toISOString(),
    site:              siteInfo.site              || {},
    pages:             siteInfo.pages             || [],
    posts:             siteInfo.posts             || [],
    menus:             siteInfo.menus             || [],
    plugins:           siteInfo.plugins           || [],
    theme:             siteInfo.theme             || {},
    custom_post_types: siteInfo.custom_post_types || [],
    elementor_pages:   siteInfo.elementor_pages   || [],
    front_page_id:     siteInfo.front_page_id     || null,
    blog_page_id:      siteInfo.blog_page_id      || null,
  };

  const active = kb.plugins.filter(p => p.status === 'active');

  console.log(`  ✅ Site: "${kb.site.blogname}" (${kb.site.siteurl})`);
  console.log(`  ✅ Theme: child=${kb.theme.child}  parent=${kb.theme.parent}`);
  console.log(`  ✅ Front page ID: ${kb.front_page_id}`);
  console.log(`  ✅ Pages: ${kb.pages.length}`);
  console.log(`  ✅ Elementor pages: ${kb.elementor_pages.length}`);
  console.log(`  ✅ Posts: ${kb.posts.length} recent`);
  console.log(`  ✅ Menus: ${kb.menus.length} (${kb.menus.map(m => m.name).join(', ')})`);
  console.log(`  ✅ Plugins: ${kb.plugins.length} total | Active: ${active.map(p => p.title).slice(0, 6).join(', ')}`);
  if (kb.custom_post_types.length) {
    console.log(`  ✅ Custom post types: ${kb.custom_post_types.map(c => c.slug).join(', ')}`);
  }

  // ── Extended info: DB schema, plugin configs, custom code ─────────────────
  console.log('  🔍 Fetching extended info (DB schema, plugin configs, custom code)...');
  try {
    const extRes = await axios.get(
      `${WP_BASE()}/wp-json/brinda-agent/v1/extended-info`,
      { headers: agentHdrs(), timeout: 30000 }
    );
    kb.db_schema      = extRes.data.db_schema      || [];
    kb.plugin_configs = extRes.data.plugin_configs || [];
    kb.custom_code    = extRes.data.custom_code    || {};

    const customTables = kb.db_schema.filter(t => !t.is_core);
    console.log(`  ✅ DB tables: ${kb.db_schema.length} total | Custom/plugin tables: ${customTables.length}`);
    console.log(`  ✅ Plugin configs: ${kb.plugin_configs.length} plugins with stored settings`);
    const codeKeys = Object.keys(kb.custom_code);
    console.log(`  ✅ Custom code: ${codeKeys.join(', ') || 'none'}`);
  } catch (e) {
    console.warn(`  ⚠️  Extended info fetch failed: ${e.message.split('\n')[0]}`);
    // Fall back to the committed db-schema.sql file for table structure
    const schemaFile = path.join(__dirname, '..', 'db-schema.sql');
    if (fs.existsSync(schemaFile)) {
      const sql = fs.readFileSync(schemaFile, 'utf8');
      const tableMatches = [...sql.matchAll(/CREATE TABLE `(\w+)` \(([\s\S]*?)\);/g)];
      kb.db_schema = tableMatches.map(m => ({
        table:   m[1],
        is_core: m[1].match(/^wp_(commentmeta|comments|links|options|postmeta|posts|term_|termmeta|terms|usermeta|users)/) ? true : false,
        columns: [...m[2].matchAll(/`(\w+)` (\w+)/g)].map(c => ({ name: c[1], type: c[2] })),
      }));
      console.log(`  ✅ DB schema loaded from committed db-schema.sql (${kb.db_schema.length} tables)`);
    } else {
      kb.db_schema = [];
    }
    kb.plugin_configs = []; kb.custom_code = {};
  }

  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(kb, null, 2));
  console.log(`\n✅ Knowledge base saved → ${KNOWLEDGE_FILE}`);
  console.log(`   Pages: ${kb.pages.length} | Elementor: ${kb.elementor_pages.length} | Menus: ${kb.menus.length} | Active plugins: ${active.length}`);

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

  // Custom post types + their taxonomy categories
  if (kb.custom_post_types?.length) {
    lines.push('### Custom Post Types');
    kb.custom_post_types.forEach(c => {
      lines.push(`  • ${c.slug}: ${c.label}`);
      (c.taxonomies || []).forEach(tax => {
        if (tax.terms?.length) {
          const termList = tax.terms.map(t => `"${t.name}"(id:${t.id},count:${t.count})`).join(', ');
          lines.push(`    └─ ${tax.slug}: ${termList}`);
        }
      });
    });
    lines.push('');
  }

  lines.push('### Active Theme');
  lines.push(`  Child: ${kb.theme?.child}  |  Parent: ${kb.theme?.parent}`);

  // ── DB Schema (custom/plugin tables only — not WP core) ───────────────────
  const customTables = (kb.db_schema || []).filter(t => !t.is_core);
  if (customTables.length && ['plugin', 'content', 'elementor', 'seo'].includes(taskType)) {
    lines.push('');
    lines.push(`### Database — Custom & Plugin Tables (${customTables.length})`);
    customTables.forEach(t => {
      const cols = (t.columns || []).map(c => `${c.name}(${c.type})`).join(', ');
      lines.push(`  • ${t.table}${cols ? `: ${cols.substring(0, 120)}` : ''}`);
    });
  }

  // ── Plugin configs (show key settings per plugin) ─────────────────────────
  if ((kb.plugin_configs || []).length && ['plugin', 'seo', 'elementor', 'content'].includes(taskType)) {
    lines.push('');
    lines.push('### Plugin Configurations');
    (kb.plugin_configs || []).forEach(p => {
      lines.push(`  • ${p.name} v${p.version}`);
      Object.entries(p.config || {}).slice(0, 4).forEach(([k, v]) => {
        const val = typeof v === 'object' ? JSON.stringify(v).substring(0, 80) : String(v).substring(0, 80);
        lines.push(`    ${k}: ${val}`);
      });
    });
  }

  // ── Custom code (child theme functions + hooks) ───────────────────────────
  if (kb.custom_code?.registered_hooks?.length && ['file', 'content', 'elementor'].includes(taskType)) {
    lines.push('');
    lines.push('### Child Theme Registered Hooks');
    kb.custom_code.registered_hooks.slice(0, 20).forEach(([type, name]) => {
      lines.push(`  • add_${type}: ${name}`);
    });
  }
  if (kb.custom_code?.child_theme_functions && taskType === 'file') {
    lines.push('');
    lines.push('### Child Theme functions.php (first 3KB)');
    lines.push('```php');
    lines.push((kb.custom_code.child_theme_functions.content || '').substring(0, 3000));
    lines.push('```');
  }
  if ((kb.custom_code?.custom_plugins || []).length) {
    lines.push('');
    lines.push('### Custom Plugins (non-repo)');
    (kb.custom_code.custom_plugins || []).forEach(p => {
      lines.push(`  • ${p.slug}/${p.file}`);
    });
  }

  return lines.join('\n');
}

// ── Stale check ───────────────────────────────────────────────────────────────

function isStale(maxAgeHours = 24) {
  const kb = getKnowledge();
  if (!kb?.generated_at) return true;
  return (Date.now() - new Date(kb.generated_at).getTime()) / 3_600_000 > maxAgeHours;
}

module.exports = { buildKnowledge, getKnowledge, getContextForTask, isStale };
