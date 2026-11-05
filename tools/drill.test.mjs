// Tests for the review measurement runner. Synthetic repos and a fake `claude` only: no live calls.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentsJson,
  anchorOf,
  appendRow,
  batchSummary,
  buildPrompt,
  caseProblems,
  checkBoundary,
  checkClone,
  compareBatches,
  createWorkspace,
  endsWithBiggestWin,
  installCommand,
  LEDGER_COLUMNS,
  MAX_WINDOW_LINES,
  neutralProblems,
  parseAgentFile,
  parseChecks,
  parseDiff,
  parseFindings,
  prepareClone,
  profileModel,
  readLedger,
  removeWorkspace,
  resolveModel,
  reviewerArgs,
  runProbe,
  scoreFindings,
  scoreRun,
  validateCase,
  windowProblems,
} from './drill.mjs';
import { agentTextHash, buildView } from './setup-view.mjs';

const DRILL = join(dirname(fileURLToPath(import.meta.url)), 'drill.mjs');
const TODAY = '2030-01-02';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fx-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const newDir = (name = 'd') => {
  counter += 1;
  const dir = join(scratch, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.invalid',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.invalid',
  // Old on purpose: the reviewer's change commit must carry a later date than the real one.
  GIT_AUTHOR_DATE: '2020-03-04T05:06:07Z',
  GIT_COMMITTER_DATE: '2020-03-04T05:06:07Z',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 1 << 26 }).trim();
const gitStatus = (cwd, ...args) => spawnSync('git', args, { cwd, env: GIT_ENV }).status;

// --- A synthetic project: public repo with a private folder as a gitlink, four commits ---

const BASE_PRICE = `// Price helpers.
export function addTax(amount, rate) {
  return amount * (1 + rate);
}
`;
const BUGGY_LINE = '  return Math.floor(value * 100) / 100;';
const KNOWN_LINE =
  '  const known = rates.filter((r) => r.date <= asOf); // only rows already published';
const BUGGY_PRICE = `${BASE_PRICE}
export function roundCents(value) {
  // Cents for the invoice line.
${BUGGY_LINE}
}

export function knownRates(rates, asOf) {
${KNOWN_LINE}
  return known.at(-1) ?? null;
}
`;
const FIX_LINE =
  '  return Math.round((value + Number.EPSILON) * 100) / 100; // half up, as on the invoice';
const FIXED_PRICE = BUGGY_PRICE.replace(BUGGY_LINE, FIX_LINE);
const PLANTED_LINE = '  const known = rates;';
const WHAT = 'Cents are truncated, so totals drift below the invoice amount';
const SPEC = '# Spec\n\nAdd helpers for rounding money and reading rates.\n';
const PROFILE = `# Agent profile

## Models and efforts

| Role | Model | Effort | Note |
|---|---|---|---|
| code-reviewer | opus | high | |
| code-reviewer-light | sonnet | medium | |
| Tier 3: builder-heavy, code-reviewer | opus | xhigh | |
`;
const CHECK_SCRIPT = `import { readFileSync } from 'node:fs';
process.exit(readFileSync('src/price.mjs', 'utf8').includes('BREAKS_TESTS') ? 1 : 0);
`;
const AGENT_TEXT = `---
name: code-reviewer
description: Reviews a change: correctness against its spec.
model: opus
effort: high
tools: Read, Glob, Grep, Bash
---

You review one change. End with Biggest win.
`;

function write(dir, file, text) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

function windowOf(text, needle, file = 'src/price.mjs', pad = 1) {
  const at = text.split('\n').findIndex((l) => l.includes(needle)) + 1;
  assert.ok(at > 0, `fixture line not found: ${needle}`);
  const from = Math.max(at - pad, 1);
  const to = at + pad;
  return { file, from, to, anchor: anchorOf(text, from, to) };
}

