// Tests for the global view. Synthetic data only, in a temp folder, with neutral made-up names.
//   node --test "tools/setup-view*.test.mjs"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentTextHash,
  buildView,
  caseHash,
  contextHash,
  DEFAULT_AGENTS_DIR,
  DEFAULT_ROOT,
  domainChecklist,
  DRILLED_REVIEWERS,
  findProjects,
  hashParts,
  HEADERS,
  latestPerCase,
  MIN_PLANTED,
  MIN_RUNS,
  modelMatches,
  parseLedgerPaths,
  parseRiskClass,
  profileModel,
  readLedger,
  renderView,
} from './setup-view.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'setup-view.mjs');
const REPO = resolve(HERE, '..');

const AGENT_NEW = HEADERS.agent.new.join(',');
const AGENT_OLD = HEADERS.agent.old.join(',');
const RUN_NEW = HEADERS.run.new.join(',');
const RUN_OLD = HEADERS.run.old.join(',');
const DRILL = HEADERS.drill.new.join(',');

const scratch = mkdtempSync(join(tmpdir(), 'view-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function newRoot() {
  counter += 1;
  const root = join(scratch, `root-${counter}`);
  mkdirSync(root);
  return root;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const profile = (cls = 'A (neutral): a made-up reason') => `# Agent profile

## Risk class

${cls}

## Domain checklist

- First check: a made-up rule.
- Second check: another one.

## Models and efforts

| Role | Model | Effort | Note |
|---|---|---|---|
| code-reviewer-light | model-x | high | |
| code-reviewer | model-x | high | |
| other-reviewer | model-x | high | |
| Tier 3: builder-heavy, code-reviewer | model-x | xhigh | |

## Paths

- Spec template: \`docs/spec-template.md\`.
- Ledgers: \`vault/ops/agent-ledger.csv\` (per reviewer run), \`vault/ops/run-ledger.csv\` (per
  task, from a date).
- Owner's actions: \`vault/ops/actions.md\`.

## Setup changes

- none
`;

// A project folder. Ledger text is written as given; undefined leaves that file out.
function addProject(root, name, { cls, agent, run, drill, claude = 'rules\n' } = {}) {
  const dir = join(root, name);
  write(join(dir, 'docs', 'agents.md'), profile(cls));
  if (claude !== null) write(join(dir, 'CLAUDE.md'), claude);
  if (agent !== undefined) write(join(dir, 'vault', 'ops', 'agent-ledger.csv'), agent);
  if (run !== undefined) write(join(dir, 'vault', 'ops', 'run-ledger.csv'), run);
  if (drill !== undefined) write(join(dir, 'vault', 'ops', 'drill-ledger.csv'), drill);
  return dir;
}

function agentsDir(root, texts = { 'code-reviewer': 'reviewer text\n', 'code-reviewer-light': 'light text\n' }) {
  const dir = join(root, '.agents');
  for (const [name, text] of Object.entries(texts)) write(join(dir, `${name}.md`), text);
  return dir;
}

const lines = (...rows) => `${rows.join('\n')}\n`;
const agentRow = (over = {}) => {
  const r = {
    date: '2026-01-02',
    slug: 'task-one',
    tier: '2',
    reviewer: 'code-reviewer',
    findings: '4',
    accepted: '2',
    rejected: '1',
    duplicate: '1',
    model: 'opus',
    effort: 'high',
    ...over,
  };
  return HEADERS.agent.new.map((c) => r[c]).join(',');
};
const runRow = (over = {}) => {
  const r = {
    date: '2026-01-02',
    slug: 'task-one',
    tier: '2',
    final_tier: '2',
    builder_retries: '0',
    checks_failures: '1',
    fix_rounds: '1',
    owner_stops: '0',
    escape_of: '',
    builder_model: 'sonnet',
    builder_effort: 'medium',
    ...over,
  };
  return HEADERS.run.new.map((c) => r[c]).join(',');
};
// A case of its own unless told otherwise: the latest row per case in a batch is the one that counts.
let autoCase = 0;
const drillRow = (over = {}) => {
  autoCase += 1;
  const r = {
    date: '2026-01-02',
    case: `row-case-${autoCase}`,
    kind: 'replay',
    reviewer: 'code-reviewer',
    model: 'model-x-1',
    effort: 'high',
    tier: '2',
    planted: '2',
    caught: '1',
    other_findings: '3',
    batch: 'batch-one',
    batch_cases: '1',
    agent_text: 'abc',
    malformed: '0',
    context_text: 'ctx',
    case_hash: 'chash',
    ...over,
  };
  return HEADERS.drill.new.map((c) => r[c]).join(',');
};

const view = (root, agents = agentsDir(root)) => buildView({ root, agentsDir: agents });
const groupList = (groups) => [...groups.values()];

function hashFor(agents, reviewer, dir) {
  return agentTextHash(
    readFileSync(join(agents, `${reviewer}.md`)),
    readFileSync(join(dir, 'docs', 'agents.md')),
  );
}

// As the runner computes it. The global rules are empty here: the view runs under an empty HOME.
function contextFor(dir, globalRules = '') {
  return contextHash(
    readFileSync(join(dir, 'docs', 'agents.md')),
    readFileSync(join(dir, 'CLAUDE.md')),
    globalRules,
  );
}

function addCase(dir, id, over = {}) {
  const caseDir = join(dir, 'vault', 'ops', 'drills', id);
  write(
    join(caseDir, 'case.json'),
    JSON.stringify({ id, reviewer: 'code-reviewer', tier: 2, retired: null, ...over }),
  );
  write(join(caseDir, 'spec.md'), 'A made-up spec.\n');
  return caseHash(caseDir);
}

// No real home: the view reads ~/.claude/CLAUDE.md, and a test must not depend on the machine's.
process.env.HOME = join(scratch, 'empty-home');

describe('finding projects', () => {
  it('reads one level only, so a template profile deeper down is not a project', () => {
    const root = newRoot();
    addProject(root, 'alpha');
    write(join(root, 'kit', 'templates', 'docs', 'agents.md'), profile());
    write(join(root, 'docs', 'agents.md'), profile());
    write(join(root, 'plain', 'README.md'), 'not a project\n');
    assert.deepEqual(
      findProjects(root).map((p) => p.name),
      ['alpha'],
    );
  });

  it('skips hidden folders and a folder holding docs/agents.md as a folder', () => {
    const root = newRoot();
    addProject(root, '.hidden');
    mkdirSync(join(root, 'odd', 'docs', 'agents.md'), { recursive: true });
    assert.deepEqual(findProjects(root), []);
  });

  it('counts a project once when a link points at it, and a broken link is no crash', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, agentRow()) });
    symlinkSync(join(root, 'alpha'), join(root, 'beta-link'));
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
    const v = view(root);
    assert.equal(v.projects.length, 1);
    assert.equal(v.totals.agent.rows, 1);
  });
});

