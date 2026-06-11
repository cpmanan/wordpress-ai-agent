/**
 * siteKnowledge.js
 *
 * Builds and caches a structured knowledge base of the WordPress site.
 *
 * Strategy: REST API first (no SSH needed), custom agent endpoint for
 * things the standard REST API doesn't expose (plugins, menus, theme,
 * site options). SSH/WP CLI is NOT used — Railway cannot reach WP Engine SSH.
 *
 * Sources:
 *   /wp-json/wp/v2/pages          → all pages
 *   /wp-json/wp/v2/posts          → recent posts
 *   /wp-json/wp/v2/menu-items     → navigation menu items
 *   /wp-json/wp/v2/menus          → menu list (WP 5.9+)
 *   /wp-json/brinda-agent/v1/site-info → plugins, theme, options (custom endpoint)
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'site-knowledge.json');

function wpBase() { return process.env.WP_STAGING_URL; }
function wpAuth() { return { username: process.env.WP_USERNAME, password: process.env.WP_APP_PASSWORD }; }

// ── REST API helpers ──────────────────────────────────────────────────────────

async function restGet(path, params = {}) {
  const res = await axios.get(`${wpBase()}/wp-json${path}`, {
    auth:   wpAuth(),
    params: { per_page: 100, ...params },
    timeout: 15000,
  });
  return res.data;
}

/** GET all pages from a paginated REST endpoint */
async function restGetAll(path, params = {}) {
  const results = [];
  let page = 1;
  while (true) {
    const res = await axios.get(`${wpBase()}/wp-json${path}`, {
      auth:   wpAuth(),
      params: { per_page: 100, page, ...params },
      timeout: 15000,
    });
    results.push(...(res.data || []));
    const total = parseInt(res.headers['x-wp-totalpages'] || '1');
    if (page >= total) break;
    page++;
  }
  return results;
}

// ── Site-info endpoint PHP (deployed to functions.php if not present) ─────────

const SITE_INFO_MARKER = '// brinda-agent: site-info endpoint v1';
const siteInfoEndpointPhp = `

${SITE_INFO_MARKER}
add_action('rest_api_init', function() {
    register_rest_route('brinda-agent/v1', '/site-info', [
        'methods'             => 'GET',
        'permission_callback' => function() { return current_user_can('manage_options'); },
        'callback'            => function() {
            // Plugins
            if (!function_exists('get_plugins')) {
                require_once ABSPATH . 'wp-admin/includes/plugin.php';
            }
            $all_plugins    = get_plugins();
            $active_plugins = get_option('active_plugins', []);
            $plugins = [];
            foreach ($all_plugins as $file => $data) {
                $plugins[] = [
                    'slug'    => dirname($file) ?: $file,
                    'file'    => $file,
                    'title'   => $data['Name'],
                    'version' => $data['Version'],
                    'status'  => in_array($file, $active_plugins) ? 'active' : 'inactive',
                ];
            }

            // Theme
            $theme = wp_get_theme();

            // Menus
            $nav_menus    = wp_get_nav_menus();
            $menus_data   = [];
            foreach ($nav_menus as $menu) {
                $items = wp_get_nav_menu_items($menu->term_id);
                $menu_items = [];
                if ($items) {
                    foreach ($items as $item) {
                        $menu_items[] = [
                            'id'        => $item->ID,
                            'title'     => $item->title,
                            'url'       => $item->url,
                            'type'      => $item->object,
                            'object_id' => intval($item->object_id),
                            'parent_id' => intval($item->menu_item_parent),
                        ];
                    }
                }
                $menus_data[] = [
                    'id'    => $menu->term_id,
                    'name'  => $menu->name,
                    'slug'  => $menu->slug,
                    'items' => $menu_items,
                ];
            }

            // Custom post types
            $cpts = get_post_types(['public' => true, '_builtin' => false], 'objects');
            $cpt_list = [];
            foreach ($cpts as $cpt) {
                $cpt_list[] = ['slug' => $cpt->name, 'label' => $cpt->label];
            }

            return [
                'blogname'      => get_bloginfo('name'),
                'siteurl'       => get_bloginfo('url'),
                'front_page_id' => intval(get_option('page_on_front')),
                'blog_page_id'  => intval(get_option('page_for_posts')),
                'theme'  => [
                    'child'  => $theme->get_stylesheet(),
                    'parent' => $theme->get_template(),
                    'name'   => $theme->get('Name'),
                ],
                'plugins'           => $plugins,
                'menus'             => $menus_data,
                'custom_post_types' => $cpt_list,
            ];
        },
    ]);
});
`;

