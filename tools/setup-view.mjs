#!/usr/bin/env node
// Global view of the agent setup: counts across every project under one root folder.
// Read-only, no dependencies. Each project's ledgers stay the only record.
//
//   node tools/setup-view.mjs [--root <folder>] [--agents-dir <folder>]
//
// Rules, all from the setup-review design (scan, widths, values, sample sizes):
// - A project is `<root>/*/docs/agents.md`, one level only, so a template profile deeper down is
//   not a project. The default root is the parent of this repo.
// - Counts only. No slug, case id, batch id, hash or file text is printed. A printed group value
//   must match ^[a-z0-9.-]+$; anything else makes the row malformed, never a printed value.
// - A ledger is read by its exact header, old or new. A row must have the width of that header or
//   of an older one; any other field count is malformed, counted and excluded. Fields are split
//   on commas with no quoting rules, so a comma in a slug can only add fields.
// - `severe` and `fix_caused` count only on rows that state both. An older row is not rated, never
//   read as 0, and the view says how many runs were rated.
// - Unknown stays unknown: a risk class that is not exactly A, B or C is `unknown`, a missing
//   ledger is "no ledger" and not zero, a blank effort beside a model is `unknown`, and a drill
//   row with `caught` blank adds nothing to `planted` or `caught`.
// - Rows with no model are counted and excluded; they are never guessed or backfilled.
// - Groups are never merged. Too few is a stated constant and is not adjusted.
// - Acceptance is a hint only; drill scores are the basis for comparing models.
// - A reviewer is current only by a batch for its own text and the profile's domain checklist, at the
//   profile's model and effort for each case's tier, that scored every active case as it now stands. A
//   later batch at another model, effort or text, or of fewer cases, is ignored: a named comparison
//   cannot reopen anything. A change elsewhere in the profile or rules prints one information line and
//   reopens nothing.
// - A batch can be resumed, so it can hold a blank and a later score for one case. The latest row per
//   case in a batch is the one that counts; the rows it replaces are only counted as superseded.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Too few: under 10 runs, or under 10 planted bugs for drills.
export const MIN_RUNS = 10;
export const MIN_PLANTED = 10;

// The reviewers the drills cover. `ux-reviewer`, `trust-reviewer`, `triage` and `challenger` have
// no file:line answer to score. Listed here so a project with no drill row yet is still flagged.
export const DRILLED_REVIEWERS = ['code-reviewer', 'code-reviewer-light'];

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_AGENTS_DIR = resolve(HERE, '..', 'claude', 'agents');

const UNKNOWN = 'unknown';

const AGENT_OLD = ['date', 'slug', 'tier', 'reviewer', 'findings', 'accepted', 'rejected', 'duplicate'];
const RUN_OLD = [
  'date',
  'slug',
  'tier',
  'final_tier',
  'builder_retries',
  'checks_failures',
  'fix_rounds',
  'owner_stops',
  'escape_of',
];
const DRILL = [
  'date',
  'case',
  'kind',
  'reviewer',
  'model',
  'effort',
  'tier',
  'planted',
  'caught',
  'other_findings',
  'batch',
  'batch_cases',
  'agent_text',
  'malformed',
  'context_text',
  'case_hash',
];

const AGENT_MODEL = [...AGENT_OLD, 'model', 'effort'];

export const HEADERS = {
  agent: { old: AGENT_OLD, middle: AGENT_MODEL, new: [...AGENT_MODEL, 'severe', 'fix_caused'] },
  run: { old: RUN_OLD, new: [...RUN_OLD, 'builder_model', 'builder_effort'] },
  drill: { old: null, new: DRILL },
};

const isBlank = (v) => v === undefined || v.trim() === '';
const isCount = (v) => /^\d{1,9}$/.test(v);
const isTier = (v) => /^[0-3]$/.test(v);

