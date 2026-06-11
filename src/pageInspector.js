/**
 * pageInspector.js
 *
 * SSH-based page diagnostic tool.
 * Before making any change, the agent calls inspectPage() to understand
 * what's actually on the page — widget types, data sources, CPT bindings, etc.
 * This prevents wrong-approach failures like editing Elementor JSON when
 * the content actually lives in a CPT category.
 *
 * Returns a structured PageMap that GPT uses to choose the right approach.
 */

const { runWpCli } = require('./wpCli');

// ── CPT shortcode → WP post_type mapping ─────────────────────────────────────
const CPT_WIDGET_MAP = {
  trx_sc_services:  'cpt_services',
  trx_sc_courses:   'cpt_courses',
  trx_sc_team:      'cpt_team',
  trx_sc_portfolio: 'cpt_portfolio',
  trx_sc_price:     'cpt_price',
};

// ── Parse Elementor JSON via WP CLI ──────────────────────────────────────────
async function getElementorJson(postId) {
  try {
    const raw = await runWpCli(`post meta get ${postId} _elementor_data`);
    if (!raw || raw.trim() === '') return null;
    return JSON.parse(raw.trim());
  } catch (e) {
    console.warn(`⚠️ Could not read Elementor JSON for post ${postId}: ${e.message}`);
    return null;
  }
}

// ── Recursively map every widget in the page ──────────────────────────────────
function mapWidgets(elements, results = [], depth = 0) {
  for (const el of (elements || [])) {
    if (el.elType === 'widget') {
      const s = el.settings || {};
      const entry = {
        elId:       el.id,
        widgetType: el.widgetType,
        depth,
        settings:   s,
        dataSource: 'elementor_json', // default — overridden below
      };

      // Detect CPT-backed shortcodes (data lives in WP posts, not Elementor JSON)
      if (CPT_WIDGET_MAP[el.widgetType]) {
        entry.dataSource = 'cpt';
        entry.cptType    = CPT_WIDGET_MAP[el.widgetType];
        entry.catId      = s.cat || s.category || null;
        entry.ids        = s.ids  || null;
      }

      // Detect shortcode widgets (PHP-rendered, non-editable via JSON)
      if (el.widgetType === 'shortcode') {
        entry.dataSource = 'shortcode';
        entry.shortcode  = s.shortcode || '';
      }

      // Extract readable text preview for standard text widgets
      const TEXT_FIELDS = ['title', 'editor', 'text', 'description', 'caption', 'subtitle', 'content'];
      for (const f of TEXT_FIELDS) {
        if (s[f]) {
          entry.textField   = f;
          entry.textPreview = String(s[f]).replace(/<[^>]+>/g, '').substring(0, 100);
          break;
        }
      }

      // Detect items-array widgets (ThemeREX repeaters)
      if (Array.isArray(s.items) && s.items.length > 0) {
        entry.dataSource = 'elementor_items';
        entry.itemCount  = s.items.length;
        entry.itemFields = s.items.map((item, i) => ({
          index:   i,
          preview: Object.entries(item)
            .filter(([, v]) => v && typeof v === 'string' && v.length > 0 && v.length < 200)
            .slice(0, 3)
            .map(([k, v]) => `${k}=${v.substring(0, 60)}`)
            .join(', ')
        }));
      }

      results.push(entry);
    }
    mapWidgets(el.elements, results, depth + 1);
  }
  return results;
}

// ── Fetch CPT posts for a category ───────────────────────────────────────────
async function getCptPostsInCategory(cptType, catId) {
  try {
    // Find the taxonomy for this CPT (usually cptType + '_group')
    const taxSlug = `${cptType}_group`;
    const out = await runWpCli(
      `post list --post_type=${cptType} --tax_query[0][taxonomy]=${taxSlug} --tax_query[0][terms]=${catId} --fields=ID,post_title,post_status --format=json`
    );
    return JSON.parse(out || '[]').map(p => ({
      id:     parseInt(p.ID),
      title:  p.post_title,
      status: p.post_status,
    }));
  } catch {
    // Fallback: list all posts of this type
    try {
      const out = await runWpCli(`post list --post_type=${cptType} --fields=ID,post_title,post_status --format=json`);
      return JSON.parse(out || '[]').map(p => ({
        id:     parseInt(p.ID),
        title:  p.post_title,
        status: p.post_status,
      }));
    } catch {
      return [];
    }
  }
}