// ── Deploy the site-info endpoint to functions.php if needed ──────────────────

async function ensureSiteInfoEndpoint() {
  const { cloneRepo, readFile, editFile, commitAndDeploy, pollPipelineUntilDone, purgeCache, cleanup } = require('./wpEngineDeploy');
  const { cloneDir } = await cloneRepo();
  try {
    const currentFunctions = readFile(cloneDir, 'functions.php') || '';
    if (currentFunctions.includes(SITE_INFO_MARKER)) {
      console.log('  ✅ Site-info endpoint already deployed');
      return;
    }
    editFile(cloneDir, 'functions.php', currentFunctions.trimEnd() + '\n' + siteInfoEndpointPhp);
    const { sha, noChanges } = await commitAndDeploy(cloneDir, '[AI Agent] Add brinda-agent site-info REST endpoint');
    if (!noChanges) {
      console.log('  ⏳ Deploying site-info endpoint via Bitbucket pipeline...');
      await pollPipelineUntilDone(sha);
      await purgeCache();
      await new Promise(r => setTimeout(r, 5000)); // let WP bootstrap new code
      console.log('  ✅ Site-info endpoint deployed');
    }
  } finally {
    cleanup(cloneDir);
  }
}

// ── Main builder ──────────────────────────────────────────────────────────────