describe('risk class', () => {
  const cases = [
    ['A (silent and lasting): reason', 'A'],
    ['B (recomputable): reason', 'B'],
    ['C (low stakes): reason', 'C'],
    ['A', 'A'],
    ['  B (indented): reason', 'B'],
    ['<A, B or C (see the README), and one line on why.>', 'unknown'],
    ['A, B or C', 'unknown'],
    ['A or B (undecided)', 'unknown'],
    ['Class A', 'unknown'],
    ['a (lowercase)', 'unknown'],
    ['D (no such class)', 'unknown'],
    ['AB (two letters)', 'unknown'],
    ['A: colon form', 'unknown'],
  ];
  for (const [text, expected] of cases) {
    it(`reads "${text}" as ${expected}`, () => {
      assert.equal(parseRiskClass(`## Risk class\n\n${text}\n\n## Next\n`), expected);
    });
  }

  it('is unknown with no section, an empty section, or only a later section holding a class', () => {
    assert.equal(parseRiskClass('# Profile\n'), 'unknown');
    assert.equal(parseRiskClass('## Risk class\n\n## Next\n\nA (other): text\n'), 'unknown');
  });

  it('handles CRLF line ends', () => {
    assert.equal(parseRiskClass('## Risk class\r\n\r\nB (why): text\r\n'), 'B');
  });
});

describe('ledger paths', () => {
  it('reads a bullet wrapped over two lines', () => {
    assert.deepEqual(parseLedgerPaths(profile()), {
      agent: 'vault/ops/agent-ledger.csv',
      run: 'vault/ops/run-ledger.csv',
    });
  });

  it('reads a path that starts on the wrapped line, and stops at the next bullet', () => {
    const text =
      '## Paths\n\n- Ledgers: `a/agent-ledger.csv` (one row) and\n  `a/run-ledger.csv` (one row).\n' +
      '- Other: `b/run-ledger.csv`.\n';
    assert.deepEqual(parseLedgerPaths(text), {
      agent: 'a/agent-ledger.csv',
      run: 'a/run-ledger.csv',
    });
  });

  it('refuses a path that leaves the project', () => {
    const text =
      '## Paths\n\n- Ledgers: `../x/agent-ledger.csv`, `/abs/run-ledger.csv`, `~/y/run-ledger.csv`.\n';
    assert.deepEqual(parseLedgerPaths(text), {});
  });

  it('finds nothing with no Paths section or no Ledgers bullet', () => {
    assert.deepEqual(parseLedgerPaths('# Profile\n'), {});
    assert.deepEqual(parseLedgerPaths('## Paths\n\n- Spec: `x`.\n'), {});
    assert.deepEqual(parseLedgerPaths('## Other\n\n- Ledgers: `a/agent-ledger.csv`.\n'), {});
  });
});

describe('reading old and new rows', () => {
  it('counts an old row as no model and groups a new one, under the new header', () => {
    const root = newRoot();
    const oldRow = '2026-01-01,task-old,2,code-reviewer,5,3,1,1';
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, oldRow, agentRow()) });
    const v = view(root);
    assert.deepEqual(v.totals.agent, { rows: 2, noModel: 1, malformed: 0, grouped: 1, noLedger: 0 });
    const [group] = groupList(v.groups.agent);
    assert.deepEqual(group.keyParts, ['A', 'code-reviewer', 'opus', 'high', '2']);
    assert.equal(group.counts.findings, 4, 'the old row adds nothing to the group');
  });

  it('counts a new-width row with a blank model as no model', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, agentRow({ model: '', effort: '' })) });
    assert.equal(view(root).totals.agent.noModel, 1);
    assert.equal(view(root).groups.agent.size, 0);
  });

  it('reads old rows under the old header, and treats a new-width row there as malformed', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      agent: lines(AGENT_OLD, '2026-01-01,task-old,2,code-reviewer,5,3,1,1', agentRow()),
      run: lines(RUN_OLD, '2026-01-01,task-old,2,2,0,0,0,0,', runRow()),
    });
    const v = view(root);
    assert.deepEqual(v.totals.agent, { rows: 2, noModel: 1, malformed: 1, grouped: 0, noLedger: 0 });
    assert.deepEqual(v.totals.run, { rows: 2, noModel: 1, malformed: 1, grouped: 0, noLedger: 0 });
    assert.equal(v.projects[0].status.agent, 'ok');
  });

  it('reads old and new run rows and sums the task columns', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      run: lines(
        RUN_NEW,
        '2026-01-01,task-old,2,2,0,0,0,0,',
        runRow(),
        runRow({ final_tier: '3', builder_retries: '2', owner_stops: '1', escape_of: 'task-zero' }),
      ),
    });
    const v = view(root);
    assert.deepEqual(v.totals.run, { rows: 3, noModel: 1, malformed: 0, grouped: 2, noLedger: 0 });
    const [group] = groupList(v.groups.run);
    assert.deepEqual(group.keyParts, ['A', 'sonnet', 'medium', '2']);
    assert.deepEqual(group.counts, {
      tasks: 2,
      finalAbove: 1,
      retries: 2,
      checksFailures: 2,
      fixRounds: 2,
      ownerStops: 1,
      escapes: 1,
    });
  });

  it('accepts CRLF line ends and a byte order mark', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: `﻿${AGENT_NEW}\r\n${agentRow()}\r\n` });
    assert.equal(view(root).totals.agent.grouped, 1);
  });

  it('keeps rows = no model + malformed + grouped, and ignores blank lines', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      agent: lines(AGENT_NEW, '', agentRow(), '   ', '2026-01-01,a,2,code-reviewer,1,1,0,0', 'x,y', ''),
    });
    const t = view(root).totals.agent;
    assert.equal(t.rows, 3);
    assert.equal(t.rows, t.noModel + t.malformed + t.grouped);
  });
});