// Must match ^[a-z0-9.-]+$ to be printed. The extra letter rule keeps a shifted number out of a
// name column: two commas in a slug of an old row give the new width, and the columns then hold
// the wrong values.
const isValue = (v) => /^[a-z0-9.-]+$/.test(v) && /[a-z]/.test(v);

const ledgerRules = {
  agent: {
    model: 'model',
    effort: 'effort',
    valid: (r) =>
      isValue(r.reviewer) &&
      isCount(r.findings) &&
      isCount(r.accepted) &&
      isCount(r.rejected) &&
      isCount(r.duplicate) &&
      (isBlank(r.severe) || isCount(r.severe)) &&
      (isBlank(r.fix_caused) || isCount(r.fix_caused)),
    key: (r) => [r.reviewer],
    zero: () => ({
      runs: 0,
      findings: 0,
      accepted: 0,
      rejected: 0,
      duplicate: 0,
      rated: 0,
      severe: 0,
      fixCaused: 0,
    }),
    add(g, r) {
      g.runs += 1;
      g.findings += Number(r.findings);
      g.accepted += Number(r.accepted);
      g.rejected += Number(r.rejected);
      g.duplicate += Number(r.duplicate);
      if (!isBlank(r.severe) && !isBlank(r.fix_caused)) {
        g.rated += 1;
        g.severe += Number(r.severe);
        g.fixCaused += Number(r.fix_caused);
      }
    },
  },
  run: {
    model: 'builder_model',
    effort: 'builder_effort',
    valid: (r) =>
      isTier(r.final_tier) &&
      isCount(r.builder_retries) &&
      isCount(r.checks_failures) &&
      isCount(r.fix_rounds) &&
      isCount(r.owner_stops),
    key: () => [],
    zero: () => ({
      tasks: 0,
      finalAbove: 0,
      retries: 0,
      checksFailures: 0,
      fixRounds: 0,
      ownerStops: 0,
      escapes: 0,
    }),
    add(g, r) {
      g.tasks += 1;
      if (Number(r.final_tier) > Number(r.tier)) g.finalAbove += 1;
      g.retries += Number(r.builder_retries);
      g.checksFailures += Number(r.checks_failures);
      g.fixRounds += Number(r.fix_rounds);
      g.ownerStops += Number(r.owner_stops);
      // Only whether it is set: `escape_of` holds a slug.
      if (!isBlank(r.escape_of)) g.escapes += 1;
    },
  },
  drill: {
    model: 'model',
    effort: 'effort',
    valid(r) {
      if (!isValue(r.reviewer) || !['replay', 'planted'].includes(r.kind)) return false;
      if (isBlank(r.case) || isBlank(r.batch) || !isCount(r.batch_cases)) return false;
      if (Number(r.batch_cases) < 1 || !isCount(r.planted)) return false;
      if (isBlank(r.caught)) {
        // Unscored: other columns may be blank, but a value that is there must be a count.
        return [r.other_findings, r.malformed].every((v) => isBlank(v) || isCount(v));
      }
      return (
        isCount(r.caught) &&
        Number(r.caught) <= Number(r.planted) &&
        isCount(r.other_findings) &&
        isCount(r.malformed)
      );
    },
    key: (r) => [r.reviewer],
    zero: () => ({ rows: 0, scored: 0, unscored: 0, planted: 0, caught: 0, other: 0, malformed: 0 }),
    add(g, r) {
      g.rows += 1;
      if (isBlank(r.caught)) {
        // Unknown, never 0: it adds nothing to the numerator or the denominator.
        g.unscored += 1;
        return;
      }
      g.scored += 1;
      g.planted += Number(r.planted);
      g.caught += Number(r.caught);
      g.other += Number(r.other_findings);
      g.malformed += Number(r.malformed);
    },
  },
};