function makeFixture({
  headProfile = PROFILE,
  headClaude = '# Project rules\n\nToday.\n',
  root = null,
} = {}) {
  const repo = root === null ? newDir('repo') : join(root, 'demo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '-b', 'main', '.');
  const ledgerDir = join(repo, 'vault', 'ops');
  mkdirSync(ledgerDir, { recursive: true });
  write(
    ledgerDir,
    'agent-ledger.csv',
    'date,slug,tier,reviewer,findings,accepted,rejected,duplicate\n',
  );
  git(join(repo, 'vault'), 'init', '--quiet', '-b', 'main', '.');
  git(join(repo, 'vault'), 'add', 'ops/agent-ledger.csv');
  git(join(repo, 'vault'), 'commit', '--quiet', '-m', 'Start');
  const vaultSha = git(join(repo, 'vault'), 'rev-parse', 'HEAD');

  // At base the run folder is not ignored yet, as in an older commit of a real repo.
  write(repo, '.gitignore', 'node_modules/\n');
  write(repo, '.gitmodules', '[submodule "vault"]\n\tpath = vault\n\turl = ./nowhere.git\n');
  write(repo, 'README.md', 'A demo app.\n');
  write(repo, 'CLAUDE.md', '# Project rules\n\nOld.\n');
  write(repo, 'docs/agents.md', '# Old profile\n');
  write(repo, 'check.mjs', CHECK_SCRIPT);
  write(repo, 'src/price.mjs', BASE_PRICE);
  git(
    repo,
    'add',
    '.gitignore',
    '.gitmodules',
    'README.md',
    'CLAUDE.md',
    'docs/agents.md',
    'check.mjs',
    'src/price.mjs',
  );
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${vaultSha},vault`);
  git(repo, 'commit', '--quiet', '-m', 'Start the demo app');
  const base = git(repo, 'rev-parse', 'HEAD');

  write(repo, 'src/price.mjs', BUGGY_PRICE);
  git(repo, 'add', 'src/price.mjs');
  git(repo, 'commit', '--quiet', '-m', 'Add rounding and rate helpers');
  const buggy = git(repo, 'rev-parse', 'HEAD');

  write(repo, 'src/price.mjs', FIXED_PRICE);
  git(repo, 'add', 'src/price.mjs');
  git(repo, 'commit', '--quiet', '-m', 'Review fix: round half up');
  const fix = git(repo, 'rev-parse', 'HEAD');

  write(repo, '.gitignore', '.agent-runs/\nnode_modules/\n');
  write(repo, 'src/later.mjs', 'export const laterWork = "this line only exists in the future";\n');
  write(repo, 'CLAUDE.md', headClaude);
  write(repo, 'docs/agents.md', headProfile);
  git(repo, 'add', '.gitignore', 'src/later.mjs', 'CLAUDE.md', 'docs/agents.md');
  git(repo, 'commit', '--quiet', '-m', 'Later work');
  const future = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', '-a', 'v0', '-m', 'A release');
  git(repo, 'branch', 'side', fix);

  const agentsDir = newDir('agents');
  write(agentsDir, 'code-reviewer.md', AGENT_TEXT);
  write(
    agentsDir,
    'code-reviewer-light.md',
    AGENT_TEXT.replace('name: code-reviewer', 'name: code-reviewer-light'),
  );

  const fx = { repo, ledgerDir, base, buggy, fix, future, agentsDir, vaultSha };
  addReplay(fx, 's01');
  return fx;
}

function replayDef(fx, id, overrides = {}) {
  return {
    id,
    kind: 'replay',
    reviewer: 'code-reviewer',
    tier: 2,
    base: fx.base,
    buggy: fx.buggy,
    fix: fx.fix,
    added: '2030-01-01',
    retired: null,
    checks: 'node check.mjs: pass',
    bugs: [{ id: 'b1', what: WHAT, windows: [windowOf(BUGGY_PRICE, 'Math.floor')] }],
    ...overrides,
  };
}

function writeCase(fx, def, { spec = SPEC, patch = null } = {}) {
  const dir = join(fx.ledgerDir, 'drills', def.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify(def, null, 2));
  writeFileSync(join(dir, 'spec.md'), spec);
  if (patch !== null) writeFileSync(join(dir, 'planted.patch'), patch);
  return dir;
}

function addReplay(fx, id, overrides = {}, files = {}) {
  return writeCase(fx, replayDef(fx, id, overrides), files);
}

// A patch against the buggy tree, made with real git in a side clone.
function makePatch(fx, edit) {
  const side = newDir('side');
  git(side, 'clone', '--quiet', '--no-checkout', fx.repo, 'c');
  const clone = join(side, 'c');
  git(clone, 'checkout', '--quiet', '--detach', fx.buggy);
  write(clone, 'src/price.mjs', edit(BUGGY_PRICE));
  return `${git(clone, 'diff', '--', 'src/price.mjs')}\n`;
}

function addPlanted(fx, id, { edit, needle = PLANTED_LINE, overrides = {} } = {}) {
  const change = edit ?? ((text) => text.replace(KNOWN_LINE, PLANTED_LINE));
  const def = replayDef(fx, id, {
    kind: 'planted',
    fix: null,
    bugs: [
      {
        id: 'b1',
        what: 'Reads rates before they were published',
        windows: [windowOf(change(BUGGY_PRICE), needle)],
      },
    ],
    ...overrides,
  });
  return writeCase(fx, def, { patch: makePatch(fx, change) });
}

// --- The fake `claude`: logs what it was given and returns canned JSON ---

function makeFake() {
  const dir = newDir('fake');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = process.env.FAKE_CLAUDE_DIR;
const prompt = fs.readFileSync(0, 'utf8');
const run = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
const call = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  prompt,
  logAll: run('log', '--all', '--format=%s'),
  status: run('status', '--porcelain'),
  vault: fs.existsSync('vault') ? fs.readdirSync('vault') : null,
  head: run('log', '-1', '--format=%s|%an|%ad', '--date=short'),
  profile: fs.existsSync('docs/agents.md') ? fs.readFileSync('docs/agents.md', 'utf8') : null,
  env: { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, OLDPWD: process.env.OLDPWD },
};
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(call) + '\\n');
const m = /file_path (\\S+)\\/note\\.txt/.exec(prompt);
if (m) {
  const outside = m[1];
  const mode = fs.existsSync(path.join(dir, 'probe.txt')) ? fs.readFileSync(path.join(dir, 'probe.txt'), 'utf8').trim() : 'pass';
  if (mode === 'sleep') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); }
  if (mode === 'crash') { process.stderr.write('cannot reach the service\\n'); process.exit(1); }
  const bash = (command) => ({ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command } });
  let denials = [
    { tool_name: 'Read', tool_use_id: 'x', tool_input: { file_path: outside + '/note.txt' } },
    { tool_name: 'Grep', tool_use_id: 'x', tool_input: { pattern: '.', path: outside } },
    { tool_name: 'Glob', tool_use_id: 'x', tool_input: { pattern: '*', path: outside } },
    bash('git diff --no-index -- ' + outside + '/note.txt README.md'),
    bash('git diff ' + outside + '/note.txt README.md'),
    bash('git -C ' + outside + ' show HEAD:note.txt'),
    bash('cat ' + outside + '/note.txt'),
  ];
  if (mode === 'allowed-by-settings' && fs.existsSync('.claude/settings.json')) denials = [];
  if (mode === 'skip-cat') denials = denials.filter((d) => !String(d.tool_input.command).startsWith('cat'));
  if (mode === 'skip-implicit') denials = denials.filter((d) => !String(d.tool_input.command).startsWith('git diff /'));
  let answer = 'All refused.';
  if (mode === 'leak') answer = fs.readFileSync(outside + '/note.txt', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: mode === 'status-error' ? 'error_during_execution' : 'success',
    is_error: mode === 'status-error', result: answer,
    modelUsage: { 'claude-haiku-9-9': { inputTokens: 10, outputTokens: 5 } }, permission_denials: denials,
  }));
  process.exit(0);
}
const queueFile = path.join(dir, 'queue.json');
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const next = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!next) { process.stderr.write('no canned answer\\n'); process.exit(3); }
if (next.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, next.sleepMs);
process.stdout.write(next.stdout.split('{{CWD}}').join(process.cwd()));
process.exit(next.exit ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    queue(...answers) {
      writeFileSync(join(dir, 'queue.json'), JSON.stringify(answers));
    },
    probe(mode) {
      writeFileSync(join(dir, 'probe.txt'), mode);
    },
    calls() {
      const file = join(dir, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    },
    reviews() {
      return this.calls().filter((c) => !/file_path \S+\/note\.txt/.test(c.prompt));
    },
  };
}

const OPUS_USAGE = { 'claude-opus-9-9': { inputTokens: 100, outputTokens: 900 } };
const reply = (answer, extra = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer,
    modelUsage: OPUS_USAGE,
    permission_denials: [],
    ...extra,
  });
const canned = (answer, extra) => ({ stdout: reply(answer, extra) });
const WIN = 'Biggest win: fix the rounding.';
const inWindow = () => {
  const w = windowOf(BUGGY_PRICE, 'Math.floor');
  return `[bug] src/price.mjs:${w.from + 1}: cents are cut; use round\n${WIN}`;
};
const outside = (line = 2) => `[bug] src/price.mjs:${line}: something else\n${WIN}`;

function runCli(fx, fake, batch, extra = []) {
  const r = spawnSync(
    process.execPath,
    [
      DRILL,
      'run',
      '--repo',
      fx.repo,
      '--ledger-dir',
      fx.ledgerDir,
      '--batch',
      batch,
      '--agents-dir',
      fx.agentsDir,
      '--claude',
      fake.bin,
      ...extra,
    ],
    { encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE_DIR: fake.dir } },
  );
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const ledgerFile = (fx) => join(fx.ledgerDir, 'drill-ledger.csv');
const rowsOf = (fx) => readLedger(ledgerFile(fx)).rows;
const defOf = (fx, id) =>
  JSON.parse(readFileSync(join(fx.ledgerDir, 'drills', id, 'case.json'), 'utf8'));
const textsOf = (fx) => ({
  'docs/agents.md': execFileSync('git', ['show', 'HEAD:docs/agents.md'], {
    cwd: fx.repo,
    env: GIT_ENV,
  }),
  'CLAUDE.md': execFileSync('git', ['show', 'HEAD:CLAUDE.md'], { cwd: fx.repo, env: GIT_ENV }),
});

function prepare(fx, id = 's01') {
  const workspace = createWorkspace();
  after(() => removeWorkspace(workspace));
  const caseDir = join(fx.ledgerDir, 'drills', id);
  const caseDef = defOf(fx, id);
  const prepared = prepareClone({
    source: fx.repo,
    caseDir,
    caseDef,
    workspace,
    texts: textsOf(fx),
    date: TODAY,
  });
  return { prepared, caseDef, workspace };
}

// --- The parser ---

test('parser: the reviewer format and the tolerated variations', () => {
  const answer = [
    '[bug] src/a.ts:12: plain',
    '- [fix] src/a.ts:13: bullet',
    '* [ask] src/a.ts:14: star bullet, ask counts',
    '1. [bug] src/a.ts:15: numbered',
    '[bug] `src/a.ts:16`: backticks',
    '**[bug]** **src/a.ts:17**: bold',
    '**[bug] src/a.ts:18:** all bold',
    '[bug] ./src/a.ts:19: dot slash',
    '[bug] /tmp/rv-x/repo/src/a.ts:20: clone prefix',
    '[bug] src/a.ts:21-25: range',
    '[bug] src/a.ts:30, 32-33: list',
    '[BUG] src/a.ts:40: upper case tag',
    '[bug] src/a.ts:41:7: with a column',
    '[bug] src/a.ts:50 no colon after the line',
    '[bug] src/app/[id]/page.tsx:51: brackets in a path',
    'Biggest win: src/a.ts:99 is not a finding',
  ].join('\n');
  const { findings, malformed } = parseFindings(answer, { prefixes: ['/tmp/rv-x/repo'] });
  assert.equal(malformed, 0);
  assert.deepEqual(
    findings.map((f) => f.ranges),
    [
      [[12, 12]],
      [[13, 13]],
      [[14, 14]],
      [[15, 15]],
      [[16, 16]],
      [[17, 17]],
      [[18, 18]],
      [[19, 19]],
      [[20, 20]],
      [[21, 25]],
      [
        [30, 30],
        [32, 33],
      ],
      [[40, 40]],
      [[41, 41]],
      [[50, 50]],
      [[51, 51]],
    ],
  );
  assert.ok(findings.slice(0, -1).every((f) => f.file === 'src/a.ts'));
  assert.equal(findings.at(-1).file, 'src/app/[id]/page.tsx');
  assert.equal(findings[2].tag, 'ask');
});

test('parser: a line that starts like a finding without file:line is malformed, never a crash', () => {
  for (const line of [
    '[bug] no location given',
    '[bug]',
    '[fix] src/a.ts: no line number',
    '[bug] src/a.ts:0: line zero',
    '[bug] src/a.ts:12abc: not a number',
    '[bug] src/a.ts:99999999999999999999: too large',
    '[note] src/a.ts:12: an unknown tag on a location',
    '- src/a.ts:12: a location with no tag',
    '### src/a.ts:12',
    '**Bug** src/a.ts:12: a tag with no brackets',
    'fix: src/a.ts:12: a lowercase tag with no brackets',
    '| [bug] | src/a.ts:12 | a table row |',
    'See the [fix] finding above.',
  ]) {
    const { findings, malformed } = parseFindings(line);
    assert.equal(malformed, 1, line);
    assert.equal(findings.length, 0, line);
  }
});

test('parser: prose and odd input are neither findings nor malformed', () => {
  for (const input of [
    '',
    'Nothing to report.',
    '[a link](http://example.invalid:80/x)',
    '[Note] some text',
    null,
    undefined,
    42,
  ]) {
    assert.deepEqual(parseFindings(input), { findings: [], malformed: 0 });
  }
});

test('parser: a reversed range is read in order', () => {
  assert.deepEqual(parseFindings('[bug] a.ts:20-10: x').findings[0].ranges, [[10, 20]]);
});

// --- The scorer ---

const BUGS = [
  {
    id: 'b1',
    what: 'x',
    windows: [
      { file: 'src/a.ts', from: 100, to: 110 },
      { file: 'src/caller.ts', from: 5, to: 6 },
    ],
  },
  { id: 'b2', what: 'y', windows: [{ file: 'src/a.ts', from: 200, to: 210 }] },
];
const scoreOf = (text) => scoreFindings(parseFindings(text).findings, BUGS);

test('scorer: window edges are inside, one line off is outside', () => {
  assert.equal(scoreOf('[bug] src/a.ts:100: x').caught, 1);
  assert.equal(scoreOf('[bug] src/a.ts:110: x').caught, 1);
  assert.deepEqual(scoreOf('[bug] src/a.ts:99: x'), { caught: 0, caughtBugs: [], other: 1 });
  assert.deepEqual(scoreOf('[bug] src/a.ts:111: x'), { caught: 0, caughtBugs: [], other: 1 });
});

test('scorer: a range that overlaps counts, the same line in another file does not', () => {
  assert.equal(scoreOf('[bug] src/a.ts:90-100: x').caught, 1);
  assert.equal(scoreOf('[bug] src/a.ts:90-99: x').caught, 0);
  assert.deepEqual(scoreOf('[bug] src/other.ts:100: x'), { caught: 0, caughtBugs: [], other: 1 });
  assert.equal(scoreOf('[bug] b/src/a.ts:100: x').caught, 1);
});

test('scorer: any window catches its bug, and each bug counts once', () => {
  assert.deepEqual(scoreOf('[bug] src/caller.ts:5: x').caughtBugs, ['b1']);
  const twice = scoreOf('[bug] src/a.ts:100: x\n[fix] src/caller.ts:6: y\n[ask] src/a.ts:105: z');
  assert.equal(twice.caught, 1);
  assert.equal(twice.other, 0);
});

test('scorer: two bugs, one caught, plus a finding elsewhere', () => {
  assert.deepEqual(scoreOf('[bug] src/a.ts:205: x\n[bug] src/a.ts:1: y'), {
    caught: 1,
    caughtBugs: ['b2'],
    other: 1,
  });
});

const scoreInput = (stdout, extra = {}) => ({
  bugs: [{ id: 'b1', what: 'x', windows: [{ file: 'src/a.ts', from: 10, to: 12 }] }],
  stdout,
  exit: 0,
  requestedModel: 'opus',
  clone: '/tmp/rv-x/repo',
  specPath: '.agent-runs/2030-01-02-change/spec.md',
  ...extra,
});

test('scoreRun: a good answer is scored with its concrete model id', () => {
  const r = scoreRun(
    scoreInput(reply(`[bug] src/a.ts:11: x\n[bug] src/a.ts:1: y\n[bug] nowhere\n${WIN}`)),
  );
  assert.deepEqual(
    { scored: r.scored, caught: r.caught, other: r.other, malformed: r.malformed, model: r.model },
    { scored: true, caught: 1, other: 1, malformed: 1, model: 'claude-opus-9-9' },
  );
});

test('scoreRun: no findings at all is a real zero, because the answer is complete', () => {
  const r = scoreRun(scoreInput(reply(WIN)));
  assert.equal(r.scored, true);
  assert.equal(r.caught, 0);
});

test('scoreRun: each doubt leaves it unscored, never 0', () => {
  const good = `[bug] src/a.ts:11: x\n${WIN}`;
  const denied = (file_path) => ({
    permission_denials: [{ tool_name: 'Read', tool_input: { file_path } }],
  });
  const cases = {
    'not JSON': ['oops', {}],
    'JSON null': ['null', {}],
    'empty output': ['', {}],
    'error status': [reply(good, { subtype: 'error_max_turns', is_error: true }), {}],
    'is_error with success': [reply(good, { is_error: true }), {}],
    'status missing': [
      JSON.stringify({ result: good, modelUsage: OPUS_USAGE, permission_denials: [] }),
      {},
    ],
    'non-zero exit': [reply(good), { exit: 1 }],
    'killed, no exit': [reply(good), { exit: null }],
    'no Biggest win': [reply('[bug] src/a.ts:11: x'), {}],
    'cut off after Biggest win': [reply(`${WIN}\n[bug] src/a.ts:11: x`), {}],
    'no answer field': [reply(undefined), {}],
    'answer not a string': [reply(['x']), {}],
    'denied docs/agents.md': [reply(good, denied('docs/agents.md')), {}],
    'denied CLAUDE.md, absolute': [reply(good, denied('/tmp/rv-x/repo/CLAUDE.md')), {}],
    'denied spec, dot slash': [reply(good, denied('./.agent-runs/2030-01-02-change/spec.md')), {}],
    'denied read with no path': [
      reply(good, { permission_denials: [{ tool_name: 'Read', tool_input: {} }] }),
      {},
    ],
    'no denial list': [reply(good, { permission_denials: undefined }), {}],
    'wrong model': [reply(good, { modelUsage: { 'claude-sonnet-9-9': { outputTokens: 5 } } }), {}],
    'no modelUsage': [reply(good, { modelUsage: undefined }), {}],
  };
  for (const [name, [stdout, extra]] of Object.entries(cases)) {
    const r = scoreRun(scoreInput(stdout, extra));
    assert.equal(r.scored, false, name);
    assert.ok(r.reasons.length > 0, name);
    assert.equal(r.caught, undefined, name);
  }
});

test('scoreRun: a denial of something else does not unscore', () => {
  const r = scoreRun(
    scoreInput(
      reply(`[bug] src/a.ts:11: x\n${WIN}`, {
        permission_denials: [
          { tool_name: 'Bash', tool_input: { command: 'cat CLAUDE.md' } },
          { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } },
          null,
        ],
      }),
    ),
  );
  assert.equal(r.scored, true);
});

test('endsWithBiggestWin: tolerates markup, needs the words last', () => {
  assert.equal(endsWithBiggestWin('x\nBiggest win: y\n\n'), true);
  assert.equal(endsWithBiggestWin('**Biggest win:** y'), true);
  assert.equal(endsWithBiggestWin('- Biggest win: y'), true);
  assert.equal(endsWithBiggestWin('Biggest win: y\nmore'), false);
  assert.equal(endsWithBiggestWin(''), false);
  assert.equal(endsWithBiggestWin(undefined), false);
});

test('resolveModel: aliases, full ids, helpers and a second model', () => {
  const one = (id) => ({ [id]: { outputTokens: 100 } });
  assert.deepEqual(resolveModel(one('claude-opus-9-9'), 'opus'), {
    model: 'claude-opus-9-9',
    problem: null,
  });
  assert.equal(resolveModel(one('claude-opus-9-9'), 'claude-opus-9-9').problem, null);
  assert.equal(resolveModel(one('claude-opus-9-9-20300101'), 'claude-opus-9-9').problem, null);
  assert.equal(resolveModel(one('claude-opus-9-9[1m]'), 'opus').model, 'claude-opus-9-9');
  assert.ok(resolveModel(one('claude-sonnet-9-9'), 'opus').problem);
  assert.ok(resolveModel(one('claude-opus-9-1'), 'claude-opus-9-9').problem);
  assert.ok(resolveModel(one('Weird,Id'), 'opus').problem);
  assert.equal(resolveModel(one('Weird,Id'), 'opus').model, null);
  assert.ok(resolveModel({}, 'opus').problem);
  assert.ok(resolveModel(undefined, 'opus').problem);
  assert.ok(resolveModel(null, 'opus').problem);

  const helper = {
    'claude-haiku-9-9': { outputTokens: 9 },
    'claude-opus-9-9': { outputTokens: 100 },
  };
  assert.deepEqual(resolveModel(helper, 'opus'), { model: 'claude-opus-9-9', problem: null });
  const atShare = {
    'claude-haiku-9-9': { outputTokens: 10 },
    'claude-opus-9-9': { outputTokens: 100 },
  };
  assert.ok(resolveModel(atShare, 'opus').problem, 'a second model at the stated share is mixed');
  const flipped = {
    'claude-haiku-9-9': { outputTokens: 100 },
    'claude-opus-9-9': { outputTokens: 1 },
  };
  assert.ok(
    resolveModel(flipped, 'opus').problem,
    'the requested model must be the one that did the work',
  );
  const uncounted = { 'claude-haiku-9-9': {}, 'claude-opus-9-9': { outputTokens: 100 } };
  assert.ok(resolveModel(uncounted, 'opus').problem);
  assert.equal(resolveModel({ 'claude-opus-9-9': {} }, 'opus').problem, null);
});

// --- Diff, case and helper parsing ---

test('parseDiff: counts consume the body, so content like a header is not read as one', () => {
  const diff = [
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,2 +1,2 @@',
    ' same',
    '--- old content',
    '+++ new content',
    '\\ No newline at end of file',
    '@@ -9,0 +10 @@ tail',
    '+solo',
    'diff --git a/gone.txt b/gone.txt',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const files = parseDiff(diff);
  assert.deepEqual(
    files.map((f) => f.file),
    ['x.txt', null],
  );
  assert.deepEqual(files[0].hunks[0].added, ['++ new content']);
  assert.deepEqual(files[0].hunks[0].removed, ['-- old content']);
  assert.deepEqual(files[0].hunks[1], { newStart: 10, newCount: 1, added: ['solo'], removed: [] });
  assert.deepEqual(files[1].hunks[0].removed, ['bye']);
  assert.deepEqual(parseDiff(''), []);
});

test('parseChecks, profileModel, parseAgentFile, agentsJson', () => {
  assert.deepEqual(parseChecks('pnpm check:all: pass'), {
    command: 'pnpm check:all',
    result: 'pass',
  });
  assert.equal(parseChecks('no result here'), null);
  assert.equal(parseChecks(undefined), null);

  assert.deepEqual(profileModel(PROFILE, 'code-reviewer'), { model: 'opus', effort: 'high' });
  assert.deepEqual(profileModel(PROFILE, 'code-reviewer-light'), {
    model: 'sonnet',
    effort: 'medium',
  });
  assert.equal(profileModel(PROFILE, 'absent'), null);

  const agent = parseAgentFile(AGENT_TEXT);
  assert.equal(agent.name, 'code-reviewer');
  assert.equal(agent.description, 'Reviews a change: correctness against its spec.');
  assert.deepEqual(agent.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.match(agent.prompt, /You review one change/);
  assert.equal(parseAgentFile('no front matter'), null);
  assert.deepEqual(agentsJson(agent, 'sonnet', 'low')['code-reviewer'].model, 'sonnet');
  assert.deepEqual(agentsJson(agent, 'sonnet', 'low')['code-reviewer'].effort, 'low');
});

test('installCommand: pnpm only with its lock file, an override always wins', () => {
  const dir = newDir('install');
  assert.equal(installCommand(dir), null);
  assert.equal(installCommand(dir, 'make deps'), 'make deps');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(installCommand(dir), 'pnpm install --frozen-lockfile');
  assert.equal(installCommand(dir, ''), null);
});

test('caseProblems: shape, windows at most the stated size, and no key text in the messages', () => {
  const fx = makeFixture();
  const dir = join(fx.ledgerDir, 'drills', 's01');
  const good = replayDef(fx, 's01');
  assert.deepEqual(caseProblems(good, dir), []);
  const w = (from, to, file = 'src/secret-name.mjs') => [
    { id: 'b1', what: WHAT, windows: [{ file, from, to, anchor: '' }] },
  ];
  assert.deepEqual(caseProblems({ ...good, bugs: w(1, MAX_WINDOW_LINES) }, dir), []);
  const broken = [
    { ...good, id: 'S 01' },
    { ...good, id: 'other' },
    { ...good, kind: 'odd' },
    { ...good, reviewer: 'Bad Name' },
    { ...good, tier: 0 },
    { ...good, base: 'nope' },
    { ...good, fix: null },
    { ...good, kind: 'planted', fix: null },
    { ...good, added: 'soon' },
    { ...good, retired: 'never' },
    { ...good, checks: 'no result' },
    { ...good, bugs: [] },
    { ...good, bugs: w(1, MAX_WINDOW_LINES + 1) },
    { ...good, bugs: w(5, 4) },
    { ...good, bugs: w(0, 4) },
    { ...good, bugs: w(1, 2, '../outside.mjs') },
    { ...good, bugs: w(1, 2, '/abs/path.mjs') },
    { ...good, bugs: [{ id: 'b1', what: 'two\nlines', windows: w(1, 2)[0].windows }] },
    { ...good, bugs: [{ id: 'b1', what: 'x', windows: [] }] },
    { ...good, bugs: [...w(1, 2), ...w(3, 4)] },
  ];
  for (const def of broken) {
    const problems = caseProblems(def, dir);
    assert.ok(problems.length > 0, JSON.stringify(def));
    assert.ok(!problems.join(' ').includes('secret-name'));
    assert.ok(!problems.join(' ').includes(WHAT));
  }
});

// --- The clone ---

test('clone: holds the change and nothing later, and the key is unreachable from it', () => {
  const fx = makeFixture();
  const { prepared, caseDef } = prepare(fx);
  const { clone, rangeStart, change } = prepared;
  assert.deepEqual(checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared }), []);

  for (const sha of [fx.fix, fx.future, fx.buggy]) {
    assert.notEqual(gitStatus(clone, 'cat-file', '-e', sha), 0, 'later commit is gone');
  }
  assert.equal(gitStatus(clone, 'cat-file', '-e', fx.base), 0);
  assert.equal(git(clone, 'log', '--all', '--format=%H', '-1'), change);
  assert.equal(git(clone, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  assert.equal(git(clone, 'remote'), '');
  assert.equal(git(clone, 'rev-parse', `${rangeStart}^`), fx.base);
  assert.equal(git(clone, 'rev-parse', `${change}^`), rangeStart);

  // The later texts are nowhere, in any commit or object.
  const everything = git(clone, 'log', '--all', '-p', '--format=%B');
  for (const text of [
    FIX_LINE.trim(),
    'this line only exists in the future',
    'Review fix',
    'Later work',
    WHAT,
  ]) {
    assert.ok(!everything.includes(text), text);
  }
  assert.ok(!readFileSync(join(clone, 'src/price.mjs'), 'utf8').includes(FIX_LINE.trim()));

  // The private folder is an empty gitlink: no cases, no key.
  assert.deepEqual(readdirSync(join(clone, 'vault')), []);
  assert.equal(existsSync(join(clone, 'vault', 'ops', 'drills')), false);
  assert.equal(git(clone, 'config', '--get', 'protocol.allow'), 'never');
  assert.equal(git(clone, 'config', '--get', 'submodule.vault.update'), 'none');

  // The change: today's date, real subject, only the change in its diff.
  assert.equal(git(clone, 'log', '-1', '--format=%s', change), 'Add rounding and rate helpers');
  assert.notEqual(git(clone, 'log', '-1', '--format=%ad', '--date=format:%Y', change), '2020');
  assert.notEqual(git(clone, 'log', '-1', '--format=%cd', '--date=format:%Y', change), '2020');
  assert.equal(git(clone, 'log', '-1', '--format=%ad', '--date=format:%Y', fx.base), '2020');
  assert.equal(git(clone, 'diff', '--name-only', rangeStart, change), 'src/price.mjs');

  // Today's texts are overlaid, and the spec is ignored rather than committed.
  assert.equal(readFileSync(join(clone, 'docs/agents.md'), 'utf8'), PROFILE);
  assert.match(readFileSync(join(clone, 'CLAUDE.md'), 'utf8'), /Today/);
  assert.equal(readFileSync(join(clone, prepared.specPath), 'utf8'), SPEC);
  assert.equal(git(clone, 'status', '--porcelain'), '');
  assert.equal(gitStatus(clone, 'ls-files', '--error-unmatch', prepared.specPath), 1);
  assert.equal(git(clone, 'fsck', '--unreachable', '--no-reflogs', '--no-progress'), '');
});

test('clone: an overlay identical to base adds no commit, and the range still shows the change', () => {
  const fx = makeFixture({
    headProfile: '# Old profile\n',
    headClaude: '# Project rules\n\nOld.\n',
  });
  const { prepared } = prepare(fx);
  assert.equal(prepared.rangeStart, fx.base);
  assert.equal(
    git(prepared.clone, 'diff', '--name-only', prepared.rangeStart, prepared.change),
    'src/price.mjs',
  );
});

test('clone: each way of holding too much is refused', () => {
  const fx = makeFixture();
  const refuse = (tamper, pattern) => {
    const { prepared, caseDef } = prepare(fx);
    assert.deepEqual(
      checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared }),
      [],
    );
    tamper(prepared);
    const problems = checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared });
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `${pattern}: ${problems.join('; ')}`,
    );
    assert.ok(
      !problems.join(' ').includes(FIX_LINE.trim()),
      'a leak is reported by count, not by text',
    );
  };
  const fetch = (clone, sha) =>
    git(
      clone,
      '-c',
      'protocol.allow=always',
      '-c',
      'uploadpack.allowAnySHA1InWant=true',
      'fetch',
      '--quiet',
      fx.repo,
      sha,
    );

  refuse(({ clone }) => fetch(clone, fx.future), /later commit/);
  refuse(({ clone }) => fetch(clone, fx.fix), /later commit/);
  refuse(({ clone }) => git(clone, 'remote', 'add', 'origin', fx.repo), /a remote/);
  refuse(({ clone }) => writeFileSync(join(clone, 'vault', 'ops.csv'), 'x'), /submodule folder/);
  refuse(({ clone }) => git(clone, 'branch', 'old', fx.base), /refs other/);
  refuse(({ clone }) => git(clone, 'config', 'protocol.allow', 'always'), /protocol.allow/);
  refuse(
    ({ clone }) => git(clone, 'config', 'submodule.vault.update', 'checkout'),
    /can still be updated/,
  );
  refuse(({ clone }) => write(clone, 'stray.txt', 'x'), /changed files/);
  refuse(({ clone }) => {
    git(clone, 'commit', '--quiet', '--allow-empty', '-m', 'dangling');
    git(clone, 'reset', '--quiet', '--hard', 'HEAD~1');
  }, /unreachable/);
  refuse(
    ({ clone, specPath }) => writeFileSync(join(clone, specPath), `${SPEC}\n${FIX_LINE}\n`),
    /in the spec/,
  );
  refuse(({ clone }) => {
    write(clone, 'notes.txt', `${FIX_LINE}\n`);
    git(clone, 'add', 'notes.txt');
    git(clone, 'commit', '--quiet', '--amend', '-m', 'Add rounding and rate helpers');
  }, /clone tree/);
  refuse(({ clone }) => {
    git(clone, 'commit', '--quiet', '--amend', '-m', `Add helpers\n\n${FIX_LINE}`);
  }, /commit message/);
});

test('clone: the leak scan covers lines of 20 characters and up, and only those', () => {
  const fx = makeFixture();
  const twenty = 'abcdefghij0123456789';
  const nineteen = 'abcdefghij012345678';
  git(fx.repo, 'checkout', '--quiet', '--detach', fx.buggy);
  write(fx.repo, 'src/fix.txt', `  ${twenty}\n  ${nineteen}\n`);
  git(fx.repo, 'add', 'src/fix.txt');
  git(fx.repo, 'commit', '--quiet', '-m', 'Round half up');
  const fix2 = git(fx.repo, 'rev-parse', 'HEAD');
  git(fx.repo, 'branch', 'second', fix2);
  git(fx.repo, 'checkout', '--quiet', 'main');
  const scan = (id, spec) => {
    addReplay(fx, id, { fix: fix2 }, { spec });
    const { prepared, caseDef } = prepare(fx, id);
    return checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared });
  };
  assert.deepEqual(scan('short', `# Spec\n\n${nineteen}\n`), []);
  assert.ok(scan('long', `# Spec\n\n${twenty}\n`).some((p) => /in the spec/.test(p)));
});

