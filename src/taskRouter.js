const TASK_TYPES = {
  FILE:      'file',       // CSS, PHP, theme file edits
  CONTENT:   'content',    // Create/update posts or pages
  NAV:       'nav',        // Navigation menu changes
  SEO:       'seo',        // Yoast SEO meta updates
  PLUGIN:    'plugin',     // Plugin install/activate/deactivate
  BACKUP:    'backup',     // Plugin/core updates with backup
  ELEMENTOR: 'elementor',  // Elementor page builder edits
  REVERT:    'revert'      // Revert a previous change
};

const FILE_KEYWORDS = [
  'css', 'style', 'color', 'colour', 'font', 'layout', 'background', 'padding',
  'margin', 'php', 'template', 'header', 'footer', 'theme', 'design', 'spacing',
  'border', 'responsive', 'mobile', 'hero section', 'button', 'hover', 'shadow',
  'typography', 'heading', 'width', 'height', 'opacity', 'animation', 'transition',
  'change theme', 'edit theme', 'update theme', 'modify theme'
];

const CONTENT_KEYWORDS = [
  'create post', 'write post', 'new post', 'blog post', 'create page', 'new page',
  'add page', 'write page', 'create content', 'publish', 'address', 'phone',
  'email address', 'contact info', 'update text', 'change text', 'edit text',
  'add text', 'page content', 'update content', 'change content', 'page address',
  'update the', 'change the', 'edit the', 'modify the'
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
  'plugin update', 'upgrade plugin', 'upgrade wordpress'
];

const ELEMENTOR_KEYWORDS = [
  'elementor', 'page builder', 'contact form section', 'testimonial section',
  'gallery section', 'slider section', 'add section', 'add widget',
  'add block', 'page layout', 'build page'
];

function detectTaskType(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (text.includes('revert')) return TASK_TYPES.REVERT;

  // Check most specific first
  if (BACKUP_KEYWORDS.some(k => text.includes(k)))    return TASK_TYPES.BACKUP;
  if (PLUGIN_KEYWORDS.some(k => text.includes(k)))    return TASK_TYPES.PLUGIN;

  // FILE takes priority over ELEMENTOR — CSS/PHP tasks that mention elementor
  // selectors (e.g. ".elementor-button") should still be FILE tasks
  if (FILE_KEYWORDS.some(k => text.includes(k)))      return TASK_TYPES.FILE;

  // Only route to ELEMENTOR if no FILE keywords matched
  if (ELEMENTOR_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.ELEMENTOR;

  // Nav before content — "create page and add to nav" should be NAV
  if (NAV_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.NAV;

  if (SEO_KEYWORDS.some(k => text.includes(k)))       return TASK_TYPES.SEO;
  if (CONTENT_KEYWORDS.some(k => text.includes(k)))   return TASK_TYPES.CONTENT;

  return TASK_TYPES.CONTENT; // default
}

module.exports = { detectTaskType, TASK_TYPES };