describe('malformed rows', () => {
  it('counts any other field count, and never reads it', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      agent: lines(AGENT_NEW, 'too,few', `${agentRow()},extra`, `${agentRow()},extra,more`),
      run: lines(RUN_NEW, 'too,few', `${runRow()},extra`),
      drill: lines(DRILL, 'too,few', `${drillRow()},extra`),
    });
    const v = view(root);
    assert.deepEqual(
      ['agent', 'run', 'drill'].map((k) => [v.totals[k].malformed, v.totals[k].grouped]),
      [
        [3, 0],
        [2, 0],
        [2, 0],
      ],
    );
  });

  it('a comma in a slug cannot move a slug into a printed column', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      agent: lines(
        AGENT_NEW,
        // One extra comma in an old row: no width fits.
        '2026-01-01,leak-one,leak-two,2,code-reviewer,5,3,1,1',
        // Two extra commas in an old row: the new width fits, and the columns shift.
        '2026-01-01,leak-one,leak-two,leak-three,2,code-reviewer,5,3,1,1',
        // The worst fit: a slug piece that reads as a tier, and one that lands in reviewer.
        '2026-01-01,leak-one,2,3,2,code-reviewer,5,3,1,1',
      ),
      run: lines(
        RUN_NEW,
        '2026-01-01,leak-one,leak-two,2,2,0,0,0,0,',
        '2026-01-01,leak-one,leak-two,leak-three,2,2,0,0,0,0,',
        // The worst fit: slug pieces that read as tiers, and a slug landing in builder_effort.
        '2026-01-01,leak-one,1,2,2,2,0,0,0,0,leak-three',
      ),
    });
    const v = view(root);
    assert.equal(v.totals.agent.malformed, 3);
    assert.equal(v.totals.run.malformed, 3);
    assert.equal(v.groups.agent.size, 0);
    assert.equal(v.groups.run.size, 0);
    assert.doesNotMatch(renderView(v), /leak/);
  });

  it('a value outside ^[a-z0-9.-]+$ makes the row malformed, in every printed column', () => {
    const bad = ['Opus', 'opus high', 'a/b', 'a_b', 'é', '<x>', '123', '-'];
    for (const value of bad) {
      const root = newRoot();
      addProject(root, 'alpha', {
        agent: lines(
          AGENT_NEW,
          agentRow({ reviewer: value }),
          agentRow({ model: value }),
          agentRow({ effort: value }),
          agentRow({ tier: value }),
        ),
        run: lines(RUN_NEW, runRow({ builder_model: value }), runRow({ builder_effort: value })),
        drill: lines(DRILL, drillRow({ reviewer: value }), drillRow({ model: value }), drillRow({ effort: value })),
      });
      const v = view(root);
      assert.deepEqual([v.totals.agent.malformed, v.totals.run.malformed, v.totals.drill.malformed], [4, 2, 3], value);
      assert.equal(v.groups.agent.size + v.groups.run.size + v.groups.drill.size, 0, value);
    }
  });

  it('a count or tier that is not one makes the row malformed, not NaN and not 0', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      agent: lines(
        AGENT_NEW,
        agentRow({ findings: '' }),
        agentRow({ accepted: 'x' }),
        agentRow({ rejected: '-1' }),
        agentRow({ duplicate: '1.5' }),
        agentRow({ tier: '4' }),
        agentRow({ tier: '' }),
        agentRow({ date: 'yesterday' }),
      ),
      run: lines(
        RUN_NEW,
        runRow({ final_tier: 'x' }),
        runRow({ builder_retries: '' }),
        runRow({ checks_failures: 'x' }),
        runRow({ fix_rounds: 'x' }),
        runRow({ owner_stops: 'x' }),
      ),
      drill: lines(
        DRILL,
        drillRow({ kind: 'other' }),
        drillRow({ case: '' }),
        drillRow({ batch: '' }),
        drillRow({ batch_cases: '0' }),
        drillRow({ batch_cases: 'x' }),
        drillRow({ planted: 'x' }),
        drillRow({ caught: 'x' }),
        drillRow({ caught: '3', planted: '2' }),
        drillRow({ other_findings: '' }),
        drillRow({ malformed: '' }),
        drillRow({ caught: '', other_findings: 'x' }),
        drillRow({ caught: '', malformed: 'x' }),
      ),
    });
    const v = view(root);
    assert.deepEqual(v.totals.agent, { rows: 7, noModel: 0, malformed: 7, grouped: 0, noLedger: 0 });
    assert.deepEqual(v.totals.run, { rows: 5, noModel: 0, malformed: 5, grouped: 0, noLedger: 0 });
    assert.deepEqual(v.totals.drill, { rows: 12, noModel: 0, malformed: 12, grouped: 0, noLedger: 0 });
  });

  it('a repeated header in the middle of a file is malformed, not a row with no model', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, AGENT_OLD, AGENT_NEW, agentRow()) });
    const t = view(root).totals.agent;
    assert.deepEqual(t, { rows: 3, noModel: 0, malformed: 2, grouped: 1, noLedger: 0 });
  });
});

describe('missing or unusable ledgers', () => {
  it('a ledger that is not there is "no ledger", not zero', () => {
    const root = newRoot();
    addProject(root, 'alpha');
    const v = view(root);
    assert.deepEqual(v.projects[0].status, { agent: 'no ledger', run: 'no ledger', drill: 'no ledger' });
    assert.equal(v.totals.agent.noLedger, 1);
    assert.equal(v.totals.agent.rows, 0);
    const out = renderView(v);
    assert.match(out, /alpha: class A; agent no ledger; run no ledger; drill no ledger/);
    assert.match(out, /agent: rows 0, .* no ledger 1/);
  });

  it('a header-only ledger is ok with 0 rows, which reads differently from no ledger', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW) });
    const v = view(root);
    assert.equal(v.projects[0].status.agent, 'ok');
    assert.equal(v.totals.agent.noLedger, 0);
  });

  it('a file with no known header is not read: every line is counted and excluded', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      // Data from line 1: the columns would be a guess.
      agent: lines(agentRow(), agentRow()),
      run: lines('date,slug,something,else', runRow()),
      drill: '',
    });
    const v = view(root);
    assert.deepEqual(v.projects[0].status, { agent: 'no header', run: 'no header', drill: 'no header' });
    assert.deepEqual(v.totals.agent, { rows: 2, noModel: 0, malformed: 2, grouped: 0, noLedger: 0 });
    assert.deepEqual(v.totals.run, { rows: 2, noModel: 0, malformed: 2, grouped: 0, noLedger: 0 });
    assert.deepEqual(v.totals.drill, { rows: 0, noModel: 0, malformed: 0, grouped: 0, noLedger: 0 });
    assert.equal(v.groups.agent.size, 0);
  });

  it('a profile with no ledger paths says so, and the project still counts', () => {
    const root = newRoot();
    write(join(root, 'alpha', 'docs', 'agents.md'), '# Profile\n');
    const v = view(root);
    assert.equal(v.projects.length, 1);
    assert.equal(v.projects[0].cls, 'unknown');
    assert.deepEqual(v.projects[0].status, {
      agent: 'no ledger path',
      run: 'no ledger path',
      drill: 'no ledger path',
    });
    assert.equal(v.totals.agent.noLedger, 1);
  });

  it('a ledger that is a folder is unreadable, not a crash', () => {
    const root = newRoot();
    addProject(root, 'alpha');
    mkdirSync(join(root, 'alpha', 'vault', 'ops', 'agent-ledger.csv'), { recursive: true });
    const v = view(root);
    assert.equal(v.projects[0].status.agent, 'unreadable');
    assert.equal(readLedger(join(root, 'alpha', 'vault', 'ops', 'agent-ledger.csv'), 'agent').rows.length, 0);
  });
});

describe('groups', () => {
  it('never merges across reviewer, model, effort, tier or class', () => {
    const root = newRoot();
    const base = agentRow();
    addProject(root, 'alpha', {
      agent: lines(
        AGENT_NEW,
        base,
        base,
        agentRow({ reviewer: 'code-reviewer-light' }),
        agentRow({ model: 'sonnet' }),
        agentRow({ effort: 'xhigh' }),
        agentRow({ tier: '3' }),
      ),
    });
    addProject(root, 'beta', { cls: 'B (why): text', agent: lines(AGENT_NEW, base) });
    const v = view(root);
    const keys = groupList(v.groups.agent).map((g) => g.keyParts.join(' '));
    assert.deepEqual(keys.sort(), [
      'A code-reviewer opus high 2',
      'A code-reviewer opus high 3',
      'A code-reviewer opus xhigh 2',
      'A code-reviewer sonnet high 2',
      'A code-reviewer-light opus high 2',
      'B code-reviewer opus high 2',
    ]);
    const twice = groupList(v.groups.agent).find((g) => g.keyParts.join(' ') === 'A code-reviewer opus high 2');
    assert.equal(twice.counts.runs, 2);
  });

  it('adds the same class from two projects, and keeps an unknown class apart', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, agentRow()) });
    addProject(root, 'beta', { agent: lines(AGENT_NEW, agentRow()) });
    addProject(root, 'gamma', { cls: 'Maybe A', agent: lines(AGENT_NEW, agentRow()) });
    const v = view(root);
    const byClass = Object.fromEntries(groupList(v.groups.agent).map((g) => [g.keyParts[0], g.counts.runs]));
    assert.deepEqual(byClass, { A: 2, unknown: 1 });
    assert.deepEqual(v.classes, { A: 2, B: 0, C: 0, unknown: 1 });
  });

  it('never merges drill groups or task groups either', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      run: lines(RUN_NEW, runRow(), runRow({ builder_effort: 'high' }), runRow({ tier: '1', final_tier: '1' })),
      drill: lines(DRILL, drillRow(), drillRow({ model: 'model-y-1' }), drillRow({ tier: '1' })),
    });
    const v = view(root);
    assert.equal(v.groups.run.size, 3);
    assert.equal(v.groups.drill.size, 3);
  });

  it('a blank effort beside a model is its own unknown group, never merged into another', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      agent: lines(AGENT_NEW, agentRow(), agentRow({ effort: '' })),
      run: lines(RUN_NEW, runRow({ builder_effort: '' })),
      drill: lines(DRILL, drillRow({ effort: '' })),
    });
    const v = view(root);
    const keys = groupList(v.groups.agent).map((g) => g.keyParts[3]);
    assert.deepEqual(keys.sort(), ['high', 'unknown']);
    assert.equal(groupList(v.groups.run)[0].keyParts[2], 'unknown');
    assert.equal(groupList(v.groups.drill)[0].keyParts[3], 'unknown');
  });
});

