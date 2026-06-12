const TASK_TYPES = {
  FILE:        'file',        // CSS, PHP, theme file edits
  CONTENT:     'content',     // Create/update posts or pages
  NAV:         'nav',         // Navigation menu changes
  SEO:         'seo',         // Yoast SEO meta updates
  PLUGIN:      'plugin',      // Plugin install/activate/deactivate
  BACKUP:      'backup',      // Plugin/core updates with backup
  ELEMENTOR:   'elementor',   // Elementor page builder edits
  WOOCOMMERCE: 'woocommerce', // WooCommerce product edits
  REVERT:      'revert'       // Revert a previous change
};

// ── Type descriptions fed to GPT for AI classification ───────────────────────
const TYPE_DESCRIPTIONS = {
  file:        'CSS styling, font changes, color changes, PHP/theme file edits, child theme, style.css, functions.php, responsive/layout changes',
  content:     'Create or update WordPress posts or pages — blog articles, blog creation, write a blog post, text content on a page, phone number, address, contact info. Use this for any task that asks to write or create a new blog.',
  nav:         'Navigation menu changes — add, remove, or reorder menu items or links',
  seo:         'Yoast SEO meta title, meta description, focus keyword, search engine optimization',
  elementor:   'Elementor page builder edits — headings, hero text, sections, widgets, gallery images on pages built with Elementor',
  plugin:      'Install, activate, or deactivate a WordPress plugin',
  backup:      'Update a WordPress plugin or core to a newer version (always needs a backup checkpoint first)',
  woocommerce: 'WooCommerce product edits — price, description, short description, image, stock for a specific product',
  revert:      'Undo or revert a previous change that the agent made',
};

// ── Keyword fallback (used when AI classification is unavailable) ─────────────

const FILE_KEYWORDS = [
  'css', 'style', 'color', 'colour', 'font', 'layout', 'background', 'padding',
  'margin', 'php', 'template', 'theme', 'design', 'spacing',
  'border', 'responsive', 'mobile', 'hero section', 'button', 'hover', 'shadow',
  'typography', 'heading style', 'heading color', 'heading font',
  'width', 'height', 'opacity', 'animation', 'transition',
  'change theme', 'edit theme', 'update theme', 'modify theme',
  'header style', 'footer style',
  'style.css', 'functions.php', 'child theme'
];

const CONTENT_KEYWORDS = [
  'create post', 'write post', 'new post', 'blog post', 'article',
  'create page', 'new page', 'add page', 'write page',
  'create content', 'publish', 'update text', 'change text', 'edit text',
  'add text', 'page content', 'update content', 'change content',
  'update the', 'change the', 'edit the', 'modify the',
  'page heading', 'page title', 'heading text', 'section heading',
  'update heading', 'change heading', 'edit heading',
  'address', 'phone', 'email address', 'contact info', 'page address',
  'about us', 'about page', 'contact page', 'services page', 'home page content'
];

const NAV_KEYWORDS = [
  'navigation', 'nav menu', 'menu item', 'add to menu', 'add to navigation',
  'add to nav', 'main menu', 'header menu', 'add link', 'add page to menu',
  'add to header', 'menu link', 'create page and add', 'add in menu',
  'add in navigation', 'show in menu', 'include in nav'
];

const SEO_KEYWORDS = [
  'seo', 'meta title', 'meta description', 'focus keyword', 'yoast',
  'search engine', 'meta tag', 'seo title', 'seo description', 'keyword'
];

const PLUGIN_KEYWORDS = [
  'install plugin', 'activate plugin', 'deactivate plugin', 'install and activate',
  'add plugin', 'remove plugin', 'disable plugin', 'enable plugin',
  'plugin install', 'plugin activate', 'plugin deactivate'
];

const BACKUP_KEYWORDS = [
  'update plugin', 'update wordpress', 'update core', 'wordpress update',
  'plugin update', 'upgrade plugin', 'upgrade wordpress',
  'with auto-backup', 'with backup',
];

const ELEMENTOR_KEYWORDS = [
  'elementor', 'page builder', 'contact form section', 'testimonial section',
  'gallery section', 'slider section', 'add section', 'add widget',
  'gallery', 'photo gallery', 'add photo', 'add photos', 'add image', 'add images',
  'add more photo', 'add more image', 'add picture', 'add pictures',
  'add block', 'page layout', 'build page',
  'about us page', 'about page', 'buy classes', 'classes page',
  'home page', 'homepage', 'contact page', 'services page',
  'description paragraph', 'yoga description',
  'section text', 'widget text', 'text block', 'text editor',
  'update paragraph', 'edit paragraph', 'rewrite paragraph',
  'update section', 'edit section', 'update widget', 'hero text',
  'banner text', 'intro text', 'body text'
];

