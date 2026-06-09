// Detect what type of task a Jira issue is, based on its title/description

const TASK_TYPES = {
  FILE: 'file',         // CSS, PHP, theme file edits
  CONTENT: 'content',  // Create/update posts or pages
  SEO: 'seo',          // Yoast SEO meta updates
  NAV: 'nav',          // Navigation menu changes
  ELEMENTOR: 'elementor', // Elementor page builder edits
  PLUGIN: 'plugin',    // Plugin install/update/deactivate
  BACKUP: 'backup',    // Plugin/core updates with backup
  REVERT: 'revert'     // Revert a previous change
};

const FILE_KEYWORDS = [
  'css', 'style', 'color', 'font', 'layout', 'background', 'padding', 'margin',
  'php', 'template', 'header', 'footer', 'theme', 'design', 'spacing', 'border',
  'responsive', 'mobile', 'hero', 'section', 'button', 'hover'
];

const CONTENT_KEYWORDS = [
  'create post', 'write post', 'new post', 'blog post',
  'create page', 'new page', 'add page', 'write page',
  'create content', 'publish'
];

const SEO_KEYWORDS = [
  'seo', 'meta title', 'meta description', 'focus keyword',
  'yoast', 'search engine', 'meta tag'
];

const NAV_KEYWORDS = [
  'navigation', 'nav menu', 'menu item', 'add to menu',
  'main menu', 'header menu'
];

const ELEMENTOR_KEYWORDS = [
  'elementor', 'page builder', 'section', 'widget',
  'contact form', 'testimonial', 'gallery', 'slider'
];

const PLUGIN_KEYWORDS = [
  'install plugin', 'activate plugin', 'deactivate plugin',
  'plugin', 'extension', 'add plugin'
];

const BACKUP_KEYWORDS = [
  'update plugin', 'update wordpress', 'update core',
  'wordpress update', 'plugin update', 'upgrade'
];

function detectTaskType(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (text.includes('revert')) return TASK_TYPES.REVERT;
  if (BACKUP_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.BACKUP;
  if (PLUGIN_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.PLUGIN;
  if (ELEMENTOR_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.ELEMENTOR;
  if (NAV_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.NAV;
  if (SEO_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.SEO;
  if (CONTENT_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.CONTENT;
  if (FILE_KEYWORDS.some(k => text.includes(k))) return TASK_TYPES.FILE;

  return TASK_TYPES.CONTENT; // default fallback
}

module.exports = { detectTaskType, TASK_TYPES };