describe('too few', () => {
  const rowsOf = (n, make) => Array.from({ length: n }, () => make());

  it('the constants are the stated ones', () => {
    assert.equal(MIN_RUNS, 10);
    assert.equal(MIN_PLANTED, 10);
  });

  it('marks 9 runs and not 10, for reviews and tasks', () => {
    for (const [n, marked] of [
      [9, true],
      [10, false],
    ]) {
      const root = newRoot();
      addProject(root, 'alpha', {
        agent: lines(AGENT_NEW, ...rowsOf(n, () => agentRow())),
        run: lines(RUN_NEW, ...rowsOf(n, () => runRow())),
      });
      const out = renderView(view(root));
      const reviewLine = out.split('\n').find((l) => l.startsWith('  A code-reviewer opus high tier 2:'));
      const taskLine = out.split('\n').find((l) => l.startsWith('  A sonnet medium tier 2:'));
      assert.equal(reviewLine.includes('(too few)'), marked, `reviews at ${n}`);
      assert.equal(taskLine.includes('(too few)'), marked, `tasks at ${n}`);
    }
  });

  it('marks drills by planted bugs, not rows: 9 bugs yes, 10 bugs no', () => {
    for (const [bugs, marked] of [
      [9, true],
      [10, false],
    ]) {
      const root = newRoot();
      addProject(root, 'alpha', { drill: lines(DRILL, drillRow({ planted: String(bugs) })) });
      const line = renderView(view(root))
        .split('\n')
        .find((l) => l.startsWith('  A code-reviewer model-x-1 high tier 2:'));
      assert.equal(line.includes('(too few)'), marked, `at ${bugs} bugs`);
    }
  });

  it('unscored rows do not lift a drill group over the line', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      drill: lines(DRILL, drillRow({ planted: '5' }), drillRow({ planted: '5', caught: '', other_findings: '', malformed: '' })),
    });
    const line = renderView(view(root))
      .split('\n')
      .find((l) => l.startsWith('  A code-reviewer model-x-1 high tier 2:'));
    assert.match(line, /planted 5,/);
    assert.match(line, /\(too few\)/);
  });
});

describe('drill rows', () => {
  it('a blank caught is unknown: it adds nothing to planted or caught', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      drill: lines(
        DRILL,
        drillRow({ planted: '2', caught: '1', other_findings: '3', malformed: '1' }),
        drillRow({ planted: '2', caught: '0', other_findings: '4', malformed: '0' }),
        drillRow({ planted: '7', caught: '', other_findings: '', malformed: '' }),
        drillRow({ planted: '7', caught: '', other_findings: '9', malformed: '9' }),
      ),
    });
    const v = view(root);
    const [group] = groupList(v.groups.drill);
    assert.deepEqual(group.counts, {
      rows: 4,
      scored: 2,
      unscored: 2,
      planted: 4,
      caught: 1,
      other: 7,
      malformed: 1,
    });
  });

  it('a row with no model is counted, excluded, and not scored', () => {
    const root = newRoot();
    addProject(root, 'alpha', {
      drill: lines(DRILL, drillRow({ model: '', caught: '', other_findings: '', malformed: '' }), drillRow()),
    });
    const v = view(root);
    assert.equal(v.totals.drill.noModel, 1);
    const out = renderView(v);
    assert.match(out, /drill: rows 2, no model 1, malformed 0, grouped 1, groups 1, no ledger 0, scored 1, unscored 1/);
  });

  it('finds the drill ledger beside the agent ledger, with no line for it in the profile', () => {
    const root = newRoot();
    const dir = addProject(root, 'alpha', { drill: lines(DRILL, drillRow()) });
    assert.doesNotMatch(readFileSync(join(dir, 'docs', 'agents.md'), 'utf8'), /drill/);
    assert.equal(view(root).projects[0].status.drill, 'ok');
  });
});

