#!/usr/bin/env node
// Where a project's Claude Code tokens went, from its session transcripts. For the setup review.
// Read-only, no dependencies, no model calls.
//
//   node tools/spend-view.mjs [--project <folder>] [--since YYYY-MM-DD] [--session <id prefix>]
//                             [--transcripts <folder>]
//
// Rules:
// - Counts only. No file path, command or message text is printed; an agent's description gives
//   only its task slug, and only when it starts `<slug>: `.
// - Tokens are weighted by their rough price against plain input (WEIGHTS), with no difference
//   between models, so this shows the shape of the spend and is not a bill.
// - A transcript holds one message over several lines. Each usage field is the largest seen for
//   that message id.
// - The pools can overlap (a polling turn can also be a cache miss), so they are not added up.
// - Unknown stays unknown: no transcript folder prints that, never zero spend.
// - `--since` is a UTC date, which is close enough for a monthly review.
// - Misses print apart for the main session and agents: a main session's idle gap is mostly the
//   owner being away, which builder rules cannot shrink.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
// A turn counts as a cache miss when over half of a context this large was written again.
export const MISS_MIN_CONTEXT = 40_000;
// Subagents' default cache lifetime, so a longer wait usually means the next turn is a miss.
export const IDLE_MS = 5 * 60_000;
// Matches `autoCompactWindow` in the builders' frontmatter.
export const CONTEXT_LIMIT = 200_000;

// At a command's start only, so `grep sleep notes.txt` is not polling.
const POLL =
  /(^|[;&|(\n]\s*|\b(?:do|then|timeout\s+\S+)\s+)(?:sleep\s|pgrep\s|tail\s+(?:\S+\s+)*?-[a-zA-Z]*f\b)/;

const newMessage = (id) => ({
  id,
  firstAt: null,
  lastAt: null,
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  polls: false,
  edits: false,
});

// Messages in file order. `skipped` counts lines that are not JSON.
export function parseTranscript(text) {
  const byId = new Map();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const message = row?.message;
    if (row?.type !== 'assistant' || !message?.id) continue;
    let m = byId.get(message.id);
    if (!m) {
      m = newMessage(message.id);
      byId.set(message.id, m);
    }
    const at = Date.parse(row.timestamp);
    if (!Number.isNaN(at)) {
      m.firstAt = m.firstAt === null ? at : Math.min(m.firstAt, at);
      m.lastAt = m.lastAt === null ? at : Math.max(m.lastAt, at);
    }
    const u = message.usage ?? {};
    m.input = Math.max(m.input, u.input_tokens ?? 0);
    m.cacheWrite = Math.max(m.cacheWrite, u.cache_creation_input_tokens ?? 0);
    m.cacheRead = Math.max(m.cacheRead, u.cache_read_input_tokens ?? 0);
    m.output = Math.max(m.output, u.output_tokens ?? 0);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use') continue;
      if (block.name === 'Edit' || block.name === 'Write') m.edits = true;
      if (block.name === 'Bash' && POLL.test(block.input?.command ?? '')) m.polls = true;
    }
  }
  return { messages: [...byId.values()], skipped };
}

export const weigh = (m) =>
  m.input * WEIGHTS.input +
  m.cacheWrite * WEIGHTS.cacheWrite +
  m.cacheRead * WEIGHTS.cacheRead +
  m.output * WEIGHTS.output;

const contextOf = (m) => m.input + m.cacheWrite + m.cacheRead;

export const emptyTotals = () => ({
  turns: 0,
  weighted: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  activeMs: 0,
  peak: 0,
  misses: 0,
  missWeighted: 0,
  idleMisses: 0,
  idleMissWeighted: 0,
  polls: 0,
  pollWeighted: 0,
  preEdit: 0,
  overLimitTurns: 0,
  overLimitWeighted: 0,
});

