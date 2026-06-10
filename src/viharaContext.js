/**
 * viharaContext.js
 *
 * Fetches key Vihara parent theme CSS files at runtime and extracts
 * only the rules relevant to the current task. This gives the AI
 * accurate, live knowledge of what the parent theme already defines
 * — without sending megabytes of CSS to OpenAI.
 */

const axios = require('axios');

const WP_BASE = process.env.WP_STAGING_URL || 'https://brindayogacstg.wpenginepowered.com';

// The parent theme CSS files we care about (all publicly accessible)
const PARENT_CSS_URLS = [
  `${WP_BASE}/wp-content/themes/vihara/css/__colors_default.css`,
  `${WP_BASE}/wp-content/themes/vihara/css/__custom.css`,
];

// Keywords → which CSS rules to extract for each task type
const TASK_KEYWORDS = {
  button:     ['sc_button', 'btn', 'button', 'submit'],
  font:       ['font-family', 'font-size', 'font-weight', 'typography', 'heading', 'h1', 'h2', 'h3', 'body'],
  color:      ['color', 'background', 'background-color', 'border-color'],
  header:     ['top_panel', 'sc_layouts_row', 'header', 'nav', 'menu', 'stuck'],
  footer:     ['footer', 'footer_wrap'],
  spacing:    ['padding', 'margin'],
  shadow:     ['box-shadow', 'text-shadow'],
};

/**
 * Fetch a CSS file and return its text, or empty string on failure.
 */
async function fetchCss(url) {
  try {
    const res = await axios.get(url, { timeout: 5000 });
    return res.data || '';
  } catch (e) {
    console.warn(`⚠️  Could not fetch CSS from ${url}: ${e.message}`);
    return '';
  }
}

/**
 * Extract CSS rules (blocks) from raw CSS text that contain any of the given keywords.
 * Returns a deduplicated, trimmed snippet capped at maxChars.
 */
function extractRelevantRules(cssText, keywords, maxChars = 4000) {
  if (!cssText) return '';

  // Split on rule blocks: find { ... } chunks with their selectors
  // Simple approach: split on closing brace and recombine
  const lines = cssText.split('\n');
  const relevant = [];
  let currentBlock = [];
  let insideBlock = false;
  let depth = 0;

  for (const line of lines) {
    const openCount  = (line.match(/{/g) || []).length;
    const closeCount = (line.match(/}/g) || []).length;

    currentBlock.push(line);
    depth += openCount - closeCount;

    if (depth === 0 && currentBlock.length > 0) {
      const block = currentBlock.join('\n');
      const blockLower = block.toLowerCase();

      // Keep this block if any keyword matches
      if (keywords.some(kw => blockLower.includes(kw.toLowerCase()))) {
        relevant.push(block.trim());
      }
      currentBlock = [];
    }
  }

  // Cap total size
  let result = relevant.join('\n\n');
  if (result.length > maxChars) {
    result = result.substring(0, maxChars) + '\n\n/* ... truncated ... */';
  }
  return result;
}

/**
 * Determine which keywords to search for based on the task title + description.
 */
function getSearchKeywords(taskText) {
  const text = taskText.toLowerCase();
  const keywords = new Set();

  // Always include color since most CSS tasks involve colors
  keywords.add('color');

  if (/button|btn|cta/.test(text))                   TASK_KEYWORDS.button.forEach(k  => keywords.add(k));
  if (/font|typeface|typography|heading|text/.test(text))  TASK_KEYWORDS.font.forEach(k => keywords.add(k));
  if (/color|colour|background|bg/.test(text))       TASK_KEYWORDS.color.forEach(k   => keywords.add(k));
  if (/header|nav|menu|sticky/.test(text))           TASK_KEYWORDS.header.forEach(k  => keywords.add(k));
  if (/footer/.test(text))                           TASK_KEYWORDS.footer.forEach(k  => keywords.add(k));
  if (/spacing|padding|margin|gap/.test(text))       TASK_KEYWORDS.spacing.forEach(k => keywords.add(k));
  if (/shadow/.test(text))                           TASK_KEYWORDS.shadow.forEach(k  => keywords.add(k));

  return [...keywords];
}

/**
 * Main export: fetch parent theme CSS and return a compact relevant snippet
 * suitable for inclusion in the OpenAI prompt.
 *
 * @param {string} taskTitle
 * @param {string} taskDescription
 * @returns {Promise<string>} CSS snippet string (empty if all fetches fail)
 */
async function getParentThemeContext(taskTitle, taskDescription) {
  const taskText = `${taskTitle} ${taskDescription}`;
  const keywords = getSearchKeywords(taskText);

  console.log(`🎨 Fetching parent theme CSS context (keywords: ${keywords.slice(0, 5).join(', ')}...)`);

  // Fetch all CSS files in parallel
  const cssTexts = await Promise.all(PARENT_CSS_URLS.map(fetchCss));

  // Extract relevant rules from each file
  const snippets = cssTexts
    .map((css, i) => {
      const snippet = extractRelevantRules(css, keywords, 3000);
      if (snippet) {
        const filename = PARENT_CSS_URLS[i].split('/').pop();
        return `/* === ${filename} (relevant rules) === */\n${snippet}`;
      }
      return '';
    })
    .filter(Boolean);

  if (snippets.length === 0) {
    console.warn('⚠️  No relevant parent theme CSS found (or all fetches failed)');
    return '';
  }

  const result = snippets.join('\n\n');
  console.log(`✅ Parent theme context: ${result.length} chars extracted`);
  return result;
}

module.exports = { getParentThemeContext };