describe('which batch speaks for a reviewer', () => {
  const textLine = (out, name) => out.split('\n').find((l) => l.startsWith(`  ${name}:`));

  // The project and its cases must exist before their hashes can go in its own drill ledger. `row`
  // is a row that counts: this text, this context, the case as it stands, the profile's settings.
  function setup(makeRows, { cases = ['c01'], extra = {} } = {}) {
    const root = newRoot();
    const agents = agentsDir(root);
    const dir = addProject(root, 'alpha', extra);
    const hashes = Object.fromEntries(cases.map((id) => [id, addCase(dir, id)]));
    const agentHash = hashFor(agents, 'code-reviewer', dir);
    const row = (over = {}) =>
      drillRow({
        case: 'c01',
        agent_text: agentHash,
        case_hash: hashes[over.case ?? 'c01'],
        context_text: contextFor(dir),
        batch_cases: String(Math.max(cases.length, 1)),
        ...over,
      });
    write(join(dir, 'vault', 'ops', 'drill-ledger.csv'), lines(DRILL, ...makeRows(row, agentHash)));
    return { root, agents, dir };
  }
  const outOf = ({ root, agents }) => renderView(buildView({ root, agentsDir: agents }));
  const statusOf = (fixture, name = 'code-reviewer') =>
    textLine(outOf(fixture), `alpha ${name}`).split(': ').slice(1).join(': ');
  const NO_BATCH = 'no batch for current text';
  const BLANK = { caught: '', other_findings: '', malformed: '' };

  it('flags both covered reviewers when the project has no drill ledger', () => {
    const root = newRoot();
    addProject(root, 'alpha');
    const out = renderView(view(root));
    for (const reviewer of DRILLED_REVIEWERS) {
      assert.equal(textLine(out, `alpha ${reviewer}`), `  alpha ${reviewer}: ${NO_BATCH}`);
    }
  });

  it('flags a header-only drill ledger: no row exists yet', () => {
    assert.equal(statusOf(setup(() => [])), NO_BATCH);
  });

  it('with no active case nothing is current, whatever the rows say', () => {
    assert.equal(statusOf(setup((row) => [row({ case_hash: 'x' })], { cases: [] })), NO_BATCH);
  });

  it('is current with a batch for this text, at the profile, covering every active case', () => {
    assert.equal(statusOf(setup((row) => [row()])), 'current, scored 1 of 1');
    const two = setup((row) => [row(), row({ case: 'c02' })], { cases: ['c01', 'c02'] });
    assert.equal(statusOf(two), 'current, scored 2 of 2');
  });

  it('flags a reviewer whose text differs from every batch', () => {
    assert.equal(statusOf(setup((row) => [row({ agent_text: 'stale' })])), NO_BATCH);
  });

  it('judges each reviewer on its own batch', () => {
    const fixture = setup((row, hash) => [
      row(),
      row({ reviewer: 'code-reviewer-light', agent_text: hash, batch: 'batch-two' }),
    ]);
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
    assert.equal(statusOf(fixture, 'code-reviewer-light'), NO_BATCH);
  });

  it('a later batch of another reviewer does not change this reviewer', () => {
    const fixture = setup((row) => [
      row({ batch: 'batch-one' }),
      row({ reviewer: 'code-reviewer-light', agent_text: 'other-text', batch: 'batch-two' }),
    ]);
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
  });

  for (const [what, over] of [
    ['another model', { model: 'model-y-1' }],
    ['another effort', { effort: 'low' }],
    ['a draft text', { agent_text: 'draft-text' }],
    ['a case hash of another time', { case_hash: 'older' }],
    ['no case hash', { case_hash: '' }],
  ]) {
    it(`a later comparison batch with ${what} is ignored: it cannot reopen anything`, () => {
      const fixture = setup((row) => [row({ batch: 'batch-one' }), row({ batch: 'later', ...over })]);
      assert.equal(statusOf(fixture), 'current, scored 1 of 1');
    });
  }

  it('only another model, or only another effort, is no batch', () => {
    assert.equal(statusOf(setup((row) => [row({ model: 'model-y-1' })])), NO_BATCH);
    assert.equal(statusOf(setup((row) => [row({ effort: 'low' })])), NO_BATCH);
  });

  it('a change to the role row in the profile needs a new batch', () => {
    for (const edit of [
      (text) => text.replace('| code-reviewer | model-x | high |', '| code-reviewer | model-y | high |'),
      (text) => text.replace('| code-reviewer | model-x | high |', '| code-reviewer | model-x | low |'),
    ]) {
      const fixture = setup((row) => [row()]);
      assert.equal(statusOf(fixture), 'current, scored 1 of 1');
      const file = join(fixture.dir, 'docs', 'agents.md');
      write(file, edit(readFileSync(file, 'utf8')));
      assert.equal(statusOf(fixture), NO_BATCH);
    }
  });

  it('reads the tier 3 row for a tier 3 row in the ledger, by its reviewer', () => {
    const tier3 = setup((row) => [row({ tier: '3', effort: 'xhigh' })]);
    assert.equal(statusOf(tier3), 'current, scored 1 of 1');
    const roleRow = setup((row) => [row({ tier: '3', effort: 'high' })]);
    assert.equal(statusOf(roleRow), NO_BATCH);
    const tier2 = setup((row) => [row({ tier: '2', effort: 'xhigh' })]);
    assert.equal(statusOf(tier2), NO_BATCH);
  });

  it('a reviewer the tier 3 row does not list keeps its role row', () => {
    const profileText = profile();
    assert.deepEqual(profileModel(profileText, 'code-reviewer', 3), { model: 'model-x', effort: 'xhigh' });
    assert.deepEqual(profileModel(profileText, 'code-reviewer', 2), { model: 'model-x', effort: 'high' });
    assert.deepEqual(profileModel(profileText, 'code-reviewer-light', 3), { model: 'model-x', effort: 'high' });
    assert.equal(profileModel(profileText, 'absent', 3), null);
    assert.equal(profileModel(profileText, 'builder', 2), null);
  });

  it('a model id matches its alias or a longer id, and nothing else', () => {
    assert.equal(modelMatches('claude-opus-9-9', 'opus'), true);
    assert.equal(modelMatches('claude-opus-9-9-20300101', 'claude-opus-9-9'), true);
    assert.equal(modelMatches('claude-opus-9-9', 'sonnet'), false);
    assert.equal(modelMatches('claude-opus-9-10', 'claude-opus-9-1'), false);
  });

  it('skips unscored rows when finding the batch', () => {
    const fixture = setup((row) => [
      row({ batch: 'batch-one' }),
      row({ batch: 'batch-two', ...BLANK }),
    ]);
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
  });

  it('flags a reviewer whose rows are all unscored', () => {
    assert.equal(statusOf(setup((row) => [row(BLANK)])), NO_BATCH);
  });

  it('a malformed row does not count as a scored batch', () => {
    assert.equal(statusOf(setup((row) => [row({ caught: 'x' })])), NO_BATCH);
  });

  it('says a batch that died midway is incomplete, against the active cases', () => {
    const fixture = setup(
      (row) => [row({ batch_cases: '3' }), row({ batch_cases: '3', case: 'c02', ...BLANK })],
      { cases: ['c01', 'c02', 'c03'] },
    );
    assert.equal(statusOf(fixture), 'batch incomplete, scored 1 of 3');
  });

  it('a case scored twice does not fill a batch', () => {
    const fixture = setup((row) => [row({ batch_cases: '2' }), row({ batch_cases: '2' })], {
      cases: ['c01', 'c02'],
    });
    assert.equal(statusOf(fixture), 'batch incomplete, scored 1 of 2');
  });

  it('a --case run, batch_cases 1, cannot make a reviewer of two cases current', () => {
    const fixture = setup((row) => [row({ batch_cases: '1' })], { cases: ['c01', 'c02'] });
    assert.equal(statusOf(fixture), 'batch incomplete, scored 1 of 2');
    const afterFull = setup(
      (row) => [row(), row({ case: 'c02' }), row({ batch: 'one-case', batch_cases: '1' })],
      { cases: ['c01', 'c02'] },
    );
    assert.equal(statusOf(afterFull), 'current, scored 2 of 2');
  });

  it('two --case runs under one batch name do not add up to a batch', () => {
    const fixture = setup(
      (row) => [row({ batch_cases: '1' }), row({ case: 'c02', batch_cases: '1' })],
      { cases: ['c01', 'c02'] },
    );
    assert.equal(statusOf(fixture), 'batch incomplete, scored 2 of 2');
    // A row with no number there is malformed before it gets this far.
    assert.equal(statusOf(setup((row) => [row({ batch_cases: '' })])), NO_BATCH);
  });

  it('a --case run is a whole batch for a reviewer with that one case', () => {
    assert.equal(statusOf(setup((row) => [row({ batch_cases: '1' })])), 'current, scored 1 of 1');
  });

  it('the latest batch speaks, in both directions', () => {
    // Two whole batches: the context line reads from the later one.
    const fixture = setup((row) => [
      row({ batch: 'older', date: '2026-01-01', context_text: 'context-then' }),
      row({ batch: 'newer', date: '2026-02-02' }),
    ]);
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
    assert.ok(!outOf(fixture).includes('context changed'));
    const reversed = setup((row) => [
      row({ batch: 'older', date: '2026-01-01' }),
      row({ batch: 'newer', date: '2026-02-02', context_text: 'context-then' }),
    ]);
    assert.ok(outOf(reversed).includes('context changed since the batch of 2026-02-02'));
    // No whole batch: the count is the later one's.
    const partial = setup(
      (row) => [
        row({ batch: 'older', case: 'c01' }),
        row({ batch: 'newer', case: 'c01' }),
        row({ batch: 'newer', case: 'c02' }),
      ],
      { cases: ['c01', 'c02', 'c03'] },
    );
    assert.equal(statusOf(partial), 'batch incomplete, scored 2 of 3');
  });

  describe('a resumed batch', () => {
    const totalsOf = (fixture) => buildView({ root: fixture.root, agentsDir: fixture.agents });

    it('a blank that later scored is one case, not two, and fills the batch', () => {
      const fixture = setup(
        (row) => [
          row({ case: 'c01' }),
          row({ case: 'c02', ...BLANK }),
          row({ case: 'c02', caught: '2' }),
        ],
        { cases: ['c01', 'c02'] },
      );
      assert.equal(statusOf(fixture), 'current, scored 2 of 2');
      const v = totalsOf(fixture);
      const counts = groupList(v.groups.drill).map((g) => g.counts);
      assert.deepEqual(counts, [
        { rows: 2, scored: 2, unscored: 0, planted: 4, caught: 3, other: 6, malformed: 0 },
      ]);
      assert.equal(v.totals.drill.rows, 2);
      assert.equal(v.supersededDrillRows, 1);
      assert.match(renderView(v), /drill: rows 2, .*scored 2, unscored 0, superseded 1/);
    });

    it('still blank: the batch stays incomplete', () => {
      const fixture = setup(
        (row) => [row({ case: 'c01' }), row({ case: 'c02', ...BLANK }), row({ case: 'c02', ...BLANK })],
        { cases: ['c01', 'c02'] },
      );
      assert.equal(statusOf(fixture), 'batch incomplete, scored 1 of 2');
      assert.equal(totalsOf(fixture).supersededDrillRows, 1);
    });

    it('the latest row speaks: a blank after a score leaves the case open', () => {
      const fixture = setup((row) => [row({ case: 'c01' }), row({ case: 'c01', ...BLANK })]);
      assert.equal(statusOf(fixture), NO_BATCH);
    });

    it('a blank with no model after a score leaves the case open too', () => {
      const fixture = setup((row) => [row({ case: 'c01' }), row({ case: 'c01', ...BLANK, model: '' })]);
      assert.equal(statusOf(fixture), NO_BATCH);
    });

    it('rows of one case in two batches are two rows', () => {
      const fixture = setup((row) => [row({ batch: 'one' }), row({ batch: 'two' })]);
      assert.equal(totalsOf(fixture).totals.drill.rows, 2);
      assert.equal(totalsOf(fixture).supersededDrillRows, 0);
    });

    it('nothing superseded prints 0, and rows with no batch or case replace nothing', () => {
      assert.match(renderView(totalsOf(setup((row) => [row()]))), /superseded 0/);
      const kept = latestPerCase([
        { batch: '', case: 'a' },
        { batch: '', case: 'a' },
        { batch: 'b', case: '' },
        { batch: 'b', case: '' },
      ]);
      assert.equal(kept.length, 4);
    });

    it('keeps file order by the rows that remain', () => {
      const order = latestPerCase([
        { batch: 'x', case: 'a', n: 1 },
        { batch: 'x', case: 'b', n: 2 },
        { batch: 'x', case: 'a', n: 3 },
      ]);
      assert.deepEqual(order.map((r) => r.n), [2, 3]);
    });
  });

  it("a row with this reviewer's text under another reviewer's name does not count", () => {
    assert.equal(statusOf(setup((row) => [row({ reviewer: 'code-reviewer-light' })])), NO_BATCH);
  });

  it('each reviewer is judged on its own cases, whatever else the batch planned', () => {
    const fixture = setup(
      (row) => [row({ batch_cases: '2' }), row({ batch_cases: '2', case: 'c02', reviewer: 'code-reviewer-light' })],
      { cases: ['c01'] },
    );
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
  });

  it('a retired case is not needed; a new or changed case reopens it', () => {
    const fixture = setup((row) => [row()], { cases: ['c01'] });
    addCase(fixture.dir, 'gone', { retired: '2026-01-01' });
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
    addCase(fixture.dir, 'c02');
    assert.equal(statusOf(fixture), 'batch incomplete, scored 1 of 2');

    const changed = setup((row) => [row()], { cases: ['c01'] });
    write(join(changed.dir, 'vault', 'ops', 'drills', 'c01', 'spec.md'), 'Reworded.\n');
    assert.equal(statusOf(changed), 'batch incomplete, scored 0 of 1');
  });

  it('a change to any of the case files changes its hash', () => {
    for (const file of ['case.json', 'spec.md', 'planted.patch']) {
      const fixture = setup((row) => [row()], { cases: ['c01'] });
      assert.equal(statusOf(fixture), 'current, scored 1 of 1', file);
      const path = join(fixture.dir, 'vault', 'ops', 'drills', 'c01', file);
      // Still valid JSON with a trailing space, so the case stays readable and only its hash moves.
      write(path, `${existsSync(path) ? readFileSync(path, 'utf8') : ''} `);
      assert.equal(statusOf(fixture), 'batch incomplete, scored 0 of 1', file);
    }
  });

  it("another reviewer's case does not count against this reviewer", () => {
    const fixture = setup((row) => [row()], { cases: ['c01'] });
    addCase(fixture.dir, 'l01', { reviewer: 'code-reviewer-light' });
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
  });

  it('a case it cannot read keeps every reviewer from reading as covered', () => {
    const fixture = setup((row) => [row()]);
    write(join(fixture.dir, 'vault', 'ops', 'drills', 'broken', 'case.json'), '{ not json');
    assert.equal(statusOf(fixture), 'batch incomplete, scored 1 of 2');
  });

  it('an edit to the agent file flags the reviewer', () => {
    const fixture = setup((row) => [row()]);
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
    write(join(fixture.agents, 'code-reviewer.md'), 'edited\n');
    assert.equal(statusOf(fixture), NO_BATCH);
  });

  describe('the context around the text', () => {
    const info = (out) => out.split('\n').filter((l) => l.includes('context changed'));

    it('unchanged: no line', () => {
      assert.deepEqual(info(outOf(setup((row) => [row()]))), []);
    });

    for (const [what, edit] of [
      ['the profile', ({ dir }) => write(join(dir, 'docs', 'agents.md'), `${profile()}\nedited\n`)],
      ['CLAUDE.md', ({ dir }) => write(join(dir, 'CLAUDE.md'), 'edited\n')],
      ['a missing CLAUDE.md', ({ dir }) => rmSync(join(dir, 'CLAUDE.md'))],
    ]) {
      it(`${what}: one information line, and the reviewer stays current`, () => {
        const fixture = setup((row) => [row({ date: '2026-03-04' })]);
        edit(fixture);
        const out = outOf(fixture);
        assert.equal(statusOf(fixture), 'current, scored 1 of 1');
        assert.deepEqual(info(out), [
          '  alpha code-reviewer: context changed since the batch of 2026-03-04',
        ]);
        assert.doesNotMatch(out, /batch-one/);
      });
    }

    it('the global rules file counts when present, read through the home folder', () => {
      const fixture = setup((row) => [row({ date: '2026-03-04' })]);
      const home = join(fixture.root, '.home');
      const run = () =>
        spawnSync(
          process.execPath,
          [SCRIPT, '--root', fixture.root, '--agents-dir', fixture.agents],
          { encoding: 'utf8', env: { ...process.env, HOME: home } },
        ).stdout;
      assert.doesNotMatch(run(), /context changed/);
      write(join(home, '.claude', 'CLAUDE.md'), 'global rules\n');
      const out = run();
      assert.match(out, /alpha code-reviewer: context changed since the batch of 2026-03-04/);
      assert.match(out, /alpha code-reviewer: current, scored 1 of 1/);
      assert.doesNotMatch(out, /global rules/);
    });

    it('no line beside a reviewer with no batch: it is already open for its own reason', () => {
      const fixture = setup((row) => [row({ agent_text: 'stale', context_text: 'other' })]);
      assert.deepEqual(info(outOf(fixture)), []);
    });
  });

  it('flags a drilled reviewer with no agent file, reading no path outside the agents folder', () => {
    const fixture = setup((row, hash) => [
      row({ reviewer: 'other-reviewer', agent_text: hash }),
    ]);
    addCase(fixture.dir, 'o01', { reviewer: 'other-reviewer' });
    assert.equal(statusOf(fixture, 'other-reviewer'), NO_BATCH);
  });

  it('the hash covers each part apart: bytes moved between parts change it', () => {
    assert.notEqual(hashParts(['ab', 'c', 'd']), hashParts(['a', 'bc', 'd']));
    assert.match(hashParts(['a', 'b', 'c']), /^[0-9a-f]{16}$/);
  });

  it('agent_text hashes the agent file and the domain checklist, nothing else', () => {
    const fixture = setup((row) => [row()]);
    const file = join(fixture.dir, 'docs', 'agents.md');
    const text = readFileSync(file, 'utf8');
    assert.equal(
      hashFor(fixture.agents, 'code-reviewer', fixture.dir),
      hashParts([
        readFileSync(join(fixture.agents, 'code-reviewer.md')),
        '- First check: a made-up rule.\n- Second check: another one.',
      ]),
    );
    write(join(fixture.dir, 'CLAUDE.md'), 'edited\n');
    write(file, `${text}\nedited\n`);
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
    // Elsewhere in the profile, and blank lines around the checklist: the same.
    write(file, text.replace('## Domain checklist\n', '## Domain checklist\n\n\n'));
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
  });

  it('deleting one domain checklist item needs a new batch, even the only one', () => {
    for (const [what, edit] of [
      ['one of two', (t) => t.replace('- Second check: another one.\n', '')],
      ['reworded', (t) => t.replace('a made-up rule', 'a made-up duty')],
      [
        'the only one',
        (t) => t.replace('- First check: a made-up rule.\n- Second check: another one.\n', ''),
      ],
      ['a new item', (t) => t.replace('## Models', '- Third check: more.\n\n## Models')],
      ['the whole section', (t) => t.replace(/## Domain checklist[\s\S]*?(?=## Models)/, '')],
    ]) {
      const fixture = setup((row) => [row()]);
      const file = join(fixture.dir, 'docs', 'agents.md');
      assert.equal(statusOf(fixture), 'current, scored 1 of 1', what);
      write(file, edit(readFileSync(file, 'utf8')));
      assert.equal(statusOf(fixture), NO_BATCH, what);
    }
  });

  it('a profile with no domain checklist is handled: a hash, stable, and a batch can match it', () => {
    const noList = '# Profile\n\n## Risk class\n\nA\n';
    assert.equal(domainChecklist(noList), '');
    assert.equal(domainChecklist(''), '');
    assert.equal(agentTextHash('text', noList), hashParts(['text', '']));
    assert.equal(agentTextHash('text', noList), agentTextHash(Buffer.from('text'), Buffer.from(noList)));
    assert.notEqual(agentTextHash('text', noList), agentTextHash('text', profile()));

    const fixture = setup((row) => [row()]);
    const file = join(fixture.dir, 'docs', 'agents.md');
    const text = readFileSync(file, 'utf8').replace(/## Domain checklist[\s\S]*?(?=## Models)/, '');
    write(file, text);
    const hash = hashFor(fixture.agents, 'code-reviewer', fixture.dir);
    assert.equal(hash, hashParts([readFileSync(join(fixture.agents, 'code-reviewer.md')), '']));
    const ledger = join(fixture.dir, 'vault', 'ops', 'drill-ledger.csv');
    write(
      ledger,
      lines(
        DRILL,
        drillRow({
          case: 'c01',
          agent_text: hash,
          case_hash: caseHash(join(fixture.dir, 'vault', 'ops', 'drills', 'c01')),
          context_text: contextFor(fixture.dir),
        }),
      ),
    );
    assert.equal(statusOf(fixture), 'current, scored 1 of 1');
  });

  it('only that section is read: not a deeper heading, not a look-alike, and every section of that name', () => {
    const text = [
      '## Domain checklist',
      '- one',
      '### a deeper heading stays inside',
      '- two',
      '## Domain checklist extra',
      '- not this',
      '# Top',
      '- nor this',
      '## Domain checklist',
      '- three',
      '',
    ].join('\r\n');
    assert.equal(domainChecklist(text), '- one\n### a deeper heading stays inside\n- two\n- three');
    assert.equal(domainChecklist('## Domain checklist\n- one\n# Top\n- not this\n'), '- one');
  });
});

describe('output', () => {
  // Every kind of private text a ledger or profile holds, in the columns that hold it.
  function leakFixture() {
    const root = newRoot();
    const agents = agentsDir(root);
    const dir = addProject(root, 'alpha', {
      cls: 'A (sentinelreason): sentinelprofiletext',
      claude: 'sentinelclaudetext\n',
      agent: lines(
        AGENT_NEW,
        '2026-01-01,sentinel-old-slug,2,code-reviewer,5,3,1,1',
        agentRow({ slug: 'sentinel-slug' }),
        agentRow({ slug: 'sentinel-slug', model: 'SentinelModel' }),
        agentRow({ slug: 'sentinel-slug', reviewer: 'Sentinel Reviewer' }),
        '2026-01-01,sentinel-comma,sentinel-comma,2,code-reviewer,5,3,1,1',
        '2026-01-01,sentinel-comma,sentinel-comma,sentinel-comma,2,code-reviewer,5,3,1,1',
      ),
      run: lines(
        RUN_NEW,
        '2026-01-01,sentinel-old-slug,2,2,0,0,0,0,sentinel-escape',
        runRow({ slug: 'sentinel-slug', escape_of: 'sentinel-escape' }),
        runRow({ slug: 'sentinel-slug', builder_effort: 'Sentinel Effort' }),
      ),
    });
    write(
      join(dir, 'vault', 'ops', 'drill-ledger.csv'),
      lines(
        DRILL,
        drillRow({
          case: 'sentinel-case',
          batch: 'sentinel-batch',
          agent_text: hashFor(agents, 'code-reviewer', dir),
          case_hash: addCase(dir, 'sentinel-case', { what: 'sentinel-key-text' }),
          context_text: 'sentinel-context',
          kind: 'planted',
        }),
        drillRow({ case: 'sentinel-other', batch: 'sentinel-batch', caught: '' }),
      ),
    );
    return { root, agents, dir };
  }

  it('holds no slug, case, batch, hash or file text', () => {
    const { root, agents, dir } = leakFixture();
    const out = renderView(buildView({ root, agentsDir: agents }));
    assert.doesNotMatch(out, /sentinel/i);
    assert.equal(out.includes(hashFor(agents, 'code-reviewer', dir)), false, 'no hash printed');
    assert.equal(out.includes(contextFor(dir)), false, 'no context hash printed');
    assert.match(out, /context changed since the batch of \d{4}-\d{2}-\d{2}/);
    assert.equal(out.includes(root), false, 'no root path printed');
    // The rows did reach the view, so the absence above is not an empty run.
    assert.match(out, /agent: rows 6, no model 1, malformed 4, grouped 1/);
    assert.match(out, /run: rows 3, no model 1, malformed 1, grouped 1/);
    assert.match(out, /escapes 1/);
    assert.match(out, /drill: rows 2, no model 0, malformed 0, grouped 2/);
  });

  it('every word in a group line is a known word, a count or a value that matches the rule', () => {
    const { root, agents } = leakFixture();
    const out = renderView(buildView({ root, agentsDir: agents }));
    const groupLinesOnly = out.split('\n').filter((l) => /^ {2}(A|B|C|unknown) /.test(l));
    assert.ok(groupLinesOnly.length >= 3);
    for (const line of groupLinesOnly) {
      const [names] = line.trim().split(':');
      for (const word of names.split(' ')) assert.match(word, /^[A-Za-z0-9.-]+$/, line);
    }
  });

  it('labels acceptance hint only and drills as the basis for model comparison', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, agentRow()) });
    const out = renderView(view(root));
    assert.match(out, /Reviews by class[^\n]*hint only/);
    assert.match(out, /Drills by class[^\n]*basis for model comparison/);
    assert.match(out, /under 10 runs, or under 10 planted bugs for drills/);
  });

  it('a group with a value that fails the rule has no line at all', () => {
    const root = newRoot();
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, agentRow({ model: 'Bad Value' })) });
    const out = renderView(view(root));
    assert.doesNotMatch(out, /Bad Value/);
    assert.match(out, /Reviews by class[^\n]*\n {2}none/);
  });

  it('gives a project folder with an unprintable name a number', () => {
    const root = newRoot();
    addProject(root, 'Private Name', { agent: lines(AGENT_NEW, agentRow()) });
    const out = renderView(view(root));
    assert.doesNotMatch(out, /Private Name/);
    assert.match(out, /project-1: class A/);
    assert.match(out, /project-1 code-reviewer: no batch for current text/);
  });

  it('counts the classes of the projects found', () => {
    const root = newRoot();
    addProject(root, 'alpha');
    addProject(root, 'beta', { cls: 'B (why): text' });
    addProject(root, 'gamma', { cls: 'nonsense' });
    assert.match(renderView(view(root)), /Projects: 3 \(class A 1, class B 1, class C 0, unknown 1\)/);
  });
});