async function buildKnowledge() {
  console.log('🔍 Building site knowledge base via REST API...');

  const knowledge = {
    generated_at:    new Date().toISOString(),
    site:            {},
    pages:           [],
    posts:           [],
    menus:           [],
    plugins:         [],
    theme:           {},
    custom_post_types: [],
    elementor_pages: [],
    front_page_id:   null,
    blog_page_id:    null,
  };

  // ── Step 1: Ensure the site-info endpoint is deployed ─────────────────
  try {
    await ensureSiteInfoEndpoint();
  } catch (e) {
    console.warn(`  ⚠️ Could not deploy site-info endpoint: ${e.message}`);
  }

  // ── Step 2: Fetch site info (plugins, menus, theme, options) via custom endpoint
  try {
    const info = await restGet('/brinda-agent/v1/site-info');
    knowledge.site          = { blogname: info.blogname, siteurl: info.siteurl };
    knowledge.front_page_id = info.front_page_id || null;
    knowledge.blog_page_id  = info.blog_page_id  || null;
    knowledge.theme         = info.theme          || {};
    knowledge.menus         = info.menus          || [];
    knowledge.custom_post_types = info.custom_post_types || [];
    knowledge.plugins = (info.plugins || []).map(p => ({
      slug:    p.slug,
      title:   p.title,
      status:  p.status,
      version: p.version,
    }));
    const active = knowledge.plugins.filter(p => p.status === 'active');
    console.log(`  ✅ Site: "${knowledge.site.blogname}" | Theme: ${knowledge.theme.child}`);
    console.log(`  ✅ Plugins: ${knowledge.plugins.length} total, ${active.length} active`);
    console.log(`  ✅ Menus: ${knowledge.menus.length} (${knowledge.menus.map(m => m.name).join(', ')})`);
  } catch (e) {
    console.warn(`  ⚠️ site-info endpoint not available yet: ${e.message}`);
    // Fallback: read basic options via REST
    try {
      const settings = await restGet('/wp/v2/settings');
      knowledge.site = { blogname: settings.title, siteurl: wpBase() };
    } catch {}
  }

  // ── Step 3: All pages via REST ─────────────────────────────────────────
  try {
    const pages = await restGetAll('/wp/v2/pages', { status: 'publish,draft', _fields: 'id,title,slug,status,template,meta,link' });
    knowledge.pages = pages.map(p => ({
      id:             p.id,
      title:          p.title?.rendered || p.title?.raw || '',
      slug:           p.slug,
      status:         p.status,
      template:       p.template || 'default',
      link:           p.link,
      uses_elementor: p.meta?._elementor_edit_mode === 'builder',
      is_front_page:  p.id === knowledge.front_page_id,
    }));
    // Separately fetch Elementor pages (meta query)
    try {
      const elemPages = await restGetAll('/wp/v2/pages', {
        status:     'publish,draft',
        meta_key:   '_elementor_edit_mode',
        meta_value: 'builder',
        _fields:    'id,title,slug',
      });
      const elemIds = new Set(elemPages.map(p => p.id));
      knowledge.elementor_pages = elemPages.map(p => ({
        id: p.id, title: p.title?.rendered || '', slug: p.slug
      }));
      knowledge.pages.forEach(p => {
        if (elemIds.has(p.id)) p.uses_elementor = true;
      });
    } catch {
      // meta query may not be enabled — mark based on whatever meta came back
    }
    console.log(`  ✅ Pages: ${knowledge.pages.length} | Elementor: ${knowledge.elementor_pages.length}`);
  } catch (e) {
    console.warn(`  ⚠️ Could not fetch pages: ${e.message}`);
  }

  // ── Step 4: Recent posts via REST ──────────────────────────────────────
  try {
    const posts = await restGetAll('/wp/v2/posts', { status: 'publish', per_page: 30, _fields: 'id,title,slug,date' });
    knowledge.posts = posts.map(p => ({
      id:    p.id,
      title: p.title?.rendered || '',
      slug:  p.slug,
      date:  p.date,
    }));
    console.log(`  ✅ Posts: ${knowledge.posts.length} recent`);
  } catch (e) {
    console.warn(`  ⚠️ Could not fetch posts: ${e.message}`);
  }

  // ── Save ──────────────────────────────────────────────────────────────
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
  const activeCount = knowledge.plugins.filter(p => p.status === 'active').length;
  console.log(`\n✅ Knowledge base saved → ${KNOWLEDGE_FILE}`);
  console.log(`   Pages: ${knowledge.pages.length} | Menus: ${knowledge.menus.length} | Plugins active: ${activeCount}`);

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

// ── Focused context string for GPT ───────────────────────────────────────────

function getContextForTask(taskType, kb) {
  if (!kb) return '';
  const lines = [];

  lines.push(`## WordPress Site Knowledge Base`);
  lines.push(`Site: ${kb.site?.blogname} (${kb.site?.siteurl})`);
  lines.push(`Front page ID: ${kb.front_page_id}`);
  lines.push(`Snapshot date: ${kb.generated_at ? kb.generated_at.substring(0, 10) : 'unknown'}`);
  lines.push('');

  // Pages — always included (most useful context)
  lines.push(`### All Pages (${kb.pages?.length})`);
  (kb.pages || []).forEach(p => {
    const flags = [
      p.is_front_page  ? '🏠 FRONT PAGE' : '',
      p.uses_elementor ? '⚡ Elementor'  : '',
      p.status === 'draft' ? '📝 draft'  : '',
    ].filter(Boolean).join(' ');
    lines.push(`  • ID ${p.id}: "${p.title}" /${p.slug}/ ${flags}`);
  });
  lines.push('');

  // Menus
  if (['nav', 'content', 'elementor'].includes(taskType) && kb.menus?.length) {
    lines.push(`### Navigation Menus`);
    (kb.menus || []).forEach(m => {
      lines.push(`  Menu: "${m.name}" (ID ${m.id})`);
      (m.items || []).forEach(i => {
        lines.push(`    - "${i.title}" → ${i.url} (type: ${i.type}, page_id: ${i.object_id})`);
      });
    });
    lines.push('');
  }

  // Active plugins
  if (['plugin', 'backup', 'seo', 'elementor', 'file'].includes(taskType) && kb.plugins?.length) {
    const active = (kb.plugins || []).filter(p => p.status === 'active');
    lines.push(`### Active Plugins (${active.length})`);
    active.forEach(p => lines.push(`  • ${p.title} v${p.version} [${p.slug}]`));
    lines.push('');
  }

  // Elementor pages list (for elementor tasks)
  if (taskType === 'elementor' && kb.elementor_pages?.length) {
    lines.push(`### Elementor Pages`);
    (kb.elementor_pages || []).forEach(p => lines.push(`  • ID ${p.id}: "${p.title}" /${p.slug}/`));
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
  lines.push(`  Child: ${kb.theme?.child}  |  Parent: ${kb.theme?.parent}`);

  return lines.join('\n');
}

// ── Stale check ───────────────────────────────────────────────────────────────

function isStale(maxAgeHours = 24) {
  const kb = getKnowledge();
  if (!kb?.generated_at) return true;
  const ageHours = (Date.now() - new Date(kb.generated_at).getTime()) / 3_600_000;
  return ageHours > maxAgeHours;
}

module.exports = { buildKnowledge, getKnowledge, getContextForTask, isStale };