// Adds one transcript's messages, in order. `isBuilder` turns on the before-first-edit pool.
export function addMessages(t, messages, isBuilder) {
  let previous = null;
  let edited = false;
  for (const m of messages) {
    const weighted = weigh(m);
    const context = contextOf(m);
    t.turns += 1;
    t.weighted += weighted;
    t.cacheWrite += m.cacheWrite * WEIGHTS.cacheWrite;
    t.cacheRead += m.cacheRead * WEIGHTS.cacheRead;
    t.output += m.output * WEIGHTS.output;
    t.peak = Math.max(t.peak, context);
    const gap =
      previous?.lastAt != null && m.firstAt != null ? m.firstAt - previous.lastAt : null;
    if (gap !== null && gap > 0 && gap < IDLE_MS) t.activeMs += gap;
    if (context >= MISS_MIN_CONTEXT && m.cacheWrite > context / 2) {
      const written = m.cacheWrite * WEIGHTS.cacheWrite;
      t.misses += 1;
      t.missWeighted += written;
      if (gap !== null && gap >= IDLE_MS) {
        t.idleMisses += 1;
        t.idleMissWeighted += written;
      }
    }
    if (m.polls) {
      t.polls += 1;
      t.pollWeighted += weighted;
    }
    if (isBuilder && !edited) t.preEdit += weighted;
    if (m.edits) edited = true;
    if (context > CONTEXT_LIMIT) {
      t.overLimitTurns += 1;
      t.overLimitWeighted += (context - CONTEXT_LIMIT) * WEIGHTS.cacheRead;
    }
    previous = m;
  }
}

const addTotals = (into, from) => {
  for (const key of Object.keys(into)) {
    into[key] = key === 'peak' ? Math.max(into.peak, from.peak) : into[key] + from[key];
  }
};

const slugOf = (description) => /^([a-z0-9][a-z0-9-]*): /.exec(description ?? '')?.[1] ?? null;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
};

const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// The folder Claude Code keeps a project's transcripts in.
export const transcriptsDir = (project) =>
  join(homedir(), '.claude', 'projects', resolve(project).replace(/[^a-zA-Z0-9]/g, '-'));

export function buildSpend({ dir, since = null, session = null }) {
  const sinceAt = since ? Date.parse(`${since}T00:00:00Z`) : null;
  const keep = (m) => sinceAt === null || (m.firstAt !== null && m.firstAt >= sinceAt);
  const spend = {
    found: false,
    skipped: 0,
    main: emptyTotals(),
    agents: emptyTotals(),
    roles: new Map(),
    tasks: new Map(),
    sessions: [],
  };
  const files = listDir(dir).filter((name) => name.endsWith('.jsonl'));
  for (const file of files) {
    const id = file.slice(0, -'.jsonl'.length);
    if (session && !id.startsWith(session)) continue;
    spend.found = true;
    const parsed = parseTranscript(readFileSync(join(dir, file), 'utf8'));
    spend.skipped += parsed.skipped;
    const main = emptyTotals();
    addMessages(main, parsed.messages.filter(keep), false);
    addTotals(spend.main, main);
    const agents = emptyTotals();
    const subDir = join(dir, id, 'subagents');
    for (const sub of listDir(subDir).filter((name) => name.endsWith('.jsonl'))) {
      const meta = readJson(join(subDir, `${sub.slice(0, -'.jsonl'.length)}.meta.json`));
      const parsedSub = parseTranscript(readFileSync(join(subDir, sub), 'utf8'));
      spend.skipped += parsedSub.skipped;
      const messages = parsedSub.messages.filter(keep);
      if (messages.length === 0) continue;
      const role = /^[a-z0-9-]+$/.test(meta.agentType ?? '') ? meta.agentType : 'unknown';
      const totals = emptyTotals();
      addMessages(totals, messages, role.startsWith('builder'));
      addTotals(agents, totals);
      const roleRow = spend.roles.get(role) ?? { runs: 0, totals: emptyTotals() };
      roleRow.runs += 1;
      addTotals(roleRow.totals, totals);
      spend.roles.set(role, roleRow);
      const slug = slugOf(meta.description) ?? '(no slug)';
      const task = spend.tasks.get(slug) ?? { runs: 0, totals: emptyTotals() };
      task.runs += 1;
      addTotals(task.totals, totals);
      spend.tasks.set(slug, task);
    }
    addTotals(spend.agents, agents);
    if (main.turns + agents.turns > 0) spend.sessions.push({ id, main, agents });
  }
  spend.sessions.sort((a, b) => b.main.weighted + b.agents.weighted - a.main.weighted - a.agents.weighted);
  return spend;
}