describe('read-only', () => {
  function digestTree(dir) {
    const hash = createHash('sha256');
    const walk = (d) => {
      for (const name of readdirSync(d).sort()) {
        const path = join(d, name);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        hash.update(`${path}:${stat.mtimeMs}\n`);
        if (stat.isDirectory()) walk(path);
        else hash.update(readFileSync(path));
      }
    };
    walk(dir);
    return hash.digest('hex');
  }

  it('leaves the root unchanged', () => {
    const root = newRoot();
    const agents = agentsDir(root);
    addProject(root, 'alpha', {
      agent: lines(AGENT_NEW, agentRow()),
      run: lines(RUN_NEW, runRow()),
      drill: lines(DRILL, drillRow()),
    });
    const before = digestTree(root);
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--agents-dir', agents], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(digestTree(root), before);
  });
});

describe('command line', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('prints the view and exits 0, with malformed rows counted rather than fatal', () => {
    const root = newRoot();
    const agents = agentsDir(root);
    addProject(root, 'alpha', { agent: lines(AGENT_NEW, 'bad,row') });
    const result = run('--root', root, '--agents-dir', agents);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Projects: 1/);
    assert.match(result.stdout, /malformed 1/);
  });

  it('exits 1 on a root with no project, so a wrong root is not a clean empty view', () => {
    const result = run('--root', newRoot());
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no project under the root/);
  });

  it('exits 1 on a root that is missing or a file', () => {
    const root = newRoot();
    assert.equal(run('--root', join(root, 'nothing')).status, 1);
    write(join(root, 'file.txt'), 'x\n');
    assert.equal(run('--root', join(root, 'file.txt')).status, 1);
  });

  it('exits 1 on an unknown option or a missing value', () => {
    assert.equal(run('--nope').status, 1);
    assert.equal(run('--root').status, 1);
    assert.equal(run('--agents-dir').status, 1);
  });

  it('defaults to the parent of this repo and its agents folder', () => {
    assert.equal(DEFAULT_ROOT, resolve(REPO, '..'));
    assert.equal(DEFAULT_AGENTS_DIR, join(REPO, 'claude', 'agents'));
  });
});

