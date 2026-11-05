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
// - A ledger is read by its exact header, old or new. A row must have the old or the new width
//   for that header; any other field count is malformed, counted and excluded. Fields are split
//   on commas with no quoting rules, so a comma in a slug can only add fields.
// - Unknown stays unknown: a risk class that is not exactly A, B or C is `unknown`, a missing
//   ledger is "no ledger" and not zero, a blank effort beside a model is `unknown`, and a drill
//   row with `caught` blank adds nothing to `planted` or `caught`.
// - Rows with no model are counted and excluded; they are never guessed or backfilled.
// - Groups are never merged. Too few is a stated constant and is not adjusted.
// - Acceptance is a hint only; drill scores are the basis for comparing models.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
];

export const HEADERS = {
  agent: { old: AGENT_OLD, new: [...AGENT_OLD, 'model', 'effort'] },
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
      isCount(r.duplicate),
    key: (r) => [r.reviewer],
    zero: () => ({ runs: 0, findings: 0, accepted: 0, rejected: 0, duplicate: 0 }),
    add(g, r) {
      g.runs += 1;
      g.findings += Number(r.findings);
      g.accepted += Number(r.accepted);
      g.rejected += Number(r.rejected);
      g.duplicate += Number(r.duplicate);
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
  const { old, new: current } = HEADERS[kind];
  const headerFields = (lines[0] ?? '').split(',');
  let widths;
  let names;
  if (sameHeader(headerFields, current)) {
    names = current;
    widths = old ? [old.length, current.length] : [current.length];
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

// A short hash of everything a reviewer's instructions come from: its agent file, then the
// project's `docs/agents.md` and `CLAUDE.md`. Must agree with what the drill runner stores in
// `agent_text`. Each part is prefixed by its length, so bytes moved between parts change the hash.
export function agentTextHash(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part);
    hash.update(`${bytes.length}\n`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 16);
}

function currentTextHash(projectDir, reviewer, agentsDir) {
  try {
    return agentTextHash([
      readFileSync(join(agentsDir, `${reviewer}.md`)),
      readFileSync(join(projectDir, 'docs', 'agents.md')),
      readFileSync(join(projectDir, 'CLAUDE.md')),
    ]);
  } catch {
    // A text that cannot be read has no known hash, so no batch can be shown to match it.
    return null;
  }
}

// Compares the current text with the latest scored batch for this reviewer. Rows are in file
// order, and the ledger is append-only. `scored` and `planned` cover the whole batch: a batch that
// died midway has fewer scored cases than planned, which does not count as done.
export function compareText(drillRows, reviewer, currentHash) {
  const scored = drillRows.filter((r) => !isBlank(r.caught));
  const latest = scored.filter((r) => r.reviewer === reviewer).at(-1);
  if (latest === undefined || currentHash === null || latest.agent_text !== currentHash) {
    return { current: false };
  }
  const inBatch = drillRows.filter((r) => r.batch === latest.batch);
  return {
    current: true,
    scored: new Set(scored.filter((r) => r.batch === latest.batch).map((r) => r.case)).size,
    planned: Math.max(...inBatch.map((r) => Number(r.batch_cases))),
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
      totals.rows += ledger.unreadLines + ledger.rows.length;
      totals.malformed += ledger.unreadLines;
      for (const row of ledger.rows) {
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
    project.texts = [...reviewers].sort().map((reviewer) => ({
      reviewer,
      ...compareText(drillRows, reviewer, currentTextHash(dir, reviewer, agentsDir)),
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
  const drillExtra = `, scored ${scored}, unscored ${unscored}`;
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
        `rejected ${c.rejected}, duplicate ${c.duplicate}${few}`
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
      if (!t.current) lines.push(`  ${label}: no batch for current text`);
      else if (t.scored < t.planned) {
        lines.push(`  ${label}: batch incomplete, scored ${t.scored} of ${t.planned}`);
      } else lines.push(`  ${label}: current, scored ${t.scored} of ${t.planned}`);
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