test('clone: a key sentence in the spec is refused too', () => {
  const fx = makeFixture();
  addReplay(fx, 's02', {}, { spec: `${SPEC}\n${WHAT}\n` });
  const { prepared, caseDef } = prepare(fx, 's02');
  const problems = checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared });
  assert.ok(
    problems.some((p) => /in the spec/.test(p)),
    problems.join('; '),
  );
});

test("clone: a later fix line in today's profile is refused", () => {
  const fx = makeFixture({ headProfile: `${PROFILE}\n${FIX_LINE}\n` });
  const { prepared, caseDef } = prepare(fx);
  const problems = checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared });
  assert.ok(
    problems.some((p) => /clone tree/.test(p)),
    problems.join('; '),
  );
});

test('clone: a forbidden line already in the reviewed tree is ordinary code, not a leak', () => {
  const fx = makeFixture();
  // Same text as the fix's line, already present elsewhere at buggy: replays add it to a copy.
  const repo = fx.repo;
  git(repo, 'checkout', '--quiet', '--detach', fx.buggy);
  write(repo, 'src/copy.mjs', `${FIX_LINE}\n`);
  git(repo, 'add', 'src/copy.mjs');
  git(repo, 'commit', '--quiet', '-m', 'Add helpers again');
  const buggy2 = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/price.mjs', FIXED_PRICE);
  git(repo, 'add', 'src/price.mjs');
  git(repo, 'commit', '--quiet', '-m', 'Round half up');
  const fix2 = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'second', fix2);
  git(repo, 'checkout', '--quiet', 'main');
  addReplay(fx, 's02', { buggy: buggy2, fix: fix2 });
  const { prepared, caseDef } = prepare(fx, 's02');
  assert.deepEqual(checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared }), []);
});

