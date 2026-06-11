const TASK_TYPES = {
  FILE:        'file',        // CSS, PHP, theme file edits
  CONTENT:     'content',     // Create/update posts or pages
  NAV:         'nav',         // Navigation menu changes
  SEO:         'seo',         // Yoast SEO meta updates
  PLUGIN:      'plugin',      // Plugin install/activate/deactivate
  BACKUP:      'backup',      // Plugin/core updates with backup
  ELEMENTOR:   'elementor',   // Elementor page builder edits
  WOOCOMMERCE: 'woocommerce', // WooCommerce product edits
  EVENTS:      'events',      // Tribe Events / mp-event CPT
  DONATION:    'donation',    // Give donation forms
  REVERT:      'revert'       // Revert a previous change
};

const FILE_KEYWORDS = [
  'css', 'style', 'color', 'colour', 'font', 'layout', 'background', 'padding',
  'margin', 'php', 'template', 'theme', 'design', 'spacing',
  'border', 'responsive', 'mobile', 'hero section', 'button', 'hover', 'shadow',
  'typography', 'heading style', 'heading color', 'heading font',
  'width', 'height', 'opacity', 'animation', 'transition',
  'change theme', 'edit theme', 'update theme', 'modify theme',
  'header style', 'footer style',
  // explicit CSS/PHP file markers
  'style.css', 'functions.php', 'child theme'
];

const CONTENT_KEYWORDS = [
  // Post/page creation
  'create post', 'write post', 'new post', 'blog post', 'article',
  'create page', 'new page', 'add page', 'write page',
  // Content editing
  'create content', 'publish', 'update text', 'change text', 'edit text',
  'add text', 'page content', 'update content', 'change content',
  'update the', 'change the', 'edit the', 'modify the',
  // Page-specific text fields
  'page heading', 'page title', 'heading text', 'section heading',
  'update heading', 'change heading', 'edit heading',
  // Contact info
  'address', 'phone', 'email address', 'contact info', 'page address',
  // About / specific pages
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
  // Page content edits — these pages are Elementor-built on this site
  'about us page', 'about page', 'buy classes', 'classes page',
  'home page', 'homepage', 'contact page', 'services page',
  // Content field edits that live inside Elementor widgets
  'description paragraph', 'paragraph', 'yoga description',
  'section text', 'widget text', 'text block', 'text editor',
  'update paragraph', 'edit paragraph', 'rewrite paragraph',
  'update section', 'edit section', 'update widget', 'hero text',
  'banner text', 'intro text', 'body text'
];

const WOOCOMMERCE_KEYWORDS = [
  'product', 'woocommerce', 'shop', 'store', 'price', 'pricing',
  'product description', 'product image', 'product title', 'product name',
  'add product', 'edit product', 'update product', 'product category',
  'sale price', 'regular price', 'stock', 'inventory', 'sku',
  'product page', 'shop page', 'cart', 'checkout',
];

const EVENTS_KEYWORDS = [
  'event', 'events', 'class schedule', 'schedule', 'workshop',
  'add event', 'new event', 'create event', 'update event', 'edit event',
  'tribe event', 'event date', 'event time', 'event location', 'event venue',
  'upcoming event', 'yoga event', 'retreat', 'class event',
];

const DONATION_KEYWORDS = [
  'donation', 'donate', 'give', 'giving', 'fundrais',
  'donation form', 'donation goal', 'donation amount', 'campaign',
  'charity', 'nonprofit', 'fund',
];

function detectTaskType(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (text.includes('revert')) return TASK_TYPES.REVERT;

  // Check most specific first
  if (BACKUP_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.BACKUP;

  // "update X plugin" — plugin name between "update" and "plugin" (e.g. "Update Contact Form 7 plugin")
  if (/\bupdate\b.{1,40}\bplugin\b/.test(text))          return TASK_TYPES.BACKUP;
  if (/\bupgrade\b.{1,40}\bplugin\b/.test(text))         return TASK_TYPES.BACKUP;
  if (PLUGIN_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.PLUGIN;

  // Domain-specific CPT types before generic content
  if (WOOCOMMERCE_KEYWORDS.some(k => text.includes(k)))  return TASK_TYPES.WOOCOMMERCE;
  if (EVENTS_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.EVENTS;
  if (DONATION_KEYWORDS.some(k => text.includes(k)))     return TASK_TYPES.DONATION;

  // Nav before content — "create page and add to nav" should be NAV
  if (NAV_KEYWORDS.some(k => text.includes(k)))          return TASK_TYPES.NAV;

  if (SEO_KEYWORDS.some(k => text.includes(k)))          return TASK_TYPES.SEO;

  // ELEMENTOR before CONTENT — "update heading via elementor" is Elementor, not content
  if (ELEMENTOR_KEYWORDS.some(k => text.includes(k)))    return TASK_TYPES.ELEMENTOR;

  // CONTENT before FILE — "update heading / change text on page" is content, not CSS
  if (CONTENT_KEYWORDS.some(k => text.includes(k)))      return TASK_TYPES.CONTENT;

  // FILE last among content-related types
  if (FILE_KEYWORDS.some(k => text.includes(k)))         return TASK_TYPES.FILE;

  return TASK_TYPES.CONTENT; // default
}

module.exports = { detectTaskType, TASK_TYPES, WOOCOMMERCE_KEYWORDS, EVENTS_KEYWORDS, DONATION_KEYWORDS };