describe('templates', () => {
  const ops = join(REPO, 'templates', 'private', 'ops');

  for (const [kind, file] of [
    ['agent', 'agent-ledger.csv'],
    ['run', 'run-ledger.csv'],
    ['drill', 'drill-ledger.csv'],
  ]) {
    it(`${file} holds only the new header, read as ok with 0 rows`, () => {
      assert.equal(readFileSync(join(ops, file), 'utf8'), `${HEADERS[kind].new.join(',')}\n`);
      assert.deepEqual(readLedger(join(ops, file), kind), { status: 'ok', rows: [], unreadLines: 0 });
    });
  }

  it('process-reviewed.txt is there and empty: a new project has looked at nothing', () => {
    assert.equal(
      readFileSync(join(REPO, 'templates', 'private', 'ops', 'process-reviewed.txt'), 'utf8'),
      '',
    );
  });

  it('the ledger columns only add at the end, as the design says', () => {
    assert.deepEqual(HEADERS.agent.new.slice(-2), ['model', 'effort']);
    assert.deepEqual(HEADERS.agent.new.slice(0, HEADERS.agent.old.length), HEADERS.agent.old);
    assert.deepEqual(HEADERS.run.new.slice(-2), ['builder_model', 'builder_effort']);
    assert.deepEqual(HEADERS.run.new.slice(0, HEADERS.run.old.length), HEADERS.run.old);
    assert.deepEqual(HEADERS.drill.new.slice(0, 10), [
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
    ]);
    assert.deepEqual(HEADERS.drill.new.slice(10), [
      'batch',
      'batch_cases',
      'agent_text',
      'malformed',
      'context_text',
      'case_hash',
    ]);
  });

  it('the template profile reads as an unknown class, with its ledger paths found', () => {
    const text = readFileSync(join(REPO, 'templates', 'docs', 'agents.md'), 'utf8');
    assert.equal(parseRiskClass(text), 'unknown');
    assert.deepEqual(parseLedgerPaths(text), {
      agent: 'private/ops/agent-ledger.csv',
      run: 'private/ops/run-ledger.csv',
    });
  });
});