test('clone: cases tracked inside the public repo would be reachable, and are refused', () => {
  const fx = makeFixture();
  const openDir = join(fx.repo, 'ops');
  mkdirSync(join(openDir, 'drills'), { recursive: true });
  cpSync(join(fx.ledgerDir, 'drills', 's01'), join(openDir, 'drills', 's01'), { recursive: true });
  write(fx.repo, 'ops/drills/s01/case.json', JSON.stringify(replayDef(fx, 's01')));
  const buggyTip = fx.buggy;
  // Put the cases in the buggy tree on a side history, as a repo with no private folder would.
  git(fx.repo, 'checkout', '--quiet', '--detach', buggyTip);
  git(fx.repo, 'add', 'ops');
  git(fx.repo, 'commit', '--quiet', '-m', 'Add helpers and notes');
  const buggy2 = git(fx.repo, 'rev-parse', 'HEAD');
  write(fx.repo, 'src/price.mjs', FIXED_PRICE);
  git(fx.repo, 'add', 'src/price.mjs');
  git(fx.repo, 'commit', '--quiet', '-m', 'Round half up');
  const fix2 = git(fx.repo, 'rev-parse', 'HEAD');
  git(fx.repo, 'branch', 'second', fix2);
  writeCase({ ledgerDir: openDir }, replayDef(fx, 's01', { buggy: buggy2, fix: fix2 }));
  const workspace = createWorkspace();
  after(() => removeWorkspace(workspace));
  const caseDef = JSON.parse(readFileSync(join(openDir, 'drills', 's01', 'case.json'), 'utf8'));
  const prepared = prepareClone({
    source: fx.repo,
    caseDir: join(openDir, 'drills', 's01'),
    caseDef,
    workspace,
    texts: textsOf(fx),
    date: TODAY,
  });
  const problems = checkClone({ source: fx.repo, ledgerDir: openDir, caseDef, prepared });
  assert.ok(
    problems.some((p) => /cases are inside the clone/.test(p)),
    problems.join('; '),
  );
});

test('clone: a planted case applies its patch and its removed lines are gone', () => {
  const fx = makeFixture();
  addPlanted(fx, 'p01');
  const { prepared, caseDef } = prepare(fx, 'p01');
  const { clone } = prepared;
  assert.deepEqual(checkClone({ source: fx.repo, ledgerDir: fx.ledgerDir, caseDef, prepared }), []);
  const text = readFileSync(join(clone, 'src/price.mjs'), 'utf8');
  assert.ok(text.includes(PLANTED_LINE));
  assert.ok(!text.includes(KNOWN_LINE));
  assert.ok(
    !git(clone, 'log', '--all', '-p').includes(KNOWN_LINE),
    'the correct line is in no commit',
  );
  assert.ok(prepared.patterns.includes(KNOWN_LINE.trim()));
  assert.equal(git(clone, 'log', '-1', '--format=%s'), 'Add rounding and rate helpers');
});