const WOOCOMMERCE_KEYWORDS = [
  'product', 'woocommerce', 'price', 'pricing',
  'product description', 'product image', 'product title', 'product name',
  'add product', 'edit product', 'update product', 'product category',
  'sale price', 'regular price', 'stock', 'inventory', 'sku',
  'product page', 'cart', 'checkout',
];

// ── Keyword-only fallback detection ──────────────────────────────────────────
function detectTaskType(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (text.includes('revert')) return TASK_TYPES.REVERT;

  if (BACKUP_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.BACKUP;
  if (/\bupdate\b.{1,40}\bplugin\b/.test(text))          return TASK_TYPES.BACKUP;
  if (/\bupgrade\b.{1,40}\bplugin\b/.test(text))         return TASK_TYPES.BACKUP;

  if (/\b(install|activate|deactivate|disable|enable|remove)\b.{0,40}\bplugin\b/.test(text)) return TASK_TYPES.PLUGIN;
  if (PLUGIN_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.PLUGIN;

  if (NAV_KEYWORDS.some(k => text.includes(k)))          return TASK_TYPES.NAV;
  if (SEO_KEYWORDS.some(k => text.includes(k)))          return TASK_TYPES.SEO;
  if (WOOCOMMERCE_KEYWORDS.some(k => text.includes(k)))  return TASK_TYPES.WOOCOMMERCE;

  const BLOG_POST_SIGNALS = [
    'blog post', 'write post', 'new post', 'create post', 'write a post',
    'write blog', 'new blog', 'blog creation', 'create a blog', 'create one blog',
    'create blog', 'write the blog', 'publish blog', 'publish a blog',
  ];
  if (BLOG_POST_SIGNALS.some(k => text.includes(k)))     return TASK_TYPES.CONTENT;
  // catch bare "blog" only when paired with create/write/publish intent
  if (/\b(create|write|publish|add|make)\b.{0,20}\bblog\b/.test(text)) return TASK_TYPES.CONTENT;

  const STRONG_FILE_SIGNALS = ['style.css', 'functions.php', 'child theme', 'font-family', 'css file', '.css', 'php file'];
  if (STRONG_FILE_SIGNALS.some(k => text.includes(k)))   return TASK_TYPES.FILE;

  if (ELEMENTOR_KEYWORDS.some(k => text.includes(k)))    return TASK_TYPES.ELEMENTOR;
  if (CONTENT_KEYWORDS.some(k => text.includes(k)))      return TASK_TYPES.CONTENT;
  if (FILE_KEYWORDS.some(k => text.includes(k)))         return TASK_TYPES.FILE;

  return TASK_TYPES.CONTENT;
}

// ── AI-powered task type detection ───────────────────────────────────────────
// Uses GPT-4o-mini to understand intent from natural language.
// Falls back to keyword matching if AI is unavailable or returns unknown type.
async function detectTaskTypeWithAI(title, description = '', openai) {
  const validTypes = Object.values(TASK_TYPES);

  // Fast-path: revert is always unambiguous
  if (`${title} ${description}`.toLowerCase().includes('revert')) {
    return TASK_TYPES.REVERT;
  }

  if (!openai) {
    console.log(`🔍 No OpenAI client — using keyword detection`);
    return detectTaskType(title, description);
  }

  try {
    const typeList = Object.entries(TYPE_DESCRIPTIONS)
      .map(([type, desc]) => `- ${type}: ${desc}`)
      .join('\n');

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a task classifier for a WordPress AI agent managing a yoga studio website (Brinda Yoga).

Classify the task into exactly one of these types:
${typeList}

Return JSON only: { "type": "<type>", "confidence": 0.0-1.0, "reason": "one sentence" }`
        },
        {
          role: 'user',
          content: `Task title: ${title}\nDescription: ${description || 'none'}`
        }
      ],
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(res.choices[0].message.content);

    if (validTypes.includes(result.type)) {
      console.log(`🤖 AI task type: "${result.type}" (confidence: ${result.confidence}) — ${result.reason}`);
      return result.type;
    }

    console.warn(`⚠️ AI returned unknown type "${result.type}" — falling back to keywords`);
  } catch (err) {
    console.warn(`⚠️ AI task detection failed: ${err.message} — falling back to keywords`);
  }

  return detectTaskType(title, description);
}

module.exports = { detectTaskType, detectTaskTypeWithAI, TASK_TYPES, WOOCOMMERCE_KEYWORDS };