// ── Main inspector ────────────────────────────────────────────────────────────

/**
 * Inspect a page and return a structured PageMap.
 *
 * PageMap shape:
 * {
 *   postId: number,
 *   usesElementor: boolean,
 *   widgets: [
 *     {
 *       elId, widgetType, depth, dataSource,
 *       // if dataSource === 'cpt':
 *       cptType, catId, existingPosts: [{id, title}]
 *       // if dataSource === 'elementor_json':
 *       textField, textPreview
 *       // if dataSource === 'elementor_items':
 *       itemCount, itemFields
 *     }
 *   ]
 * }
 */
async function inspectPage(postId) {
  console.log(`🔬 Inspecting page ${postId} via SSH...`);

  const data = await getElementorJson(postId);
  if (!data) {
    console.log(`  ℹ️  Page ${postId} has no Elementor data`);
    return { postId, usesElementor: false, widgets: [] };
  }

  const widgets = mapWidgets(data);
  console.log(`  📊 Found ${widgets.length} widgets (${[...new Set(widgets.map(w => w.widgetType))].join(', ')})`);

  // Enrich CPT widgets with their actual post lists
  for (const w of widgets) {
    if (w.dataSource === 'cpt' && w.cptType) {
      w.existingPosts = await getCptPostsInCategory(w.cptType, w.catId);
      console.log(`  📋 ${w.widgetType} (cat ${w.catId}): ${w.existingPosts.length} posts — ${w.existingPosts.map(p => `"${p.title}"`).join(', ')}`);
    }
  }

  return { postId, usesElementor: true, widgets };
}

// ── Format PageMap for GPT system prompt ──────────────────────────────────────

function formatPageMapForGpt(pageMap) {
  if (!pageMap?.usesElementor) return 'Page does not use Elementor.';

  const lines = [`## Page Structure (ID: ${pageMap.postId}) — ${pageMap.widgets.length} widgets`];

  for (const w of pageMap.widgets) {
    let line = `• [${w.widgetType}] source=${w.dataSource}`;

    if (w.dataSource === 'cpt') {
      line += ` | CPT: ${w.cptType} | category: ${w.catId}`;
      if (w.existingPosts?.length) {
        line += ` | ${w.existingPosts.length} posts: ${w.existingPosts.map(p => `"${p.title}"(${p.id})`).join(', ')}`;
      }
      line += `\n  → To ADD a card: create a new ${w.cptType} post in category ${w.catId}`;
      line += `\n  → To EDIT a card: update the ${w.cptType} post directly`;
    } else if (w.dataSource === 'elementor_items') {
      line += ` | ${w.itemCount} items`;
      if (w.itemFields?.length) {
        line += ` | items: ${w.itemFields.map(i => `[${i.index}] ${i.preview}`).join(' / ')}`;
      }
      line += `\n  → To EDIT: update settings.items[N] field in Elementor JSON`;
      line += `\n  → To ADD: push new item object to settings.items array`;
    } else if (w.dataSource === 'elementor_json' && w.textPreview) {
      line += ` | field=${w.textField} | "${w.textPreview}"`;
      line += `\n  → To EDIT: update settings.${w.textField} in Elementor JSON`;
    } else if (w.dataSource === 'shortcode') {
      line += ` | shortcode: ${w.shortcode.substring(0, 60)}`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

module.exports = { inspectPage, formatPageMapForGpt, getCptPostsInCategory };