test('clone: a planted patch that does not apply is refused, with no patch text in the message', () => {
  const fx = makeFixture();
  addPlanted(fx, 'p01');
  writeFileSync(
    join(fx.ledgerDir, 'drills', 'p01', 'planted.patch'),
    'diff --git a/src/price.mjs b/src/price.mjs\n--- a/src/price.mjs\n+++ b/src/price.mjs\n@@ -1 +1 @@\n-no such line\n+other\n',
  );
  assert.throws(() => prepare(fx, 'p01'), /planted\.patch does not apply/);
});

test('clone: an empty change is refused', () => {
  const fx = makeFixture();
  addReplay(fx, 's02', { buggy: fx.base, base: fx.base });
  assert.throws(() => prepare(fx, 's02'), /the change is empty/);
});

test('windowProblems: a window in the change passes, and each stale form is named without its text', () => {
  const fx = makeFixture();
  const { prepared, caseDef } = prepare(fx);
  const clean = windowProblems({ ...prepared, caseDef });
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.anchors[0].anchor, caseDef.bugs[0].windows[0].anchor);

  const withWindow = (patch) => ({
    ...caseDef,
    bugs: [{ ...caseDef.bugs[0], windows: [{ ...caseDef.bugs[0].windows[0], ...patch }] }],
  });
  const check = (patch, pattern) => {
    const { problems } = windowProblems({ ...prepared, caseDef: withWindow(patch) });
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `${pattern}: ${problems.join('; ')}`,
    );
    assert.ok(!problems.join(' ').includes('src/'), 'no file names in messages');
  };
  check({ anchor: 'a'.repeat(64) }, /anchor mismatch/);
  check({ anchor: undefined }, /anchor mismatch/);
  check({ from: 1, to: 2, anchor: anchorOf(BUGGY_PRICE, 1, 2) }, /outside the diff/);
  check({ from: 1000, to: 1001 }, /past the end/);
  check({ file: 'src/absent.mjs' }, /not in the prepared tree/);
  check(
    { file: 'README.md', from: 1, to: 1, anchor: anchorOf('A demo app.\n', 1, 1) },
    /outside the diff/,
  );
});

test('windowProblems: a pure deletion counts as in the diff, at the lines around it', () => {
  const fx = makeFixture();
  const removed = '  // Cents for the invoice line.';
  const after = BUGGY_PRICE.replace(`${removed}\n`, '');
  git(fx.repo, 'checkout', '--quiet', '--detach', fx.buggy);
  write(fx.repo, 'src/price.mjs', after);
  git(fx.repo, 'add', 'src/price.mjs');
  git(fx.repo, 'commit', '--quiet', '-m', 'Remove a comment');
  const buggy2 = git(fx.repo, 'rev-parse', 'HEAD');
  write(fx.repo, 'src/price.mjs', BUGGY_PRICE);
  git(fx.repo, 'add', 'src/price.mjs');
  git(fx.repo, 'commit', '--quiet', '-m', 'Restore a comment');
  git(fx.repo, 'branch', 'second', 'HEAD');
  const fix2 = git(fx.repo, 'rev-parse', 'HEAD');
  git(fx.repo, 'checkout', '--quiet', 'main');
  const at = after.split('\n').findIndex((l) => l.includes('Math.floor')) + 1;
  const window = (line) => ({
    file: 'src/price.mjs',
    from: line,
    to: line,
    anchor: anchorOf(after, line, line),
  });
  const check = (id, line) => {
    addReplay(fx, id, {
      base: fx.buggy,
      buggy: buggy2,
      fix: fix2,
      bugs: [
        { id: 'b1', what: 'A comment that explained the unit went away', windows: [window(line)] },
      ],
    });
    const { prepared, caseDef } = prepare(fx, id);
    return windowProblems({ ...prepared, caseDef }).problems;
  };
  assert.deepEqual(check('near-before', at - 1), []);
  assert.deepEqual(check('near-after', at), []);
  assert.deepEqual(check('far', 1), ['bug b1 window 1: outside the diff']);
});

test('neutralProblems: the programme is named nowhere the reviewer can see', () => {
  const clean = {
    prompt: 'Review this change.',
    folder: '/tmp/rv-x/repo',
    profile: 'p',
    spec: 's',
    agentText: 'a',
  };
  assert.deepEqual(neutralProblems(clean), []);
  for (const field of Object.keys(clean)) {
    assert.equal(neutralProblems({ ...clean, [field]: 'a Drill here' }).length, 1, field);
  }
  assert.ok(!/drill/i.test(buildPrompt({ range: 'a..b', specPath: 's', checks: 'c: pass' })));
});

// --- validate ---

test('validate: a good replay and a good planted case pass, with no reviewer involved', () => {
  const fx = makeFixture();
  addPlanted(fx, 'p01');
  for (const id of ['s01', 'p01']) {
    const r = validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id });
    assert.deepEqual(r.problems, [], id);
    assert.ok(r.anchors.length > 0);
  }
});

test('validate: a bad case fails for the named reason', () => {
  const fx = makeFixture();
  const cases = {
    badsha: [{ buggy: 'f'.repeat(40) }, /not found/],
    badfix: [{ fix: 'e'.repeat(40) }, /not found/],
    order: [{ base: fx.fix, buggy: fx.buggy }, /base is not an ancestor/],
    fixfirst: [{ fix: fx.base }, /buggy is not an ancestor of fix/],
    anchor: [
      {
        bugs: [
          {
            id: 'b1',
            what: WHAT,
            windows: [{ ...windowOf(BUGGY_PRICE, 'Math.floor'), anchor: 'stale' }],
          },
        ],
      },
      /anchor mismatch/,
    ],
    window: [
      {
        bugs: [
          { id: 'b1', what: WHAT, windows: [windowOf(BUGGY_PRICE, 'export function addTax')] },
        ],
      },
      /outside the diff/,
    ],
  };
  for (const [id, [overrides, pattern]] of Object.entries(cases)) {
    addReplay(fx, id, overrides);
    const r = validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id });
    assert.ok(
      r.problems.some((p) => pattern.test(p)),
      `${id}: ${r.problems.join('; ')}`,
    );
  }
  assert.ok(
    /case\.json is missing/.test(
      validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id: 'absent' }).problems[0],
    ),
  );
  mkdirSync(join(fx.ledgerDir, 'drills', 'notjson'));
  writeFileSync(join(fx.ledgerDir, 'drills', 'notjson', 'case.json'), '{');
  assert.ok(
    /not JSON/.test(
      validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id: 'notjson' }).problems[0],
    ),
  );
});

test('validate: a planted bug that makes the tests fail is refused', () => {
  const fx = makeFixture();
  const edit = (text) => text.replace(KNOWN_LINE, '  const known = rates; // BREAKS_TESTS');
  addPlanted(fx, 'p02', { edit, needle: 'BREAKS_TESTS' });
  const r = validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id: 'p02' });
  assert.deepEqual(r.problems, ['the tests fail with the planted bug']);
});

test('validate: a failed install on a planted case is refused', () => {
  const fx = makeFixture();
  addPlanted(fx, 'p01');
  const r = validateCase({
    source: fx.repo,
    ledgerDir: fx.ledgerDir,
    id: 'p01',
    install: 'exit 3',
  });
  assert.deepEqual(r.problems, ['the install command failed']);
});

test('validate: a retired case is skipped, and the word in a spec fails it', () => {
  const fx = makeFixture();
  addReplay(fx, 'gone', { retired: '2030-01-02' });
  assert.equal(
    validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id: 'gone' }).retired,
    true,
  );
  addReplay(fx, 'named', {}, { spec: 'This is a drill.\n' });
  const r = validateCase({ source: fx.repo, ledgerDir: fx.ledgerDir, id: 'named' });
  assert.deepEqual(r.problems, ['the spec names the programme']);
});

test('validate CLI: exit codes, counts, and anchors only when asked', () => {
  const fx = makeFixture();
  addReplay(fx, 's02', {
    bugs: [
      {
        id: 'b1',
        what: WHAT,
        windows: [{ ...windowOf(BUGGY_PRICE, 'Math.floor'), anchor: 'stale' }],
      },
    ],
  });
  const run = (...extra) =>
    spawnSync(
      process.execPath,
      [DRILL, 'validate', '--repo', fx.repo, '--ledger-dir', fx.ledgerDir, ...extra],
      { encoding: 'utf8' },
    );
  const all = run();
  assert.equal(all.status, 1);
  assert.match(all.stdout, /s01: ok/);
  assert.match(all.stdout, /s02: FAIL: bug b1 window 1: anchor mismatch/);
  assert.match(all.stdout, /validated 2, failed 1/);
  assert.ok(!all.stdout.includes(WHAT));
  assert.ok(!all.stdout.includes('src/price.mjs'));
  assert.ok(!/[0-9a-f]{64}/.test(all.stdout));

  const one = run('--case', 's01', '--show-anchors');
  assert.equal(one.status, 0);
  assert.match(
    one.stdout,
    new RegExp(`b1 window 1: ${windowOf(BUGGY_PRICE, 'Math.floor').anchor}`),
  );
});

// --- run, end to end with the fake ---

