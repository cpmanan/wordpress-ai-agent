/**
 * agentMemory.js
 *
 * Persistent learning memory for the WordPress AI Agent.
 * Records outcomes, page mappings, widget quirks, and site-specific knowledge
 * so the agent improves over time without repeating the same mistakes.
 *
 * Storage: agent-memory.json (committed to repo so it persists across deploys)
 */

const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'agent-memory.json');

// ── Default structure ─────────────────────────────────────────────────────────
function emptyMemory() {
  return {
    version:        1,
    last_updated:   new Date().toISOString(),

    // Confirmed page ID → title mappings (avoids re-matching every time)
    page_mappings: {},
    // e.g. { "about us": { id: 193, title: "About Us", slug: "about-us", confirmed_by: "BRIN-56" } }

    // Widget-level learnings (field names, defaults, quirks)
    widget_learnings: [],
    // e.g. { widget_type, field_name, note, learned_from, date }

    // Taxonomy / CPT mappings confirmed on this site
    taxonomy_learnings: [],
    // e.g. { post_type, taxonomy, learned_from }

    // Task outcome history (last 50)
    task_outcomes: [],
    // e.g. { issue, title, type, outcome, page_id, widget_type, note, date }

    // Free-form site quirks discovered by the agent
    site_quirks: [],
    // e.g. { note, learned_from, date }
  };
}

// ── Load / Save ───────────────────────────────────────────────────────────────
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return emptyMemory();
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return emptyMemory();
  }
}

function saveMemory(mem) {
  mem.last_updated = new Date().toISOString();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
}

// ── Record confirmed page match ────────────────────────────────────────────────
function rememberPage(taskKeywords, pageId, pageTitle, pageSlug, issueKey) {
  const mem = loadMemory();
  const key = taskKeywords.toLowerCase().trim();
  mem.page_mappings[key] = {
    id:           pageId,
    title:        pageTitle,
    slug:         pageSlug,
    confirmed_by: issueKey,
    date:         new Date().toISOString(),
  };
  saveMemory(mem);
  console.log(`🧠 Remembered page mapping: "${key}" → "${pageTitle}" (ID: ${pageId})`);
}

// ── Record widget learning ─────────────────────────────────────────────────────
function rememberWidgetLearning(widgetType, fieldName, note, issueKey) {
  const mem = loadMemory();
  // Update existing or add new
  const existing = mem.widget_learnings.find(w => w.widget_type === widgetType && w.field_name === fieldName);
  if (existing) {
    existing.note         = note;
    existing.confirmed_by = issueKey;
    existing.date         = new Date().toISOString();
  } else {
    mem.widget_learnings.push({
      widget_type:  widgetType,
      field_name:   fieldName,
      note,
      learned_from: issueKey,
      date:         new Date().toISOString(),
    });
  }
  saveMemory(mem);
  console.log(`🧠 Remembered widget learning: ${widgetType}.${fieldName} — ${note}`);
}

// ── Record site quirk ─────────────────────────────────────────────────────────
function rememberQuirk(note, issueKey) {
  const mem = loadMemory();
  if (!mem.site_quirks.find(q => q.note === note)) {
    mem.site_quirks.push({ note, learned_from: issueKey, date: new Date().toISOString() });
    saveMemory(mem);
    console.log(`🧠 Remembered site quirk: ${note}`);
  }
}

// ── Record task outcome ────────────────────────────────────────────────────────
function recordOutcome(issueKey, title, taskType, outcome, details = {}) {
  const mem = loadMemory();
  mem.task_outcomes.unshift({
    issue:       issueKey,
    title,
    type:        taskType,
    outcome,     // 'success' | 'failed' | 'clarification_needed'
    page_id:     details.pageId,
    widget_type: details.widgetType,
    widget_index: details.widgetIndex,
    note:        details.note,
    date:        new Date().toISOString(),
  });
  // Keep last 50 outcomes
  mem.task_outcomes = mem.task_outcomes.slice(0, 50);
  saveMemory(mem);
}

// ── Look up a remembered page for a task ─────────────────────────────────────
function recallPage(taskText) {
  const mem = loadMemory();
  const lower = taskText.toLowerCase();
  // Try to find a mapping where the key words appear in the task
  for (const [key, val] of Object.entries(mem.page_mappings)) {
    const keyWords = key.split(/\W+/).filter(w => w.length > 2);
    if (keyWords.every(w => lower.includes(w))) {
      return val; // { id, title, slug, confirmed_by }
    }
  }
  return null;
}

// ── Build memory context string for GPT ───────────────────────────────────────
function getMemoryContext() {
  const mem = loadMemory();
  const lines = ['## Agent Memory (Learned from Past Tasks)'];

  if (Object.keys(mem.page_mappings).length) {
    lines.push('\n### Confirmed Page Mappings');
    for (const [key, val] of Object.entries(mem.page_mappings)) {
      lines.push(`  • "${key}" → "${val.title}" (ID: ${val.id}, /${val.slug}/)`);
    }
  }

  if (mem.widget_learnings.length) {
    lines.push('\n### Widget Field Learnings');
    mem.widget_learnings.forEach(w => {
      lines.push(`  • ${w.widget_type}.${w.field_name}: ${w.note}`);
    });
  }

  if (mem.site_quirks.length) {
    lines.push('\n### Site-Specific Quirks');
    mem.site_quirks.forEach(q => lines.push(`  • ${q.note}`));
  }

  if (mem.task_outcomes.length) {
    lines.push('\n### Recent Task Outcomes (last 10)');
    mem.task_outcomes.slice(0, 10).forEach(t => {
      lines.push(`  • ${t.outcome === 'success' ? '✅' : '❌'} ${t.issue}: "${t.title}" → ${t.outcome}${t.note ? ` (${t.note})` : ''}`);
    });
  }

  return lines.join('\n');
}

module.exports = {
  loadMemory,
  rememberPage,
  rememberWidgetLearning,
  rememberQuirk,
  recordOutcome,
  recallPage,
  getMemoryContext,
};