const millions = (n) => (n / 1e6).toFixed(1);
const minutes = (ms) => Math.round(ms / 60_000);
const byWeight = (a, b) => b[1].totals.weighted - a[1].totals.weighted;

export function renderSpend(spend) {
  if (!spend.found) return ['No transcripts found: spend unknown.'];
  const { main, agents } = spend;
  const all = emptyTotals();
  addTotals(all, main);
  addTotals(all, agents);
  const lines = [
    `Spend in weighted tokens, millions (input ${WEIGHTS.input}, cache write ${WEIGHTS.cacheWrite}, ` +
      `cache read ${WEIGHTS.cacheRead}, output ${WEIGHTS.output}; models not told apart; not a bill).`,
    `Total ${millions(all.weighted)}: main session ${millions(main.weighted)}, agents ${millions(agents.weighted)}. ` +
      `Cache write ${millions(all.cacheWrite)}, cache read ${millions(all.cacheRead)}, output ${millions(all.output)}.`,
    '',
    'Pools that can shrink (they can overlap, so they do not add up):',
    `  cache misses, main session: ${main.misses} turns, ${millions(main.missWeighted)}; after an idle gap: ${main.idleMisses} turns, ${millions(main.idleMissWeighted)}`,
    `  cache misses, agents: ${agents.misses} turns, ${millions(agents.missWeighted)}; after an idle gap: ${agents.idleMisses} turns, ${millions(agents.idleMissWeighted)}`,
    `  polling: ${all.polls} turns, ${millions(all.pollWeighted)}`,
    `  builders before their first edit: ${millions(all.preEdit)} (part of this is design thinking)`,
    `  context over ${CONTEXT_LIMIT / 1000}k: main session ${main.overLimitTurns} of ${main.turns} turns, ` +
      `reads ${millions(main.overLimitWeighted)}; agents ${agents.overLimitTurns} of ${agents.turns} turns, ` +
      `reads ${millions(agents.overLimitWeighted)}`,
    '',
    'By role:',
  ];
  for (const [role, { runs, totals }] of [...spend.roles].sort(byWeight)) {
    lines.push(
      `  ${role}: runs ${runs}, turns ${totals.turns}, spend ${millions(totals.weighted)}, ` +
        `active ${minutes(totals.activeMs)} min, peak context ${Math.round(totals.peak / 1000)}k`,
    );
  }
  lines.push('', 'By task (agents only; the slug starts the agent description, `<slug>: ...`):');
  for (const [slug, { runs, totals }] of [...spend.tasks].sort(byWeight)) {
    lines.push(`  ${slug}: runs ${runs}, spend ${millions(totals.weighted)}, active ${minutes(totals.activeMs)} min`);
  }
  lines.push('', 'Largest sessions:');
  for (const s of spend.sessions.slice(0, 5)) {
    lines.push(
      `  ${s.id.slice(0, 8)}: main ${millions(s.main.weighted)} (${s.main.turns} turns, peak ${Math.round(s.main.peak / 1000)}k), ` +
        `agents ${millions(s.agents.weighted)}`,
    );
  }
  if (spend.skipped > 0) lines.push('', `Unreadable transcript lines skipped: ${spend.skipped}`);
  return lines;
}

function parseArgs(argv) {
  const known = { '--project': 'project', '--since': 'since', '--session': 'session', '--transcripts': 'dir' };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = known[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option: ${argv[i]}`);
    args[name] = argv[i + 1];
  }
  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error('--since must be YYYY-MM-DD');
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const dir = args.dir ?? transcriptsDir(args.project ?? process.cwd());
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  const spend = isDir
    ? buildSpend({ dir, since: args.since ?? null, session: args.session ?? null })
    : { found: false };
  console.log(renderSpend(spend).join('\n'));
}