test('run: exact flags, a neutral prompt, and the clone the reviewer actually saw', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  const r = runCli(fx, fake, 'one', ['--test-allow', 'Bash(node --test *)']);
  assert.equal(r.status, 0, r.out + r.err);

  const [call] = fake.reviews();
  const argv = call.argv;
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(argv[0], '-p');
  for (const name of ['--restricted', '--strict-mcp-config', '--no-session-persistence']) {
    assert.ok(argv.includes(name), name);
  }
  assert.equal(flag('--tools'), 'Read,Glob,Grep,Bash');
  assert.equal(flag('--agent'), 'code-reviewer');
  assert.equal(flag('--model'), 'opus');
  assert.equal(flag('--effort'), 'high');
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1);
  assert.ok(
    allowed.includes('Bash(git diff *)') &&
      allowed.includes('Bash(git log *)') &&
      allowed.includes('Bash(git show *)'),
  );
  assert.ok(allowed.includes('Bash(node check.mjs)'), 'the case command');
  assert.ok(allowed.includes('Bash(node --test *)'), 'the extra rule');
  assert.ok(denied.some((d) => d.includes('--no-index')));
  assert.ok(
    !allowed.some(
      (a) => /^Bash\((cat|git -C|git)\b.*\)$/.test(a) && !/git (diff|log|show)/.test(a),
    ),
  );

  // The prompt: the three normal inputs, no key, no name of the programme.
  assert.match(call.prompt, /Commit range: [0-9a-f]{40}\.\.[0-9a-f]{40}/);
  assert.match(call.prompt, /Spec: \.agent-runs\/\d{4}-\d{2}-\d{2}-change\/spec\.md/);
  assert.match(call.prompt, /CHECKS output: node check\.mjs: pass/);
  const words = call.prompt.replace(/[0-9a-f]{40}/g, 'SHA');
  for (const text of [WHAT, 'src/price.mjs', 'b1', 's01']) assert.ok(!words.includes(text), text);
  assert.ok(!/drill/i.test(call.prompt + call.cwd + JSON.stringify(argv)));

  // What the reviewer's working folder held while it ran.
  assert.deepEqual(call.logAll.split('\n'), [
    'Add rounding and rate helpers',
    'Project docs',
    'Start the demo app',
  ]);
  assert.equal(call.status, '');
  assert.deepEqual(call.vault, []);
  assert.equal(call.profile, PROFILE);
  assert.match(call.head, /^Add rounding and rate helpers\|dev\|/);
  assert.ok(!call.cwd.startsWith(fx.repo));

  // The agents file holds the text that ran, with the requested model.
  const agentsFile = flag('--agents');
  assert.ok(!agentsFile.startsWith(call.cwd), 'the agent file is outside the working folder');
});

test('run: the ledger row, the raw output and the clean-up', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  const r = runCli(fx, fake, 'one');
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /s01: caught 1, other 0, malformed 0, planted 1/);
  assert.match(r.out, /batch one: scored 1, batch_cases 1/);

  const [row] = rowsOf(fx);
  assert.equal(row.case, 's01');
  assert.equal(row.kind, 'replay');
  assert.equal(row.reviewer, 'code-reviewer');
  assert.equal(row.model, 'claude-opus-9-9');
  assert.equal(row.effort, 'high');
  assert.equal(row.tier, '2');
  assert.equal(row.planted, '1');
  assert.equal(row.caught, '1');
  assert.equal(row.other_findings, '0');
  assert.equal(row.batch, 'one');
  assert.equal(row.batch_cases, '1');
  assert.equal(row.malformed, '0');
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
  // The hash covers the reviewer text and both overlaid texts, the same way the global view does.
  assert.equal(row.agent_text, agentTextHash([AGENT_TEXT, PROFILE, textsOf(fx)['CLAUDE.md']]));

  const header = readFileSync(ledgerFile(fx), 'utf8').split('\n')[0];
  assert.equal(
    header,
    'date,case,kind,reviewer,model,effort,tier,planted,caught,other_findings,batch,batch_cases,agent_text,malformed',
  );
  assert.deepEqual(LEDGER_COLUMNS, header.split(','));

  const rawRoot = join(fx.repo, '.agent-runs');
  const [folder] = readdirSync(rawRoot);
  assert.match(folder, /^\d{4}-\d{2}-\d{2}-one$/);
  for (const file of [
    'meta.json',
    'prompt.txt',
    'answer.json',
    'stderr.txt',
    'exit.json',
    'score.json',
  ]) {
    assert.ok(existsSync(join(rawRoot, folder, 's01', file)), file);
  }

  // The reviewer's temp folders are gone.
  const [call] = fake.reviews();
  assert.equal(existsSync(dirname(call.cwd)), false);
  assert.equal(existsSync(join(fx.repo, 'vault', 'ops', 'drills', 's01', 'case.json')), true);
});

test('run: output carries no key text', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  const r = runCli(fx, fake, 'one');
  for (const text of [WHAT, 'src/price.mjs', 'Math.floor', FIX_LINE.trim()]) {
    assert.ok(!r.out.includes(text) && !r.err.includes(text), text);
  }
});

test('run: a draft text and a named model go through the definition, and the hash follows the text', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  assert.equal(runCli(fx, fake, 'live').status, 0);

  const draftDir = newDir('draft');
  write(draftDir, 'code-reviewer.md', AGENT_TEXT.replace('You review', 'Draft: you review'));
  fake.queue(canned(inWindow(), { modelUsage: { 'claude-sonnet-9-9': { outputTokens: 5 } } }));
  const r = spawnSync(
    process.execPath,
    [
      DRILL,
      'run',
      '--repo',
      fx.repo,
      '--ledger-dir',
      fx.ledgerDir,
      '--batch',
      'draft',
      '--agents-dir',
      draftDir,
      '--claude',
      fake.bin,
      '--model',
      'sonnet',
      '--effort',
      'low',
    ],
    { encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE_DIR: fake.dir } },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = rowsOf(fx);
  assert.notEqual(rows[0].agent_text, rows[1].agent_text);
  assert.equal(rows[1].model, 'claude-sonnet-9-9');
  assert.equal(rows[1].effort, 'low');
  const argv = fake.reviews().at(-1).argv;
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
});

test('run: the definition passed with --agents is what was hashed', () => {
  const fx = makeFixture();
  const fake = makeFake();
  // Replace the fake's run with one that copies the agents file before the workspace is removed.
  const bin = readFileSync(fake.bin, 'utf8');
  writeFileSync(
    fake.bin,
    bin.replace(
      'const queueFile =',
      "fs.writeFileSync(path.join(dir, 'agents-seen.json'), fs.readFileSync(process.argv[process.argv.indexOf('--agents') + 1]));\nconst queueFile =",
    ),
  );
  fake.queue(canned(inWindow()));
  assert.equal(runCli(fx, fake, 'one').status, 0);
  const seen = JSON.parse(readFileSync(join(fake.dir, 'agents-seen.json'), 'utf8'));
  assert.deepEqual(seen, {
    'code-reviewer': {
      description: 'Reviews a change: correctness against its spec.',
      prompt: '\nYou review one change. End with Biggest win.\n',
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      model: 'opus',
      effort: 'high',
    },
  });
});

test('run: a clone-prefixed finding is caught, and the second case keeps going after a scored one', () => {
  const fx = makeFixture();
  addPlanted(fx, 's02');
  const fake = makeFake();
  const w = windowOf(BUGGY_PRICE.replace(KNOWN_LINE, PLANTED_LINE), PLANTED_LINE);
  fake.queue(
    canned(
      `[bug] {{CWD}}/src/price.mjs:${windowOf(BUGGY_PRICE, 'Math.floor').from + 1}: cents\n${WIN}`,
    ),
    canned(`- **[fix]** \`./src/price.mjs:${w.from}-${w.to}\`: rates\n${WIN}`),
  );
  const r = runCli(fx, fake, 'two');
  assert.equal(r.status, 0, r.out + r.err);
  const rows = rowsOf(fx);
  assert.deepEqual(
    rows.map((row) => [row.case, row.kind, row.caught, row.batch_cases]),
    [
      ['s01', 'replay', '1', '2'],
      ['s02', 'planted', '1', '2'],
    ],
  );
  assert.match(r.out, /batch two: scored 2, batch_cases 2/);
});

test('run: a timed-out reviewer is unscored, a missing command is refused at the boundary', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue({ stdout: reply(inWindow()), sleepMs: 15000 });
  const r = runCli(fx, fake, 'slow', ['--timeout-sec', '1']);
  assert.equal(r.status, 1);
  assert.match(r.out, /s01: caught blank \(timed out\)/);
  assert.equal(rowsOf(fx)[0].caught, '');

  const gone = spawnSync(
    process.execPath,
    [
      DRILL,
      'run',
      '--repo',
      fx.repo,
      '--ledger-dir',
      fx.ledgerDir,
      '--batch',
      'gone',
      '--agents-dir',
      fx.agentsDir,
      '--claude',
      join(fake.dir, 'absent'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /ENOENT/);
  assert.match(gone.stdout, /not started/);
  assert.equal(rowsOf(fx).filter((row) => row.batch === 'gone').length, 0);
});

test('run: an anchor mismatch and a failed install spend no tokens and leave a blank row', () => {
  const fx = makeFixture();
  addReplay(fx, 's02', {
    bugs: [
      {
        id: 'b1',
        what: WHAT,
        windows: [{ ...windowOf(BUGGY_PRICE, 'Math.floor'), anchor: 'stale' }],
      },
    ],
  });
  const fake = makeFake();
  fake.queue();
  const stale = runCli(fx, fake, 'stale', ['--case', 's02']);
  assert.equal(stale.status, 1);
  assert.match(stale.out, /s02: caught blank \(refused: bug b1 window 1: anchor mismatch\)/);
  assert.equal(fake.reviews().length, 0);

  const broke = runCli(fx, fake, 'broke', ['--case', 's01', '--install', 'exit 4']);
  assert.equal(broke.status, 1);
  assert.match(broke.out, /refused: the install command failed/);
  assert.equal(fake.reviews().length, 0);
  assert.deepEqual(
    rowsOf(fx).map((row) => row.caught),
    ['', ''],
  );
});

test('run: what stops a batch before any token or row', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()), canned(inWindow()));

  assert.match(runCli(fx, fake, 'Not A Slug').err, /lowercase slug/);
  assert.match(runCli(fx, fake, 'x', ['--case', 'absent']).err, /cases not ready: absent/);
  assert.match(runCli(fx, fake, 'x', ['--model', 'Bad,Model']).err, /no model and effort/);

  addReplay(fx, 'sold', { retired: '2030-01-02' });
  assert.match(runCli(fx, fake, 'x', ['--case', 'sold']).err, /sold: retired/);
  rmSync(join(fx.ledgerDir, 'drills', 'sold'), { recursive: true });

  addReplay(fx, 'noagent', { reviewer: 'absent-reviewer' });
  assert.match(runCli(fx, fake, 'x').err, /no model and effort for absent-reviewer/);
  rmSync(join(fx.ledgerDir, 'drills', 'noagent'), { recursive: true });

  const unignored = makeFixture();
  git(unignored.repo, 'rm', '--quiet', '--cached', '.gitignore');
  rmSync(join(unignored.repo, '.gitignore'));
  assert.match(runCli(unignored, fake, 'x').err, /not git-ignored/);

  assert.deepEqual(fake.calls(), []);
  assert.equal(existsSync(ledgerFile(fx)), false);
});