function sectionLines(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##?\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

// `A` alone or `A (why): ...` is a class. Anything else, such as the template's placeholder,
// "A or B", "Class A" or a lowercase letter, is unknown.
export function parseRiskClass(profileText) {
  const first = sectionLines(profileText, 'Risk class').find((l) => l.trim() !== '');
  if (first === undefined) return UNKNOWN;
  const match = /^([ABC])(?:\s*$|\s+\()/.exec(first.trim());
  return match ? match[1] : UNKNOWN;
}

const staysInProject = (p) =>
  !isAbsolute(p) && !p.startsWith('~') && !p.split(/[\\/]/).includes('..');

// The `- Ledgers:` bullet of `## Paths`, which may wrap over several lines.
export function parseLedgerPaths(profileText) {
  const lines = sectionLines(profileText, 'Paths');
  const start = lines.findIndex((l) => /^\s*-\s+Ledgers:/.test(l));
  if (start < 0) return {};
  let bullet = lines[start];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*-\s/.test(line)) break;
    bullet += ` ${line}`;
  }
  const paths = {};
  for (const [, path] of bullet.matchAll(/`([^`]+)`/g)) {
    if (!staysInProject(path)) continue;
    const name = path.split('/').at(-1);
    if (name === 'agent-ledger.csv') paths.agent ??= path;
    if (name === 'run-ledger.csv') paths.run ??= path;
  }
  return paths;
}

const sameHeader = (fields, names) =>
  names !== null && fields.length === names.length && fields.every((f, i) => f === names[i]);

// Returns the ledger's status, its rows by column name and the lines it could not read.
export function readLedger(path, kind) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
    return { status: missing ? 'no ledger' : 'unreadable', rows: [], unreadLines: 0 };
  }
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const { old, middle, new: current } = HEADERS[kind];
  const headerFields = (lines[0] ?? '').split(',');
  let widths;
  let names;
  if (sameHeader(headerFields, current)) {
    names = current;
    widths = [old, middle, current].filter(Boolean).map((header) => header.length);
  } else if (middle && sameHeader(headerFields, middle)) {
    names = middle;
    widths = [old.length, middle.length];
  } else if (sameHeader(headerFields, old)) {
    names = old;
    widths = [old.length];
  } else {
    // Read by header or not at all: the columns of a file with no known header are a guess.
    return { status: 'no header', rows: [], unreadLines: lines.length };
  }
  const rows = [];
  let unreadLines = 0;
  for (const line of lines.slice(1)) {
    const fields = line.split(',');
    if (!widths.includes(fields.length)) {
      unreadLines += 1;
      continue;
    }
    rows.push(Object.fromEntries(fields.map((f, i) => [names[i], f])));
  }
  return { status: 'ok', rows, unreadLines };
}

// 'no model' | 'malformed' | 'grouped'. A row with no model is not examined further: nothing in
// it is used, and an old row must not read as malformed for a rule added after it was written.
function classifyRow(row, rules) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return 'malformed';
  if (isBlank(row[rules.model])) return 'no model';
  if (!isValue(row[rules.model])) return 'malformed';
  if (!isBlank(row[rules.effort]) && !isValue(row[rules.effort])) return 'malformed';
  if (!isTier(row.tier)) return 'malformed';
  return rules.valid(row) ? 'grouped' : 'malformed';
}

// A short hash of some byte strings. Each part is prefixed by its length, so bytes moved between
// parts change the hash. Must agree with what the drill runner stores.
export function hashParts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part);
    hash.update(`${bytes.length}\n`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 16);
}

// The profile's `## Domain checklist`, in its order, without blank lines around it. A profile with no
// such section gives an empty text, so its hash is still defined, and adding or removing the section
// moves the hash. Every section of that name counts, so a second one cannot go unseen.
export function domainChecklist(profile) {
  const kept = [];
  let inside = false;
  for (const line of String(profile).split(/\r?\n/)) {
    if (/^##?\s/.test(line)) inside = line.trim() === '## Domain checklist';
    else if (inside) kept.push(line);
  }
  return kept.join('\n').trim();
}

// `agent_text`: the reviewer's own agent file and the profile's domain checklist, its first criterion
// and the setup review's standard lever. Nothing else from the profile or rules: those are context.
export const agentTextHash = (agentBytes, profile) =>
  hashParts([agentBytes, domainChecklist(profile)]);

function currentAgentHash(reviewer, agentsDir, profile) {
  try {
    return agentTextHash(readFileSync(join(agentsDir, `${reviewer}.md`)), profile);
  } catch {
    // A text that cannot be read has no known hash, so no batch can be shown to match it.
    return null;
  }
}

// Bytes, or empty when the file is absent: a missing file is part of what `context_text` records.
const bytesOrEmpty = (path) => {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
};

export const globalRulesPath = () => join(homedir(), '.claude', 'CLAUDE.md');
export const readGlobalRules = () => bytesOrEmpty(globalRulesPath());

// `context_text`: what surrounds the reviewer's text: the project's profile and rules, and the
// user's global rules when present. Changing often and not part of what a reviewer checks, so a
// difference only informs. Order: docs/agents.md, CLAUDE.md, the global file.
export const contextHash = (profile, rules, globalRules) => hashParts([profile, rules, globalRules]);

function currentContextHash(projectDir) {
  return contextHash(
    bytesOrEmpty(join(projectDir, 'docs', 'agents.md')),
    bytesOrEmpty(join(projectDir, 'CLAUDE.md')),
    readGlobalRules(),
  );
}

// `case_hash`: everything that defines a case, so a reworded key or spec never compares with itself.
export function caseHash(caseDir) {
  return hashParts([
    readFileSync(join(caseDir, 'case.json')),
    readFileSync(join(caseDir, 'spec.md')),
    bytesOrEmpty(join(caseDir, 'planted.patch')),
  ]);
}

// The cases not retired, with their current hash. One that cannot be read is counted: it must keep
// a reviewer from reading as covered, and it cannot be given to any one reviewer.
export function readActiveCases(drillsDir) {
  const active = [];
  let unreadable = 0;
  let names = [];
  try {
    names = readdirSync(drillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No cases folder: no active cases, and so no batch can cover them.
  }
  for (const id of names.sort()) {
    try {
      const c = JSON.parse(readFileSync(join(drillsDir, id, 'case.json'), 'utf8'));
      if (typeof c?.reviewer !== 'string') unreadable += 1;
      else if (c.retired === null || c.retired === undefined) {
        active.push({ id, reviewer: c.reviewer, hash: caseHash(join(drillsDir, id)) });
      }
    } catch {
      unreadable += 1;
    }
  }
  return { active, unreadable };
}

// The profile's table: `| code-reviewer | opus | high | note |`, matched on the exact role. For a
// tier 3 case the `Tier 3:` row wins when it lists the reviewer (`| Tier 3: builder-heavy,
// code-reviewer | opus | xhigh | |`); any other reviewer keeps its role's row.
export function profileModel(profile, reviewer, tier) {
  const rows = profile
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4);
  const tierRow = rows.find((cells) => {
    const m = /^Tier 3:\s*(.*)$/.exec(cells[1]);
    return m !== null && m[1].split(',').some((name) => name.trim() === reviewer);
  });
  const row = tier === 3 && tierRow ? tierRow : rows.find((cells) => cells[1] === reviewer);
  return row ? { model: row[2], effort: row[3] } : null;
}

// `id` is the concrete model id from a run's output; `requested` an alias (`opus`) or a concrete id.
export function modelMatches(id, requested) {
  if (!requested.includes('-')) return id.split('-').includes(requested);
  return id === requested || id.startsWith(`${requested}-`);
}

// One row per case in each batch: the latest, in the order those rows were written. The ledger is
// append-only, so a resumed batch keeps its blank and adds the later score. A row with no batch or case
// names nothing to replace, and stays.
export function latestPerCase(rows) {
  const latest = new Map();
  rows.forEach((r, i) => {
    const key = isBlank(r.batch) || isBlank(r.case) ? `row ${i}` : `${r.batch}\0${r.case}`;
    latest.delete(key);
    latest.set(key, r);
  });
  return [...latest.values()];
}

// The batch that speaks for this reviewer now. Rows are in file order, and the ledger is append-only,
// so the latest batch is the one whose rows come last. Only rows scored for the current text, at the
// profile's model and effort for their tier, count at all; so a named comparison, a draft text or a
// model trial cannot change the answer. Current: the latest batch where those rows cover every active
// case as it now stands, and every one was planned with at least that many cases. So a `--case` run
// (batch_cases 1) can never be the answer, even if two share a batch name, unless the reviewer has
// only that one case, when it is a whole batch.
export function reviewerStatus({ rows, reviewer, agentHash, profile, cases, unreadable, context }) {
  const active = cases.filter((c) => c.reviewer === reviewer);
  const planned = active.length + unreadable;
  const counts = (r) => {
    if (isBlank(r.caught) || r.reviewer !== reviewer || r.agent_text !== agentHash) return false;
    const want = profileModel(profile, reviewer, Number(r.tier));
    return want !== null && r.effort === want.effort && modelMatches(r.model, want.model);
  };
  const latestFirst = [...new Set(rows.filter(counts).map((r) => r.batch).reverse())];
  if (agentHash === null || planned === 0 || latestFirst.length === 0) return { current: false };

  const covered = (batch) => {
    const scored = rows.filter((r) => r.batch === batch && counts(r));
    return active.filter((c) => scored.some((r) => r.case === c.id && r.case_hash === c.hash)).length;
  };
  const plannedInFull = (batch) =>
    rows.filter((r) => r.batch === batch && counts(r)).every((r) => Number(r.batch_cases) >= planned);
  const full = latestFirst.find((batch) => covered(batch) === planned && plannedInFull(batch));
  if (full === undefined) {
    return { current: false, incomplete: true, scored: covered(latestFirst[0]), planned };
  }
  const last = rows.filter((r) => r.batch === full && counts(r)).at(-1);
  const contextDiffers = !isBlank(last.context_text) && last.context_text !== context;
  return {
    current: true,
    scored: planned,
    planned,
    ...(contextDiffers ? { contextChangedSince: last.date } : {}),
  };
}

export function findProjects(root) {
  const seen = new Set();
  const projects = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    try {
      if (!statSync(join(dir, 'docs', 'agents.md')).isFile()) continue;
      // A link to a project already listed must not count its rows twice.
      const real = realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      projects.push({ name, dir });
    } catch {
      // Not a project: no profile there, or a broken link.
    }
  }
  return projects;
}

const emptyTotals = () => ({ rows: 0, noModel: 0, malformed: 0, grouped: 0, noLedger: 0 });

export function buildView({ root, agentsDir = DEFAULT_AGENTS_DIR }) {
  const view = {
    projects: [],
    classes: { A: 0, B: 0, C: 0, [UNKNOWN]: 0 },
    totals: { agent: emptyTotals(), run: emptyTotals(), drill: emptyTotals() },
    supersededDrillRows: 0,
    groups: { agent: new Map(), run: new Map(), drill: new Map() },
    texts: [],
  };

  for (const { name, dir } of findProjects(root)) {
    let profile = '';
    try {
      profile = readFileSync(join(dir, 'docs', 'agents.md'), 'utf8');
    } catch {
      // Treated like a profile with no class and no ledger paths; both are shown.
    }
    const cls = parseRiskClass(profile);
    const paths = parseLedgerPaths(profile);
    if (paths.agent !== undefined) {
      // Found by folder: the profile does not name the drill ledger.
      paths.drill = join(dirname(paths.agent), 'drill-ledger.csv');
    }
    view.classes[cls] += 1;

    const project = { name: /^[a-z0-9.-]+$/.test(name) ? name : null, cls, status: {} };
    const drillRows = [];
    for (const kind of ['agent', 'run', 'drill']) {
      const totals = view.totals[kind];
      const rules = ledgerRules[kind];
      if (paths[kind] === undefined) {
        project.status[kind] = 'no ledger path';
        totals.noLedger += 1;
        continue;
      }
      const ledger = readLedger(join(dir, paths[kind]), kind);
      project.status[kind] = ledger.status;
      if (ledger.status === 'no ledger' || ledger.status === 'unreadable') totals.noLedger += 1;
      const rows = kind === 'drill' ? latestPerCase(ledger.rows) : ledger.rows;
      view.supersededDrillRows += ledger.rows.length - rows.length;
      totals.rows += ledger.unreadLines + rows.length;
      totals.malformed += ledger.unreadLines;
      for (const row of rows) {
        const outcome = classifyRow(row, rules);
        if (outcome === 'no model') totals.noModel += 1;
        if (outcome === 'malformed') totals.malformed += 1;
        if (outcome !== 'grouped') continue;
        totals.grouped += 1;
        const effort = isBlank(row[rules.effort]) ? UNKNOWN : row[rules.effort];
        const keyParts = [cls, ...rules.key(row), row[rules.model], effort, row.tier];
        const key = keyParts.join('\0');
        const groups = view.groups[kind];
        if (!groups.has(key)) groups.set(key, { keyParts, counts: rules.zero() });
        rules.add(groups.get(key).counts, row);
        if (kind === 'drill') drillRows.push(row);
      }
    }

    const reviewers = new Set([...DRILLED_REVIEWERS, ...drillRows.map((r) => r.reviewer)]);
    // Found by folder, like the drill ledger. Read here and never printed.
    const { active, unreadable } =
      paths.agent === undefined
        ? { active: [], unreadable: 0 }
        : readActiveCases(join(dir, dirname(paths.agent), 'drills'));
    const context = currentContextHash(dir);
    project.texts = [...reviewers].sort().map((reviewer) => ({
      reviewer,
      ...reviewerStatus({
        rows: drillRows,
        reviewer,
        agentHash: currentAgentHash(reviewer, agentsDir, profile),
        profile,
        cases: active,
        unreadable,
        context,
      }),
    }));
    view.projects.push(project);
  }
  return view;
}

function statusWords(status) {
  return `agent ${status.agent}; run ${status.run}; drill ${status.drill}`;
}

function totalsLine(kind, totals, groupCount, extra = '') {
  return (
    `  ${kind}: rows ${totals.rows}, no model ${totals.noModel}, malformed ${totals.malformed}, ` +
    `grouped ${totals.grouped}, groups ${groupCount}, no ledger ${totals.noLedger}${extra}`
  );
}

function groupLines(groups, describe) {
  if (groups.size === 0) return ['  none'];
  return [...groups.keys()].sort().map((key) => {
    const { keyParts, counts } = groups.get(key);
    const [cls, ...rest] = keyParts;
    const tier = rest.pop();
    return `  ${cls} ${rest.join(' ')} tier ${tier}: ${describe(counts)}`;
  });
}

export function renderView(view) {
  const lines = [];
  const { classes, totals, groups } = view;
  lines.push('Setup view. Counts only: no task names or file contents.');
  lines.push(
    `Too few: under ${MIN_RUNS} runs, or under ${MIN_PLANTED} planted bugs for drills. ` +
      'Groups are never merged.',
  );
  lines.push('');
  lines.push(
    `Projects: ${view.projects.length} (class A ${classes.A}, class B ${classes.B}, ` +
      `class C ${classes.C}, unknown ${classes[UNKNOWN]})`,
  );
  view.projects.forEach((p, i) => {
    lines.push(`  ${p.name ?? `project-${i + 1}`}: class ${p.cls}; ${statusWords(p.status)}`);
  });
  lines.push('');
  lines.push('Rows (no model and malformed are counted and excluded from the groups):');
  lines.push(totalsLine('agent', totals.agent, groups.agent.size));
  lines.push(totalsLine('run', totals.run, groups.run.size));
  let scored = 0;
  for (const { counts } of groups.drill.values()) scored += counts.scored;
  const unscored = totals.drill.rows - totals.drill.malformed - scored;
  const drillExtra = `, scored ${scored}, unscored ${unscored}, superseded ${view.supersededDrillRows}`;
  lines.push(totalsLine('drill', totals.drill, groups.drill.size, drillExtra));
  lines.push('');
  lines.push(
    'Reviews by class, reviewer, model, effort, tier ' +
      '(acceptance: hint only, not a basis for comparing models):',
  );
  lines.push(
    ...groupLines(groups.agent, (c) => {
      const few = c.runs < MIN_RUNS ? ' (too few)' : '';
      return (
        `runs ${c.runs}, findings ${c.findings}, accepted ${c.accepted}, ` +
        `rejected ${c.rejected}, duplicate ${c.duplicate}, ` +
        `severe ${c.severe}, fix caused ${c.fixCaused} (rated ${c.rated} of ${c.runs})${few}`
      );
    }),
  );
  lines.push('');
  lines.push('Tasks by class, builder model, builder effort, tier:');
  lines.push(
    ...groupLines(groups.run, (c) => {
      const few = c.tasks < MIN_RUNS ? ' (too few)' : '';
      return (
        `tasks ${c.tasks}, final tier above ${c.finalAbove}, retries ${c.retries}, ` +
        `checks failures ${c.checksFailures}, fix rounds ${c.fixRounds}, ` +
        `owner stops ${c.ownerStops}, escapes ${c.escapes}${few}`
      );
    }),
  );
  lines.push('');
  lines.push(
    'Drills by class, reviewer, model, effort, tier ' +
      '(basis for model comparison; planted and caught count scored rows only):',
  );
  lines.push(
    ...groupLines(groups.drill, (c) => {
      const few = c.planted < MIN_PLANTED ? ' (too few)' : '';
      return (
        `rows ${c.rows}, scored ${c.scored}, unscored ${c.unscored}, planted ${c.planted}, ` +
        `caught ${c.caught}, other ${c.other}, malformed ${c.malformed}${few}`
      );
    }),
  );
  lines.push('');
  lines.push('Reviewer text against the latest scored batch:');
  view.projects.forEach((p, i) => {
    for (const t of p.texts) {
      const label = `${p.name ?? `project-${i + 1}`} ${t.reviewer}`;
      if (t.incomplete) {
        lines.push(`  ${label}: batch incomplete, scored ${t.scored} of ${t.planned}`);
      } else if (!t.current) lines.push(`  ${label}: no batch for current text`);
      else lines.push(`  ${label}: current, scored ${t.scored} of ${t.planned}`);
      // Information only. A date, since no batch name is printed.
      if (t.contextChangedSince !== undefined) {
        lines.push(`  ${label}: context changed since the batch of ${t.contextChangedSince}`);
      }
    }
  });
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, agentsDir: DEFAULT_AGENTS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== '--root' && flag !== '--agents-dir') throw new Error(`unknown option: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a folder`);
    options[flag === '--root' ? 'root' : 'agentsDir'] = resolve(value);
    i += 1;
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!statSync(options.root).isDirectory()) throw new Error('not a folder');
  } catch (err) {
    process.stderr.write(`setup-view: ${err.message}\n`);
    process.stderr.write('usage: setup-view.mjs [--root <folder>] [--agents-dir <folder>]\n');
    return 1;
  }
  const view = buildView(options);
  if (view.projects.length === 0) {
    // A wrong root must not read as a clean view of nothing.
    process.stderr.write('setup-view: no project under the root (<root>/*/docs/agents.md)\n');
    return 1;
  }
  process.stdout.write(renderView(view));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
