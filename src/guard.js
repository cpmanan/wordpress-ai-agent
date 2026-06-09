const CHILD_THEME = process.env.CHILD_THEME_NAME || 'vihara-child';

const ALLOWLIST = [
  `wp-content/themes/${CHILD_THEME}/`
];

const BLOCKLIST = [
  'wp-admin/',
  'wp-includes/',
  'wp-content/plugins/',
  'wp-content/themes/vihara/',   // parent theme — never touch
  'wp-config.php',
  'wp-settings.php',
  'wp-load.php'
];

// Validate a file path before any write operation
function validatePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');

  // Must be inside the child theme
  const allowed = ALLOWLIST.some(p => normalized.startsWith(p));
  if (!allowed) {
    throw new Error(`BLOCKED: "${filePath}" is outside the allowed child theme directory.`);
  }

  // Must not match any blocklist entry
  const blocked = BLOCKLIST.some(p => normalized.includes(p));
  if (blocked) {
    throw new Error(`BLOCKED: "${filePath}" matches a protected path.`);
  }

  return true;
}

module.exports = { validatePath };