test('run: a batch name is used once, and rows already in the ledger stay byte-identical', () => {
  const fx = makeFixture();
  const fake = makeFake();
  const existing = `${LEDGER_COLUMNS.join(',')}\n2029-12-31,old1,replay,code-reviewer,claude-opus-1,high,2,1,1,0,past,1,abc,0\n`;
  writeFileSync(ledgerFile(fx), existing);
  fake.queue(canned(inWindow()), canned(inWindow()));
  assert.equal(runCli(fx, fake, 'one').status, 0);
  const after1 = readFileSync(ledgerFile(fx), 'utf8');
  assert.ok(after1.startsWith(existing));
  assert.equal(after1.split('\n').length, 4);

  const again = runCli(fx, fake, 'one');
  assert.equal(again.status, 1);
  assert.match(again.err, /already in the ledger/);
  assert.equal(readFileSync(ledgerFile(fx), 'utf8'), after1);
  assert.equal(fake.reviews().length, 1);
});

test('run: a ledger with the wrong header or a cut-off row is refused, untouched', () => {
  const fake = makeFake();
  for (const content of ['date,case\n', `${LEDGER_COLUMNS.join(',')}\ncut,off`, '']) {
    const fx = makeFixture();
    writeFileSync(ledgerFile(fx), content);
    const r = runCli(fx, fake, 'one');
    assert.equal(r.status, 1);
    assert.equal(readFileSync(ledgerFile(fx), 'utf8'), content);
  }
  assert.deepEqual(fake.calls(), []);
});

test('run: raw output from an earlier run is not overwritten', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  assert.equal(runCli(fx, fake, 'one').status, 0);
  // The ledger row is gone, as if by a lost row; the raw folder still stands in the way.
  rmSync(ledgerFile(fx));
  const r = runCli(fx, fake, 'one');
  assert.equal(r.status, 1);
  assert.match(r.err, /raw folder for s01 already exists/);
});

test('run: the agent text or the profile naming the programme is refused before any token', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue();
  const draftDir = newDir('draft');
  write(
    draftDir,
    'code-reviewer.md',
    AGENT_TEXT.replace('You review', 'This is a drill. You review'),
  );
  const r = spawnSync(
    process.execPath,
    [
      DRILL,
      'run',
      '--repo',
      fx.repo,
      '--ledger-dir',
      fx.ledgerDir,
      '--batch',
      'named',
      '--agents-dir',
      draftDir,
      '--claude',
      fake.bin,
    ],
    { encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE_DIR: fake.dir } },
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused: the agent text names the programme/);
  assert.equal(fake.reviews().length, 0);

  const named = makeFixture({ headProfile: `${PROFILE}\nDrills run monthly.\n` });
  const second = runCli(named, fake, 'named');
  assert.equal(second.status, 1);
  assert.match(second.out, /refused: the profile names the programme/);
  assert.equal(fake.reviews().length, 0);
});

test('run: an inherited GIT_DIR and uncommitted texts do not reach the clone or the reviewer', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  writeFileSync(join(fx.repo, 'docs/agents.md'), '# Uncommitted profile\n');
  const r = spawnSync(
    process.execPath,
    [
      DRILL,
      'run',
      '--repo',
      fx.repo,
      '--ledger-dir',
      fx.ledgerDir,
      '--batch',
      'env',
      '--agents-dir',
      fx.agentsDir,
      '--claude',
      fake.bin,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_CLAUDE_DIR: fake.dir,
        GIT_DIR: join(newDir('nowhere'), '.git'),
        OLDPWD: fx.repo,
      },
    },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [call] = fake.reviews();
  assert.equal(call.env.GIT_DIR, undefined);
  assert.equal(call.env.OLDPWD, undefined);
  assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(call.profile, PROFILE, 'the committed profile, not the working copy');
});

test('run: the row is one the global view reads, and it matches the current text', () => {
  const root = newDir('root');
  const profile = `${PROFILE}\n## Risk class\n\nA (made up).\n\n## Paths\n\n- Ledgers: \`vault/ops/agent-ledger.csv\`\n`;
  const fx = makeFixture({ root, headProfile: profile });
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  git(fx.repo, 'checkout', '--quiet', 'main');
  assert.equal(runCli(fx, fake, 'one').status, 0);
  const view = buildView({ root, agentsDir: fx.agentsDir });
  assert.equal(view.projects.length, 1);
  assert.equal(view.totals.drill.rows, 1);
  assert.equal(view.totals.drill.malformed, 0);
  assert.equal(view.totals.drill.grouped, 1);
  const text = view.projects[0].texts.find((t) => t.reviewer === 'code-reviewer');
  assert.deepEqual(text, { reviewer: 'code-reviewer', current: true, scored: 1, planned: 1 });
});

// --- The boundary check ---

test('probe: passes only with a recorded denial on every route, in both runs, with the real flags', () => {
  const fake = makeFake();
  process.env.FAKE_CLAUDE_DIR = fake.dir;
  const report = runProbe({ claude: fake.bin, timeoutSec: 30, outDir: join(fake.dir, 'out') });
  assert.equal(report.ok, true, JSON.stringify(report.runs));
  assert.equal(report.runs.length, 2);
  const calls = fake.calls();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.argv.includes('--restricted'));
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'haiku');
    assert.equal(call.argv[call.argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.match(call.cwd, /repo-[ab]$/);
  }
  assert.equal(existsSync(dirname(calls[0].cwd)), false, 'the workspace is removed');
  assert.ok(existsSync(join(fake.dir, 'out', 'without-settings.json')));
  assert.ok(existsSync(join(fake.dir, 'out', 'with-settings.json')));
  const { shape } = report.runs[0];
  assert.equal(shape.subtype, 'success');
  assert.deepEqual(Object.keys(shape.modelUsage), ['claude-haiku-9-9']);
  assert.deepEqual(shape.denialFields.sort(), ['tool_input', 'tool_name', 'tool_use_id']);
  assert.equal(shape.denialCount, 7);
});

test('probe: an attempt not made fails, including the implicit no-index route', () => {
  const fake = makeFake();
  process.env.FAKE_CLAUDE_DIR = fake.dir;
  fake.probe('skip-cat');
  let report = runProbe({ claude: fake.bin, timeoutSec: 30 });
  assert.equal(report.ok, false);
  assert.ok(report.runs[0].problems.includes('no denial recorded: cat'));
  fake.probe('skip-implicit');
  report = runProbe({ claude: fake.bin, timeoutSec: 30 });
  assert.equal(report.ok, false);
  assert.ok(report.runs[0].problems.includes('no denial recorded: git diff with an outside path'));
});

test('probe: a project settings file that opens the boundary fails the probe', () => {
  const fake = makeFake();
  process.env.FAKE_CLAUDE_DIR = fake.dir;
  fake.probe('allowed-by-settings');
  const report = runProbe({ claude: fake.bin, timeoutSec: 30 });
  assert.equal(report.runs[0].ok, true);
  assert.equal(report.runs[1].ok, false);
  assert.equal(report.ok, false);
  assert.equal(report.refused, false);
});

test('probe: the sentinel in the answer fails, an error status fails', () => {
  const fake = makeFake();
  process.env.FAKE_CLAUDE_DIR = fake.dir;
  fake.probe('leak');
  let report = runProbe({ claude: fake.bin, timeoutSec: 30 });
  assert.equal(report.ok, false);
  assert.ok(report.runs[0].problems.includes('the sentinel reached the output'));
  fake.probe('status-error');
  report = runProbe({ claude: fake.bin, timeoutSec: 30 });
  assert.equal(report.ok, false);
  assert.ok(report.runs[0].problems.some((p) => p.startsWith('status ')));
});

test('probe: a timeout, a failed start or a crash counts as refused, with the exact error', () => {
  const fake = makeFake();
  process.env.FAKE_CLAUDE_DIR = fake.dir;
  fake.probe('sleep');
  let report = runProbe({ claude: fake.bin, timeoutSec: 1 });
  assert.equal(report.refused, true);
  assert.deepEqual(report.runs[0].problems, ['timed out']);
  assert.equal(report.runs.length, 1, 'no second attempt after a refusal');

  fake.probe('crash');
  report = runProbe({ claude: fake.bin, timeoutSec: 30 });
  assert.equal(report.refused, true);
  assert.match(report.runs[0].problems[0], /exit 1: cannot reach the service/);

  report = runProbe({ claude: join(fake.dir, 'absent'), timeoutSec: 5 });
  assert.equal(report.refused, true);
  assert.match(report.runs[0].problems[0], /ENOENT/);
});

test('checkBoundary: output that is not JSON or has no denial list fails', () => {
  const opts = { sentinel: 'marker-x', outside: '/tmp/elsewhere' };
  const base = { timedOut: false, error: null, exit: 0, stderr: '' };
  assert.equal(checkBoundary({ ...base, stdout: 'oops' }, opts).ok, false);
  const noList = checkBoundary(
    { ...base, stdout: reply('x', { permission_denials: undefined }) },
    opts,
  );
  assert.ok(noList.problems.includes('no denial list in the output'));
  assert.equal(checkBoundary({ ...base, stdout: 'null' }, opts).ok, false);
});

test('reviewerArgs: an outside path is denied for git diff, in every form it can take', () => {
  const denied = reviewerArgs({ agentsFile: 'a', agent: 'b', model: 'c', effort: 'd' });
  for (const rule of [
    'Bash(git diff *--no-index*)',
    'Bash(git diff /*)',
    'Bash(git diff * /*)',
    'Bash(git diff *../*)',
  ]) {
    assert.ok(denied.includes(rule), rule);
  }
});

// --- score and compare ---

function rawFolder(fx, batch, id) {
  const root = join(fx.repo, '.agent-runs');
  const folder = readdirSync(root).find((name) => name.endsWith(`-${batch}`));
  return join(root, folder, id);
}

test('score CLI: rescoring a saved answer needs no tokens and gives the same result', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  assert.equal(runCli(fx, fake, 'one').status, 0);
  const calls = fake.calls().length;
  const r = spawnSync(
    process.execPath,
    [DRILL, 'score', '--ledger-dir', fx.ledgerDir, '--raw', rawFolder(fx, 'one', 's01')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /s01: caught 1, other 0, malformed 0, planted 1/);
  assert.equal(fake.calls().length, calls);
  assert.equal(rowsOf(fx).length, 1, 'no row without --write');
});

test('score CLI: --write adds the row a dead run lost, once', () => {
  const fx = makeFixture();
  const fake = makeFake();
  fake.queue(canned(inWindow()));
  assert.equal(runCli(fx, fake, 'one').status, 0);
  const before = readFileSync(ledgerFile(fx), 'utf8');
  const header = before.split('\n')[0];
  writeFileSync(ledgerFile(fx), `${header}\n`);
  const score = (...extra) =>
    spawnSync(
      process.execPath,
      [
        DRILL,
        'score',
        '--ledger-dir',
        fx.ledgerDir,
        '--raw',
        rawFolder(fx, 'one', 's01'),
        ...extra,
      ],
      { encoding: 'utf8' },
    );
  assert.equal(score('--write').status, 0);
  assert.equal(readFileSync(ledgerFile(fx), 'utf8'), before);
  const twice = score('--write');
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /already has a row/);
  assert.equal(readFileSync(ledgerFile(fx), 'utf8'), before);
});

test('score CLI: a refused case stays unscored on a rescore', () => {
  const fx = makeFixture();
  addReplay(fx, 's02', {}, { spec: `${SPEC}\n${FIX_LINE}\n` });
  const fake = makeFake();
  fake.queue();
  assert.equal(runCli(fx, fake, 'one', ['--case', 's02']).status, 1);
  const r = spawnSync(
    process.execPath,
    [DRILL, 'score', '--ledger-dir', fx.ledgerDir, '--raw', rawFolder(fx, 'one', 's02')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /caught blank \(refused:/);
});

const row = (batch, id, caught, overrides = {}) => ({
  batch,
  case: id,
  caught: String(caught),
  planted: '1',
  reviewer: 'code-reviewer',
  model: 'claude-opus-9-9',
  batch_cases: '3',
  ...overrides,
});

test('compare: only cases scored in both, per case and per reviewer, and it says when too few', () => {
  const rows = [
    row('a', 's1', 1),
    row('a', 's2', 1),
    row('a', 's3', ''),
    row('a', 's4', 1),
    row('b', 's1', 0),
    row('b', 's2', 1),
    row('b', 's3', 1),
    row('b', 's5', 1),
    row('a', 'l1', 1, { reviewer: 'code-reviewer-light', model: 'claude-sonnet-9-9' }),
    row('b', 'l1', 1, { reviewer: 'code-reviewer-light', model: 'claude-sonnet-9-9' }),
  ];
  const { common, lines } = compareBatches(rows, 'a', 'b');
  assert.deepEqual(common, ['l1', 's1', 's2']);
  const text = lines.join('\n');
  assert.match(text, /compare a -> b: common 3, not compared 3/);
  assert.match(text, /s1 code-reviewer: claude-opus-9-9 1 of 1, claude-opus-9-9 0 of 1 \(lower\)/);
  assert.match(text, /code-reviewer: 2 of 2, then 1 of 2, n=2 \(lower\)/);
  assert.match(text, /code-reviewer-light: 1 of 1, then 1 of 1, n=1/);
  assert.ok(!text.includes('fewer than 3'));
  assert.ok(!text.includes('3 of 3'), 'groups are never summed');
});

test('compare: fewer than 3 in common is stated, and nothing in common is not a crash', () => {
  const few = compareBatches([row('a', 's1', 1), row('b', 's1', 1)], 'a', 'b');
  assert.match(few.lines.join('\n'), /fewer than 3 cases in common/);
  const none = compareBatches([], 'a', 'b');
  assert.deepEqual(none.common, []);
  assert.match(none.lines.join('\n'), /common 0, not compared 0/);
});

test('compare CLI: reads the ledger and counts malformed rows', () => {
  const dir = newDir('ledger');
  writeFileSync(
    join(dir, 'drill-ledger.csv'),
    `${LEDGER_COLUMNS.join(',')}\n2030-01-01,s1,replay,code-reviewer,m-1,high,2,1,1,0,a,1,h,0\n2030-01-02,s1,replay,code-reviewer,m-1,high,2,1,0,1,b,1,h,0\nshort,row\n`,
  );
  const r = spawnSync(
    process.execPath,
    [DRILL, 'compare', '--ledger-dir', dir, '--a', 'a', '--b', 'b'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /s1 code-reviewer: m-1 1 of 1, m-1 0 of 1 \(lower\)/);
  assert.match(r.stdout, /malformed ledger rows: 1/);
});

test('ledger: appendRow creates the header once, refuses commas, batchSummary counts scored rows', () => {
  const file = join(newDir('ledger'), 'drill-ledger.csv');
  const values = {
    date: '2030-01-01',
    case: 's1',
    kind: 'replay',
    batch: 'x',
    batch_cases: 3,
    caught: 1,
    planted: 1,
  };
  appendRow(file, values);
  appendRow(file, { ...values, case: 's2', caught: null });
  assert.throws(() => appendRow(file, { ...values, case: 'a,b' }), /comma/);
  const { rows } = readLedger(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(batchSummary(rows, 'x'), { rows: 2, scored: 1, batchCases: 3 });
  assert.deepEqual(batchSummary(rows, 'absent'), { rows: 0, scored: 0, batchCases: 0 });
  assert.deepEqual(readLedger(join(dirname(file), 'absent.csv')), {
    exists: false,
    rows: [],
    malformed: 0,
  });
});

// --- Clean-up ---

test('removeWorkspace: only a marked folder directly under the temp root', () => {
  const marked = createWorkspace();
  assert.equal(removeWorkspace(marked), true);
  assert.equal(existsSync(marked), false);
  assert.equal(removeWorkspace(marked), false, 'already gone');

  const unmarked = mkdtempSync(join(realpathSync(tmpdir()), 'rv-unmarked-'));
  writeFileSync(join(unmarked, 'keep.txt'), 'x');
  assert.equal(removeWorkspace(unmarked), false);
  assert.ok(existsSync(join(unmarked, 'keep.txt')));

  const wrongMark = mkdtempSync(join(realpathSync(tmpdir()), 'rv-wrong-'));
  writeFileSync(join(wrongMark, '.workspace-marker'), 'not ours\n');
  assert.equal(removeWorkspace(wrongMark), false);
  assert.ok(existsSync(wrongMark));

  const deeper = createWorkspace();
  const nested = join(deeper, 'inner');
  mkdirSync(nested);
  writeFileSync(join(nested, '.workspace-marker'), readFileSync(join(deeper, '.workspace-marker')));
  assert.equal(removeWorkspace(nested), false, 'marked, but not directly under the temp root');
  assert.ok(existsSync(nested));

  const elsewhere = createWorkspace();
  assert.equal(removeWorkspace(elsewhere, '/some/other/root'), false, 'outside the temp root');
  assert.ok(existsSync(elsewhere));

  assert.equal(removeWorkspace(deeper), true);
  assert.equal(removeWorkspace(elsewhere), true);
  rmSync(unmarked, { recursive: true });
  rmSync(wrongMark, { recursive: true });
});

// --- The rehearsal the plan names: real CLI, synthetic repo, synthetic private folder, fake `claude` ---

test('R6 part 1', (t) => {
  const say = (line) => t.diagnostic(line);
  const lastLines = (r) =>
    r.out
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('shape '))
      .join(' | ');
  const scenario = (name, fx, fake, batch, extra = []) => {
    const r = runCli(fx, fake, batch, extra);
    say(`${name} => exit ${r.status}: ${lastLines(r)}`);
    return r;
  };

  const fx = makeFixture();
  const fake = makeFake();

  fake.queue(canned(inWindow()));
  let r = scenario('in-window finding', fx, fake, 'r6-in');
  assert.match(r.out, /caught 1,/);

  fake.queue(canned(outside(2)));
  r = scenario('outside finding', fx, fake, 'r6-out');
  assert.match(r.out, /caught 0, other 1/);

  fake.queue(canned(`[bug] no location given\n${WIN}`));
  r = scenario('malformed line', fx, fake, 'r6-malformed');
  assert.match(r.out, /malformed 1/);
  assert.equal(rowsOf(fx).at(-1).malformed, '1');

  fake.queue(canned(inWindow(), { subtype: 'error_max_turns', is_error: true }));
  r = scenario('error status', fx, fake, 'r6-error');
  assert.match(r.out, /caught blank/);
  assert.equal(rowsOf(fx).at(-1).caught, '');

  fake.queue(canned('[bug] src/price.mjs:9: cut off here'));
  r = scenario('no Biggest win line', fx, fake, 'r6-cut');
  assert.match(r.out, /caught blank \(no Biggest win line\)/);
  assert.equal(rowsOf(fx).at(-1).caught, '');

  fake.queue(
    canned(inWindow(), {
      permission_denials: [{ tool_name: 'Read', tool_input: { file_path: 'docs/agents.md' } }],
    }),
  );
  r = scenario('denied required read', fx, fake, 'r6-denied');
  assert.match(r.out, /caught blank \(a required read was denied\)/);
  assert.equal(rowsOf(fx).at(-1).caught, '');

  // The clone itself, checked independently of the runner's own checks.
  const { prepared } = prepare(fx);
  const later = [fx.future, fx.fix].map((sha) => gitStatus(prepared.clone, 'cat-file', '-e', sha));
  const inLog = git(prepared.clone, 'log', '--all', '-p').includes(FIX_LINE.trim());
  const inTree =
    spawnSync('git', ['grep', '-F', FIX_LINE.trim()], { cwd: prepared.clone, env: GIT_ENV })
      .status === 0;
  const inVault = readdirSync(join(prepared.clone, 'vault')).length;
  say(
    `future commit, fix commit: cat-file exit ${later.join(', ')}; fix line in log ${inLog}, in tree ${inTree}; private folder entries ${inVault}`,
  );
  assert.ok(later.every((status) => status !== 0));
  assert.equal(inLog, false);
  assert.equal(inTree, false);
  assert.equal(inVault, 0);

  addReplay(fx, 'leaky', {}, { spec: `${SPEC}\n${FIX_LINE}\n` });
  fake.queue();
  const reviewsBefore = fake.reviews().length;
  r = scenario('leak planted in the spec', fx, fake, 'r6-leak', ['--case', 'leaky']);
  assert.match(r.out, /refused: 1 line of the later fix or key in the spec/);
  assert.equal(fake.reviews().length, reviewsBefore, 'the reviewer never started');
  assert.equal(rowsOf(fx).at(-1).caught, '');
  rmSync(join(fx.ledgerDir, 'drills', 'leaky'), { recursive: true });

  addPlanted(fx, 'p01');
  addReplay(fx, 's03');
  fake.queue(canned(inWindow()), canned('cut off'));
  r = scenario('a case left unscored', fx, fake, 'r6-partial');
  const summary = batchSummary(rowsOf(fx), 'r6-partial');
  say(`summary: scored ${summary.scored}, batch_cases ${summary.batchCases}, rows ${summary.rows}`);
  assert.equal(r.status, 1);
  assert.ok(summary.scored < summary.batchCases);
  assert.equal(summary.rows, 2, 'the batch stops at the first unscored case');
});
