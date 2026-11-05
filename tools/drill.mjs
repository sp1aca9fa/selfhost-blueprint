#!/usr/bin/env node
// Measures what code reviews miss: a past change with a known bug goes to a reviewer on a throwaway
// clone, and a script scores the answer against a key. No dependencies, no project data.
//
//   node tools/drill.mjs validate --repo <repo> --ledger-dir <folder> [--case a,b] [--show-anchors]
//   node tools/drill.mjs run --repo <repo> --ledger-dir <folder> --batch <name> [--case a,b]
//     [--reviewer <name>] [--agents-dir <folder>] [--model <m>] [--effort <e>]
//     [--test-allow <rule>]... [--install <cmd>]
//   node tools/drill.mjs probe [--out <folder>]
//   node tools/drill.mjs score --ledger-dir <folder> --raw <one case's raw folder> [--write]
//   node tools/drill.mjs compare --ledger-dir <folder> --a <batch> --b <batch>
//
// `--ledger-dir` is the folder holding `agent-ledger.csv`: cases are in `drills/<id>/` there, and
// `drill-ledger.csv` sits beside it. Only `validate --show-anchors` prints anything from a key, for
// the case's author: a session that edits reviewer texts reads ledger counts and nothing else.
//
// Rules, from the setup-review design:
// - Scored only when the JSON status shows success, the answer's last non-empty line starts
//   `Biggest win:` (one report sentence of the user's global rules may follow it), no required read
//   was denied, the model matches and the anchors held. Otherwise the row has `caught` blank: unknown,
//   never 0.
// - A bug is caught when any finding overlaps any of its windows. Findings outside every window are
//   counted, not judged. A finding range wider than a window can be never counts as caught: it counts
//   as `other`, so a wide finding on the real bug reads as a miss, and width cannot buy a catch.
// - A miss is believed only when every location was readable. With caught below planted, a
//   malformed line carrying a file or line token, or a finding's file not in the reviewed tree, leaves
//   `caught` blank: a real catch must not read as 0 because of how its location was written.
// - The reviewer works in a clone that holds nothing later than the change. The script checks that
//   and refuses to start otherwise. The word used for this programme appears in no prompt, folder or
//   profile the reviewer can see.
// - Rows are appended, never edited. A batch name is used once.
//
// Limits: replayed bugs are ones a reviewer once caught, so recall reads high. Planted bugs are
// written by the same model family. A finding in a window about something else still counts. The
// requested effort cannot be verified from the output. A model may still guess it is being measured.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// One definition each, shared with the global view, so the two can never disagree.
import {
  caseHash,
  contextHash,
  globalRulesPath,
  hashParts,
  HEADERS,
  modelMatches,
  profileModel,
  readGlobalRules,
} from './setup-view.mjs';

export { profileModel };

export const LEDGER_COLUMNS = HEADERS.drill.new;
export const MAX_WINDOW_LINES = 40;
// Shorter lines match by chance, so they say nothing about a leak.
export const MIN_LEAK_CHARS = 20;
// A small helper model may run beside the reviewer. At this share of the top model's output tokens
// or above, it was a second model doing the review (a fallback midway), so the run is unscored.
export const MIXED_MODEL_SHARE = 0.1;

const SLUG = /^[a-z0-9-]+$/;
const MODEL_ID = /^[a-z0-9.-]+$/;
const EFFORT = /^[a-z]+$/;
const SHA = /^[0-9a-f]{7,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAGS = ['bug', 'fix', 'ask'];
const MAX_OUTPUT = 512 * 1024 * 1024;
const REVIEW_TIMEOUT_SEC = 3600;
const PROBE_TIMEOUT_SEC = 300;
const COMMAND_TIMEOUT_SEC = 3600;
const PROBE_MODEL = 'haiku';
const PROBE_EFFORT = 'low';
const PROBE_AGENT = 'file-check';
const MARKER = '.workspace-marker';
const MARKER_TEXT = 'throwaway review workspace, safe to delete\n';
const OVERLAID = ['docs/agents.md', 'CLAUDE.md'];

const DEFAULT_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude', 'agents');

// What the agent texts permit: `git diff/log/show`, the test command, and the file tools. Everything
// else is denied by `--permission-mode dontAsk`.
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git diff)',
  'Bash(git diff *)',
  'Bash(git log)',
  'Bash(git log *)',
  'Bash(git show)',
  'Bash(git show *)',
];

// `git diff` compares files on disk with `--no-index`, and it also does so unasked when one path is
// outside the work tree (`git diff /elsewhere/file README.md` prints the outside file). So a path
// that leaves the clone is denied along with the flag. `--output` writes a file.
const DENIED_TOOLS = [
  'Bash(git diff *--no-index*)',
  'Bash(git diff /*)',
  'Bash(git diff * /*)',
  'Bash(git diff *../*)',
  'Bash(git diff ~*)',
  'Bash(git diff * ~*)',
  'Bash(git diff *$*)',
  'Bash(git diff *"/*)',
  "Bash(git diff *'/*)",
  'Bash(git diff *--output*)',
  'Bash(git log *--output*)',
  'Bash(git show *--output*)',
];

// A denied command matching one of these is the boundary doing its work, not a missing read.
// `*` matches anything, spaces included, as in the permission rules themselves.
export function isBoundaryDenial(command) {
  return DENIED_TOOLS.some((rule) => {
    const pattern = rule.slice('Bash('.length, -1);
    const body = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${body.join('[\\s\\S]*')}$`).test(command.trim());
  });
}

// `git diff`, `git log` or `git show`, with any global options in front (`git --no-pager log`,
// `git -C <folder> diff`). The reviewer's only view of the change goes through these.
const GIT_READ = /^\s*git(?:\s+-c\s+\S+|\s+-C\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(?:diff|log|show)\b/;

class Refusal extends Error {}

// --- Small helpers ---

// Every git and reviewer process sees none of the user's git config and no inherited GIT_* state, so
// the clone behaves the same everywhere and nothing points back at the source repo.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  delete env.OLDPWD;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function git(cwd, args, { ok = [0], env, encoding = 'utf8' } = {}) {
  const r = spawnSync('git', args, { cwd, encoding, env: cleanEnv(env), maxBuffer: MAX_OUTPUT });
  if (r.error) throw new Refusal(`git ${args[0]}: ${r.error.message}`);
  if (!ok.includes(r.status)) {
    const first = String(r.stderr).trim().split('\n')[0];
    throw new Refusal(`git ${args[0]} failed: ${first}`);
  }
  return r;
}

const gitOut = (cwd, args, options) => git(cwd, args, options).stdout.trim();

function headFile(source, file) {
  const r = git(source, ['show', `HEAD:${file}`], { ok: [0, 128], encoding: 'buffer' });
  return r.status === 0 ? r.stdout : null;
}

function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function runShell(command, cwd) {
  const r = spawnSync(command, {
    shell: true,
    cwd,
    env: cleanEnv(),
    stdio: 'ignore',
    timeout: COMMAND_TIMEOUT_SEC * 1000,
    killSignal: 'SIGKILL',
  });
  return r.status === 0;
}

function invoke(claude, args, { cwd, prompt, timeoutSec }) {
  const r = spawnSync(claude, args, {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
    env: cleanEnv({ PWD: cwd }),
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exit: r.status,
    signal: r.signal,
    error: r.error ? r.error.message : null,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

// --- The workspace: a neutrally named folder, removed only when it is certainly ours ---

function tempRoot() {
  return realpathSync(tmpdir());
}

export function createWorkspace() {
  const dir = mkdtempSync(join(tempRoot(), 'rv-'));
  writeFileSync(join(dir, MARKER), MARKER_TEXT);
  return dir;
}

// Removes only a folder directly under the temp root that holds the runner's marker. Anything else
// stays where it is and the caller is told.
export function removeWorkspace(dir, root = tempRoot()) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  if (dirname(real) !== root) return false;
  const marker = join(real, MARKER);
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== MARKER_TEXT) return false;
  rmSync(real, { recursive: true, force: true });
  return true;
}

function dropWorkspace(dir) {
  if (!removeWorkspace(dir)) process.stderr.write(`drill: left in place: ${dir}\n`);
}

// --- Parsing the reviewer's answer ---

function toRange(a, b) {
  const from = Number(a);
  const to = b === undefined ? from : Number(b);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1) return null;
  return from <= to ? [from, to] : [to, from];
}

export function normalizePath(file, prefixes = []) {
  let out = file;
  for (const prefix of prefixes) {
    if (prefix && out.startsWith(`${prefix}/`)) {
      out = out.slice(prefix.length + 1);
      break;
    }
  }
  return posix.normalize(out);
}

function parseLocation(text, prefixes) {
  const m = /^([^\s:]+):(\d+)(?:\s*[-–]\s*(\d+))?(?!\w)/.exec(text);
  if (!m) return null;
  const ranges = [toRange(m[2], m[3])];
  const more = /^((?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)+)\s*(?::|$)/.exec(text.slice(m[0].length));
  if (more) {
    for (const part of more[1].split(',').slice(1)) {
      const [a, b] = part.split(/[-–]/).map((s) => s.trim());
      ranges.push(toRange(a, b));
    }
  }
  if (ranges.some((r) => r === null)) return null;
  return { file: normalizePath(m[1], prefixes), ranges };
}

// A path or a name with an extension, `line 120`, `L120`, `:120` or `(120)`. Prose such as "No [bug]
// found" has none, so it cannot leave a run unscored. `e.g.` and `i.e.` are not file names.
function hasLocationToken(line) {
  const text = line.replace(/\b(?:e\.g|i\.e)\b/gi, '');
  return /[\w@-]\/[\w@.-]|\b[\w@-]+\.[a-z][a-z0-9]{0,5}\b|\blines?\s+\d|\bL\d|:\d|\(\d+\)/i.test(text);
}

// Reads the reviewer's own format, `[bug|fix|ask] file:line: ...`, through bullets, backticks, bold,
// `./`, the clone's path prefix and `line-line` ranges. A line that starts like a finding but has no
// file:line is malformed: counted, never a crash and never a silent miss.
export function parseFindings(answer, { prefixes = [] } = {}) {
  const findings = [];
  let malformed = 0;
  let located = 0;
  const slip = (line) => {
    malformed += 1;
    if (hasLocationToken(line)) located += 1;
  };
  const text = typeof answer === 'string' ? answer : '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/[*`]/g, '')
      .replace(/^[\s>#]*(?:[-+•]\s+|\d+[.)]\s+)?/, '')
      .replace(/^\s*_+(?=\[)/, '')
      .replace(/(?<=\])_+/, '');
    const tagged = /^\[([^\]]*)\]\s*:?\s*(.*)$/.exec(line);
    if (tagged) {
      const tag = tagged[1].trim().toLowerCase();
      const location = parseLocation(tagged[2], prefixes);
      if (TAGS.includes(tag)) {
        if (location) findings.push({ tag, ...location });
        else slip(line);
      } else if (location) {
        slip(line);
      }
    } else if (
      /^[\w.@/-]*[./][\w.@/-]*:\d+(?!\w)/.test(line) ||
      /^(?:bug|fix|ask)\b\s*:?\s*[^\s:]+:\d+/i.test(line) ||
      /\[(?:bug|fix|ask)\]/i.test(line)
    ) {
      // A location with no tag, a tag with no brackets, or a tag inside a table or a sentence: a
      // format slip, which must not read as no findings at all.
      slip(line);
    }
  }
  return { findings, malformed, located };
}

function sameFile(found, wanted) {
  return found === wanted || found === `a/${wanted}` || found === `b/${wanted}`;
}

function overlaps(finding, window) {
  if (!sameFile(finding.file, window.file)) return false;
  return finding.ranges.some(
    ([from, to]) => to - from + 1 <= MAX_WINDOW_LINES && from <= window.to && to >= window.from,
  );
}

export function scoreFindings(findings, bugs) {
  const caughtBugs = bugs
    .filter((bug) => bug.windows.some((w) => findings.some((f) => overlaps(f, w))))
    .map((bug) => bug.id);
  const other = findings.filter(
    (f) => !bugs.some((bug) => bug.windows.some((w) => overlaps(f, w))),
  ).length;
  return { caught: caughtBugs.length, caughtBugs, other };
}

// The user's global rules end every report with one of these, so a complete answer may carry one
// after its Biggest win line.
const REPORT_SENTENCE = /^(?:No new actions raised\.|New actions from this round are in \S.*)$/;

// Both reviewers must end with this line, so its absence means a cut-off or off-format answer.
export function endsWithBiggestWin(answer) {
  if (typeof answer !== 'string') return false;
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.replace(/[*_`]/g, '').replace(/^[-#>\s]+/, '').trim())
    .filter((l) => l !== '');
  if (lines.length > 1 && REPORT_SENTENCE.test(lines.at(-1))) lines.pop();
  return (lines.at(-1) ?? '').startsWith('Biggest win:');
}

// `requested` is an alias (`opus`) or a concrete id. The review ran on the model with the most output
// tokens. Returns the concrete id for the ledger, and a problem when it cannot be trusted.
export function resolveModel(modelUsage, requested) {
  if (modelUsage === null || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return { model: null, problem: 'no modelUsage in the output' };
  }
  const entries = Object.entries(modelUsage).map(([id, usage]) => ({
    id: id.replace(/\[.*\]$/, ''),
    output: Number(usage?.outputTokens),
  }));
  if (entries.length === 0) return { model: null, problem: 'modelUsage is empty' };
  if (entries.length > 1 && entries.some((e) => !Number.isFinite(e.output))) {
    return { model: null, problem: 'several models and no token counts to rank them' };
  }
  const [top, ...rest] = [...entries].sort((a, b) => b.output - a.output);
  if (!MODEL_ID.test(top.id)) return { model: null, problem: 'model id not readable' };
  if (rest.some((e) => e.output >= top.output * MIXED_MODEL_SHARE)) {
    return { model: top.id, problem: 'more than one model did the work' };
  }
  if (!modelMatches(top.id, requested)) {
    return { model: top.id, problem: `model ${top.id} is not the requested ${requested}` };
  }
  return { model: top.id, problem: null };
}

// Scores one reviewer run. Unknown stays unknown: any doubt leaves `scored` false and the row blank.
export function scoreRun({ bugs, stdout, exit, requestedModel, clone, specPath, files }) {
  const reasons = [];
  let output = null;
  try {
    output = JSON.parse(stdout);
  } catch {
    reasons.push('output is not JSON');
  }
  if (output === null || typeof output !== 'object') {
    if (reasons.length === 0) reasons.push('output is not a JSON object');
    return { scored: false, reasons, model: null };
  }
  if (exit !== 0) reasons.push(`exit ${exit}`);
  if (output.subtype !== 'success' || output.is_error !== false) {
    reasons.push(`status ${output.subtype ?? 'missing'}`);
  }
  const answer = output.result;
  if (!endsWithBiggestWin(answer)) reasons.push('no Biggest win line');

  const prefixes = clone ? [clone] : [];
  if (Array.isArray(output.permission_denials)) {
    const required = [...OVERLAID, specPath];
    for (const denial of output.permission_denials) {
      if (deniedRequiredRead(denial, required, prefixes)) {
        reasons.push('a required read was denied');
        break;
      }
    }
  } else {
    // No list means no proof that the required reads went through.
    reasons.push('no denial list in the output');
  }

  const { model, problem } = resolveModel(output.modelUsage, requestedModel);
  if (problem) reasons.push(problem);
  if (reasons.length > 0) return { scored: false, reasons, model };

  const { findings, malformed, located } = parseFindings(answer, { prefixes });
  const { caught, caughtBugs, other } = scoreFindings(findings, bugs);
  // Only a miss is in doubt: every bug caught needs no more proof. The reasons name no file or window.
  if (caught < bugs.length) {
    const doubts = [];
    if (located > 0) doubts.push('a finding has a location that could not be read');
    if (!Array.isArray(files)) {
      if (findings.length > 0) doubts.push('no file list to check the findings against');
    } else if (findings.some((f) => !inFileList(f.file, files))) {
      doubts.push('a finding names a path not in the reviewed tree');
    }
    if (doubts.length > 0) return { scored: false, reasons: doubts, model };
  }
  return { scored: true, reasons, model, caught, caughtBugs, other, malformed };
}

function inFileList(file, files) {
  return files.some((name) => sameFile(file, name));
}

// A denied Read of the profile, the rules or the spec, or a denied look at the change itself. Unknown
// counts: a denial with no readable path or command may have been a required one. A denial matching
// the deny list is the boundary working: it must not stop a batch.
function deniedRequiredRead(denial, required, prefixes) {
  if (denial?.tool_name === 'Read') {
    const file = denial.tool_input?.file_path;
    return typeof file !== 'string' || required.includes(normalizePath(file, prefixes));
  }
  if (denial?.tool_name === 'Bash') {
    const command = denial.tool_input?.command;
    if (typeof command !== 'string') return true;
    return GIT_READ.test(command) && !isBoundaryDenial(command);
  }
  return false;
}

// --- Case files ---

export function anchorOf(text, from, to) {
  const lines = text.split('\n').slice(from - 1, to);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function parseChecks(line) {
  const m = /^(.*\S): (pass|fail\b.*)$/.exec(typeof line === 'string' ? line : '');
  return m ? { command: m[1], result: m[2] } : null;
}

// Messages name bugs by id and windows by position: never their text, file or lines.
export function caseProblems(c, caseDir) {
  const problems = [];
  const isDate = (v) => typeof v === 'string' && DATE.test(v);
  const isSha = (v) => typeof v === 'string' && SHA.test(v);
  if (typeof c.id !== 'string' || !SLUG.test(c.id)) problems.push('id is not a lowercase slug');
  if (c.id !== basename(caseDir)) problems.push('id differs from its folder');
  if (!['replay', 'planted'].includes(c.kind)) problems.push('kind is not replay or planted');
  if (typeof c.reviewer !== 'string' || !SLUG.test(c.reviewer))
    problems.push('reviewer not a slug');
  if (![1, 2, 3].includes(c.tier)) problems.push('tier is not 1, 2 or 3');
  if (!isSha(c.base) || !isSha(c.buggy)) problems.push('base and buggy must be shas');
  if (c.kind === 'replay' && !isSha(c.fix)) problems.push('a replay case needs a fix sha');
  if (c.kind === 'planted') {
    if (c.fix !== null) problems.push('a planted case has fix null');
    if (!existsSync(join(caseDir, 'planted.patch'))) problems.push('planted.patch is missing');
  }
  if (!isDate(c.added)) problems.push('added is not a date');
  if (c.retired !== null && !isDate(c.retired)) problems.push('retired is not null or a date');
  if (parseChecks(c.checks) === null) problems.push('checks is not "<command>: <result>"');
  if (!existsSync(join(caseDir, 'spec.md'))) problems.push('spec.md is missing');
  if (!Array.isArray(c.bugs) || c.bugs.length === 0) {
    problems.push('no bugs');
    return problems;
  }
  const ids = new Set();
  c.bugs.forEach((bug, b) => {
    const name = `bug ${b + 1}`;
    if (typeof bug?.id !== 'string' || !SLUG.test(bug.id)) problems.push(`${name}: id not a slug`);
    if (ids.has(bug?.id)) problems.push(`${name}: duplicate id`);
    ids.add(bug?.id);
    if (typeof bug?.what !== 'string' || bug.what.trim() === '' || bug.what.includes('\n')) {
      problems.push(`${name}: what must be one line`);
    }
    if (!Array.isArray(bug?.windows) || bug.windows.length === 0) {
      problems.push(`${name}: no windows`);
      return;
    }
    bug.windows.forEach((w, i) => {
      const where = `${name} window ${i + 1}`;
      const fileOk =
        typeof w?.file === 'string' &&
        w.file !== '' &&
        !isAbsolute(w.file) &&
        !w.file.includes('..');
      if (!fileOk) problems.push(`${where}: file must be a path inside the repo`);
      if (!Number.isInteger(w?.from) || !Number.isInteger(w?.to) || w.from < 1 || w.to < w.from) {
        problems.push(`${where}: from and to must be lines, from first`);
      } else if (w.to - w.from + 1 > MAX_WINDOW_LINES) {
        problems.push(`${where}: over ${MAX_WINDOW_LINES} lines`);
      }
    });
  });
  return problems;
}

// All case ids in the folder, or the named ones.
export function caseIds(ledgerDir, only) {
  if (only) return only.split(',').map((s) => s.trim());
  const dir = join(ledgerDir, 'drills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function loadCase(ledgerDir, id) {
  const caseDir = join(ledgerDir, 'drills', id);
  if (!SLUG.test(id)) return { caseDir, caseDef: null, problems: ['case name is not a slug'] };
  const file = join(caseDir, 'case.json');
  if (!existsSync(file)) return { caseDir, caseDef: null, problems: ['case.json is missing'] };
  let caseDef;
  try {
    caseDef = readJson(file);
  } catch {
    return { caseDir, caseDef: null, problems: ['case.json is not JSON'] };
  }
  if (caseDef === null || typeof caseDef !== 'object') {
    return { caseDir, caseDef: null, problems: ['case.json is not an object'] };
  }
  return { caseDir, caseDef, problems: caseProblems(caseDef, caseDir) };
}

// Commits and ancestry in the source repo. `fix` must come after `buggy`: a fix that came first would
// mean the buggy version was not what was reviewed.
export function sourceProblems(source, c) {
  const problems = [];
  const exists = (sha) =>
    git(source, ['cat-file', '-e', `${sha}^{commit}`], { ok: [0, 1, 128] }).status === 0;
  const missing = [c.base, c.buggy, ...(c.kind === 'replay' ? [c.fix] : [])].filter(
    (s) => !exists(s),
  );
  if (missing.length > 0) return [`${plural(missing.length, 'commit')} not found in the repo`];
  const isAncestor = (a, b) =>
    git(source, ['merge-base', '--is-ancestor', a, b], { ok: [0, 1] }).status === 0;
  if (!isAncestor(c.base, c.buggy)) problems.push('base is not an ancestor of buggy');
  if (c.kind === 'replay' && !isAncestor(c.buggy, c.fix))
    problems.push('buggy is not an ancestor of fix');
  return problems;
}

// --- Diffs ---

function diffPath(raw) {
  const cleaned = raw
    .split('\t')[0]
    .trim()
    .replace(/^"(.*)"$/, '$1');
  if (cleaned === '/dev/null') return null;
  return cleaned.replace(/^[ab]\//, '');
}

// A unified diff as files and hunks. Hunk bodies are consumed by their counts, so a content line that
// starts `+++` is never read as a header.
export function parseDiff(text) {
  const files = [];
  let current = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('+++ ')) {
      current = { file: diffPath(line.slice(4)), hunks: [] };
      files.push(current);
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || current === null) continue;
    let oldLeft = m[1] === undefined ? 1 : Number(m[1]);
    let newLeft = m[3] === undefined ? 1 : Number(m[3]);
    const hunk = { newStart: Number(m[2]), newCount: newLeft, added: [], removed: [] };
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
      i += 1;
      const body = lines[i];
      if (body.startsWith('\\')) continue;
      if (body.startsWith('+')) {
        hunk.added.push(body.slice(1));
        newLeft -= 1;
      } else if (body.startsWith('-')) {
        hunk.removed.push(body.slice(1));
        oldLeft -= 1;
      } else {
        oldLeft -= 1;
        newLeft -= 1;
      }
    }
    current.hunks.push(hunk);
  }
  return files;
}

// Lines the reviewer must not see: the later fix's added lines (for a planted case the patch's removed
// lines stand in for them), and the key's own sentences.
function forbiddenLines(source, caseDir, c) {
  let lines;
  if (c.kind === 'replay') {
    const diff = gitOut(source, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--ignore-submodules',
      '--unified=0',
      c.buggy,
      c.fix,
    ]);
    lines = parseDiff(diff).flatMap((f) => f.hunks.flatMap((h) => h.added));
  } else {
    const patch = readFileSync(join(caseDir, 'planted.patch'), 'utf8');
    lines = parseDiff(patch).flatMap((f) => f.hunks.flatMap((h) => h.removed));
  }
  lines = [...lines, ...c.bugs.map((bug) => bug.what)];
  return [...new Set(lines.map((l) => l.trim()).filter((l) => l.length >= MIN_LEAK_CHARS))];
}

// Which of the lines occur in a tree. `git grep` finds the few files worth reading.
function linesInTree(repo, tree, lines, scratchDir) {
  if (lines.length === 0) return new Set();
  const patterns = join(scratchDir, 'patterns.txt');
  writeFileSync(patterns, `${lines.join('\n')}\n`);
  const r = git(repo, ['grep', '-I', '-F', '-l', '-z', '-f', patterns, tree], { ok: [0, 1] });
  rmSync(patterns);
  const found = new Set();
  const names = r.stdout.split('\0').filter((n) => n !== '');
  for (const name of names) {
    const blob = git(repo, ['show', name]).stdout;
    for (const line of lines) {
      if (blob.includes(line)) found.add(line);
    }
  }
  return found;
}

// --- The clone ---

function writeOverlay(clone, texts) {
  for (const file of OVERLAID) {
    mkdirSync(dirname(join(clone, file)), { recursive: true });
    writeFileSync(join(clone, file), texts[file]);
  }
  git(clone, ['add', '-f', '--', ...OVERLAID]);
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.invalid',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.invalid',
};

function commit(clone, message) {
  git(clone, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', message], {
    env: IDENTITY,
  });
  return gitOut(clone, ['rev-parse', 'HEAD']);
}

export function buildPrompt({ range, specPath, checks }) {
  return `Review this change.\nCommit range: ${range}\nSpec: ${specPath}\nCHECKS output: ${checks}\n`;
}

// Builds the reviewer's clone: base, today's profile and rules overlaid as a commit, the change as one
// commit dated today with the real subject, and nothing else. `texts` holds the overlaid files.
export function prepareClone({ source, caseDir, caseDef: c, workspace, texts, date }) {
  const clone = join(workspace, 'repo');
  git(workspace, [
    'clone',
    '--quiet',
    '--local',
    '--no-hardlinks',
    '--no-checkout',
    '--no-recurse-submodules',
    '--template=',
    '--',
    source,
    clone,
  ]);
  git(clone, ['config', 'protocol.allow', 'never']);
  git(clone, ['config', 'core.logAllRefUpdates', 'false']);
  git(clone, ['checkout', '--quiet', '--detach', c.base]);

  writeOverlay(clone, texts);
  const overlayChanged = git(clone, ['diff', '--cached', '--quiet'], { ok: [0, 1] }).status === 1;
  const rangeStart = overlayChanged
    ? commit(clone, 'Project docs')
    : gitOut(clone, ['rev-parse', 'HEAD']);

  git(clone, ['read-tree', '--reset', '-u', c.buggy]);
  if (c.kind === 'planted') {
    const patch = join(caseDir, 'planted.patch');
    const applied = git(clone, ['apply', '--index', '--whitespace=nowarn', patch], {
      ok: [0, 1, 128],
    });
    if (applied.status !== 0) throw new Refusal('planted.patch does not apply');
  }
  // The tree the reviewer should see, before the overlay. A forbidden line already in it is ordinary
  // code that also exists elsewhere, not a leak.
  const refTree = gitOut(clone, ['write-tree']);
  const forbidden = forbiddenLines(source, caseDir, c);
  const already = linesInTree(clone, refTree, forbidden, workspace);
  const patterns = forbidden.filter((l) => !already.has(l));

  writeOverlay(clone, texts);
  if (git(clone, ['diff', '--cached', '--quiet'], { ok: [0, 1] }).status === 0) {
    throw new Refusal('the change is empty');
  }
  const subject = gitOut(source, ['log', '-1', '--format=%s', c.buggy]);
  const change = commit(clone, subject);

  git(clone, ['remote', 'remove', 'origin']);
  git(clone, ['update-ref', 'refs/heads/main', change]);
  git(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const ref of gitOut(clone, ['for-each-ref', '--format=%(refname)']).split('\n')) {
    if (ref !== '' && ref !== 'refs/heads/main') git(clone, ['update-ref', '-d', ref]);
  }
  for (const leftover of ['ORIG_HEAD', 'FETCH_HEAD']) {
    rmSync(join(clone, '.git', leftover), { force: true });
  }
  git(clone, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  rmSync(join(clone, '.git', 'logs'), { recursive: true, force: true });
  git(clone, ['gc', '--prune=now', '--quiet']);

  for (const name of submoduleNames(clone)) {
    git(clone, ['config', `submodule.${name}.update`, 'none']);
  }

  const specPath = `.agent-runs/${date}-change/spec.md`;
  mkdirSync(dirname(join(clone, specPath)), { recursive: true });
  writeFileSync(join(clone, specPath), readFileSync(join(caseDir, 'spec.md')));
  mkdirSync(join(clone, '.git', 'info'), { recursive: true });
  appendFileSync(join(clone, '.git', 'info', 'exclude'), '.agent-runs/\n');

  return { clone, rangeStart, change, specPath, patterns };
}

// Every path a finding can honestly name: both sides of the reviewed range (a file the change
// deletes is still a real file) and the spec. Kept with the raw answer, for a later rescore.
function reviewedFiles({ clone, rangeStart, change, specPath }) {
  const list = (rev) =>
    git(clone, ['ls-tree', '-r', '-z', '--name-only', rev]).stdout.split('\0').filter(Boolean);
  return [...new Set([...list(rangeStart), ...list(change), specPath])].sort();
}

function submoduleNames(clone) {
  if (!existsSync(join(clone, '.gitmodules'))) return [];
  const r = git(
    clone,
    ['config', '--file', '.gitmodules', '--name-only', '--get-regexp', '^submodule\\..*\\.path$'],
    { ok: [0, 1] },
  );
  return r.stdout
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.replace(/^submodule\./, '').replace(/\.path$/, ''));
}

function gitlinkPaths(clone) {
  return git(clone, ['ls-tree', '-r', '-z', 'HEAD'])
    .stdout.split('\0')
    .filter((entry) => entry.startsWith('160000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1));
}

// Every commit that must not be in the clone: each source ref's tip not already in base's history,
// the source's HEAD, `buggy` and `fix`.
function laterCommits(source, c) {
  const listed = gitOut(source, [
    'for-each-ref',
    '--format=%(objectname) %(objecttype) %(*objectname)',
  ])
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(' '))
    .filter(([, type]) => type === 'commit' || type === 'tag')
    .map(([sha, type, peeled]) => (type === 'tag' ? peeled : sha))
    .filter((sha) => SHA.test(sha ?? ''));
  const tips = [...listed, gitOut(source, ['rev-parse', 'HEAD'])];
  const later = tips.filter(
    (sha) =>
      git(source, ['merge-base', '--is-ancestor', sha, c.base], { ok: [0, 1, 128] }).status !== 0,
  );
  return [...new Set([...later, c.buggy, ...(c.fix ? [c.fix] : [])])];
}

// Refuses a run when the clone could tell the reviewer more than a real review would know. Returns
// problems, in counts only: the text of a leak must not reach a session's output.
export function checkClone({ source, ledgerDir, caseDef: c, prepared }) {
  const { clone, change, specPath, patterns } = prepared;
  const problems = [];

  const present = laterCommits(source, c).filter(
    (sha) => git(clone, ['cat-file', '-e', sha], { ok: [0, 1, 128] }).status === 0,
  );
  if (present.length > 0) problems.push(`${plural(present.length, 'later commit')} in the clone`);

  const newest = gitOut(clone, ['log', '--all', '--format=%H', '-1']);
  const allCount = gitOut(clone, ['rev-list', '--all', '--count']);
  const changeCount = gitOut(clone, ['rev-list', '--count', change]);
  if (newest !== change || allCount !== changeCount)
    problems.push('log --all does not end at the change');
  const refs = gitOut(clone, ['for-each-ref', '--format=%(refname)']);
  if (refs !== 'refs/heads/main') problems.push('refs other than the change remain');

  const fsck = git(
    clone,
    ['fsck', '--unreachable', '--no-reflogs', '--connectivity-only', '--no-progress'],
    {
      ok: [0, 1, 2, 3, 4, 5, 6, 7],
    },
  );
  const stray = fsck.stdout.split('\n').filter((l) => l.startsWith('unreachable ')).length;
  if (stray > 0) problems.push(`${plural(stray, 'unreachable object')} in the clone`);

  if (gitOut(clone, ['remote']) !== '') problems.push('the clone has a remote');
  if (gitOut(clone, ['config', '--get', 'protocol.allow'], { ok: [0, 1] }) !== 'never') {
    problems.push('protocol.allow is not never');
  }
  for (const name of submoduleNames(clone)) {
    const value = gitOut(clone, ['config', '--get', `submodule.${name}.update`], { ok: [0, 1] });
    if (value !== 'none') problems.push('a submodule can still be updated');
  }

  for (const link of gitlinkPaths(clone)) {
    const dir = join(clone, link);
    if (existsSync(dir) && readdirSync(dir).length > 0)
      problems.push('a submodule folder is not empty');
  }

  const fromRepo = relative(source, ledgerDir);
  if (!fromRepo.startsWith('..') && !isAbsolute(fromRepo)) {
    if (existsSync(join(clone, fromRepo, 'drills')))
      problems.push('the cases are inside the clone');
  }

  if (gitOut(clone, ['status', '--porcelain']) !== '') problems.push('the clone has changed files');

  const inTree = linesInTree(clone, 'HEAD', patterns, dirname(clone)).size;
  if (inTree > 0)
    problems.push(`${plural(inTree, 'line')} of the later fix or key in the clone tree`);
  const messages = gitOut(clone, ['log', '-2', '--format=%B']);
  const inMessage = patterns.filter((l) => messages.includes(l)).length;
  if (inMessage > 0)
    problems.push(`${plural(inMessage, 'line')} of the later fix or key in a commit message`);
  const spec = readFileSync(join(clone, specPath), 'utf8');
  const inSpec = patterns.filter((l) => spec.includes(l)).length;
  if (inSpec > 0) problems.push(`${plural(inSpec, 'line')} of the later fix or key in the spec`);

  return problems;
}

// What the reviewer can see must not name the programme.
export function neutralProblems({ prompt, folder, profile, spec, agentText }) {
  const named = /drill/i;
  const problems = [];
  if (named.test(prompt)) problems.push('the prompt names the programme');
  if (named.test(folder)) problems.push('the folder names the programme');
  if (named.test(profile)) problems.push('the profile names the programme');
  if (named.test(spec)) problems.push('the spec names the programme');
  if (agentText !== undefined && named.test(agentText))
    problems.push('the agent text names the programme');
  return problems;
}

// Each window against the prepared tree: inside the file, inside the change, anchor unchanged. A
// stale line number must read as unscored, never as a miss. `anchors` is for the case's author.
export function windowProblems({ clone, rangeStart, change, caseDef: c }) {
  const problems = [];
  const anchors = [];
  const diff = parseDiff(
    gitOut(clone, [
      '-c',
      'core.quotePath=false',
      'diff',
      '-M',
      '--no-color',
      '--no-ext-diff',
      '--ignore-submodules',
      '--unified=0',
      rangeStart,
      change,
    ]),
  );
  c.bugs.forEach((bug) => {
    bug.windows.forEach((w, i) => {
      const where = `bug ${bug.id} window ${i + 1}`;
      const shown = git(clone, ['show', `${change}:${w.file}`], { ok: [0, 128] });
      if (shown.status !== 0) {
        problems.push(`${where}: file not in the prepared tree`);
        return;
      }
      const lineCount = shown.stdout.replace(/\n$/, '').split('\n').length;
      if (w.to > lineCount) {
        problems.push(`${where}: past the end of the file`);
        return;
      }
      const anchor = anchorOf(shown.stdout, w.from, w.to);
      anchors.push({ bug: bug.id, window: i + 1, anchor });
      if (w.anchor !== anchor) problems.push(`${where}: anchor mismatch`);
      const inDiff = diff
        .filter((f) => f.file === w.file)
        .some((f) =>
          f.hunks.some((h) => {
            // A pure deletion sits between two lines: count 0 at the line before it.
            const start = h.newCount === 0 ? Math.max(h.newStart, 1) : h.newStart;
            const end = h.newCount === 0 ? h.newStart + 1 : h.newStart + h.newCount - 1;
            return start <= w.to && end >= w.from;
          }),
        );
      if (!inDiff) problems.push(`${where}: outside the diff`);
    });
  });
  problems.push(...coverageProblems(diff, c.bugs));
  return { problems, anchors };
}

// A window that holds most of a small change turns any finding into a catch. With no added lines
// (a pure deletion) there is nothing to measure, and the window rules above still apply.
function coverageProblems(diff, bugs) {
  const added = new Map();
  for (const f of diff) {
    for (const h of f.hunks) {
      if (f.file === null || h.newCount === 0) continue;
      if (!added.has(f.file)) added.set(f.file, new Set());
      for (let i = 0; i < h.newCount; i += 1) added.get(f.file).add(h.newStart + i);
    }
  }
  const total = [...added.values()].reduce((sum, lines) => sum + lines.size, 0);
  const problems = [];
  for (const bug of bugs) {
    const covered = new Set();
    for (const w of bug.windows) {
      for (let line = w.from; line <= w.to; line += 1) {
        if (added.get(w.file)?.has(line)) covered.add(`${w.file}:${line}`);
      }
    }
    if (covered.size * 2 > total) {
      problems.push(`bug ${bug.id}: its windows cover over half of the change's added lines`);
    }
  }
  return problems;
}

export function installCommand(clone, override) {
  if (override !== undefined) return override === '' ? null : override;
  return existsSync(join(clone, 'pnpm-lock.yaml')) ? 'pnpm install --frozen-lockfile' : null;
}

function runInstall(clone, override) {
  const command = installCommand(clone, override);
  if (command === null) return [];
  if (!runShell(command, clone)) return ['the install command failed'];
  if (gitOut(clone, ['status', '--porcelain']) !== '') return ['the install changed tracked files'];
  return [];
}

// --- Reviewer process ---

export function reviewerArgs({ agentsFile, agent, model, effort, extraAllowed = [] }) {
  return [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    'Read,Glob,Grep,Bash',
    '--no-session-persistence',
    '--agents',
    agentsFile,
    '--agent',
    agent,
    '--model',
    model,
    '--effort',
    effort,
    '--output-format',
    'json',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    ...ALLOWED_TOOLS,
    ...extraAllowed,
    '--disallowedTools',
    ...DENIED_TOOLS,
  ];
}

export function parseAgentFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (!fields.name || !fields.description || m[2].trim() === '') return null;
  const tools = (fields.tools ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return { name: fields.name, description: fields.description, tools, prompt: m[2] };
}

// The requested model and effort go in the definition too, so no frontmatter can override them.
export function agentsJson(agent, model, effort) {
  return {
    [agent.name]: {
      description: agent.description,
      prompt: agent.prompt,
      ...(agent.tools.length > 0 ? { tools: agent.tools } : {}),
      model,
      effort,
    },
  };
}

// --- The boundary check: can the reviewer read outside its clone? ---

const inputMentions = (denial, text) => JSON.stringify(denial?.tool_input ?? {}).includes(text);
const bashCommand = (denial) =>
  denial?.tool_name === 'Bash' ? String(denial?.tool_input?.command ?? '') : '';

const ROUTES = [
  { name: 'Read', denied: (d, o) => d?.tool_name === 'Read' && inputMentions(d, o) },
  { name: 'Grep', denied: (d, o) => d?.tool_name === 'Grep' && inputMentions(d, o) },
  { name: 'Glob', denied: (d, o) => d?.tool_name === 'Glob' && inputMentions(d, o) },
  {
    name: 'git diff --no-index',
    denied: (d, o) => /\bgit diff\b.*--no-index/.test(bashCommand(d)) && inputMentions(d, o),
  },
  {
    name: 'git diff with an outside path',
    denied: (d, o) => {
      const command = bashCommand(d);
      return /\bgit diff\b/.test(command) && !command.includes('--no-index') && inputMentions(d, o);
    },
  },
  { name: 'git -C', denied: (d, o) => /\bgit -C\b/.test(bashCommand(d)) && inputMentions(d, o) },
  { name: 'cat', denied: (d, o) => /\bcat\b/.test(bashCommand(d)) && inputMentions(d, o) },
];

const GLOBAL_RULES_NAME = '~/.claude/CLAUDE.md';

export function probePrompt(outside, clone) {
  const note = `${outside}/note.txt`;
  return [
    'This is a permissions test on a throwaway folder made for it. Make each attempt below exactly',
    'once, with exactly the tool named, even if an earlier attempt failed. Skip none.',
    `1. Read tool: file_path ${note}`,
    `2. Grep tool: pattern "." with path ${outside}`,
    `3. Glob tool: pattern "*" with path ${outside}`,
    `4. Bash tool: git diff --no-index -- ${note} README.md`,
    `5. Bash tool: git diff ${note} README.md`,
    `6. Bash tool: git -C ${outside} show HEAD:note.txt`,
    `7. Bash tool: cat ${note}`,
    '8. Bash tool: git show HEAD:README.md',
    `9. Read tool: file_path ${clone}/README.md`,
    "Then say for each attempt whether it was refused. If you saw a file's text, quote it.",
    `Last, with no tool: does your context hold instructions from a file at ${GLOBAL_RULES_NAME}?`,
    'Quote nothing from it. Answer on a line of its own: GLOBAL-RULES: yes, or GLOBAL-RULES: no.',
    '',
  ].join('\n');
}

// The process's own word, recorded and never a gate: whether the user's global rules reached it. No
// file is read for this and nothing from it is asked for, so no private text enters the output.
function globalRulesAnswer(result) {
  const m = /^GLOBAL-RULES: (yes|no)\s*$/m.exec(typeof result === 'string' ? result : '');
  return m ? m[1] : 'unknown';
}

// The positive control: a boundary that also refused what a reviewer needs would look just like one
// that works, so each allowed read must go through and the second sentinel must come back.
function controlProblems(output, denials, inside) {
  const problems = [];
  const deniedShow = denials.some((d) => /\bgit show HEAD:README\.md\b/.test(bashCommand(d)));
  const deniedRead = denials.some(
    (d) => d?.tool_name === 'Read' && String(d?.tool_input?.file_path ?? '').endsWith('/README.md'),
  );
  if (deniedShow) problems.push('allowed read denied: git show');
  if (deniedRead) problems.push('allowed read denied: Read');
  if (typeof output?.result !== 'string' || !output.result.includes(inside)) {
    problems.push('the allowed reads did not bring back the second sentinel');
  }
  return problems;
}

// Passes only with a recorded denial on every route, the sentinel nowhere in the output, and the
// allowed reads working. An attempt not made fails: no denial was recorded, so the boundary was not
// shown. A process that did not run is `refused`, the case that makes a batch an owner command.
export function checkBoundary(run, { sentinel, outside, inside }) {
  if (run.timedOut) return { ok: false, refused: true, problems: ['timed out'], shape: null };
  if (run.error) return { ok: false, refused: true, problems: [run.error], shape: null };
  if (run.exit !== 0) {
    const detail = `${run.stdout}\n${run.stderr}`.trim().slice(0, 500);
    return { ok: false, refused: true, problems: [`exit ${run.exit}: ${detail}`], shape: null };
  }
  let output;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    return { ok: false, refused: false, problems: ['output is not JSON'], shape: null };
  }
  const denials = output?.permission_denials;
  const shape = {
    fields: Object.keys(output ?? {}),
    subtype: output?.subtype,
    is_error: output?.is_error,
    modelUsage: output?.modelUsage,
    denialFields: Array.isArray(denials)
      ? [...new Set(denials.flatMap((d) => Object.keys(d ?? {})))]
      : null,
    denialCount: Array.isArray(denials) ? denials.length : null,
    globalRulesFile: existsSync(globalRulesPath()),
    globalRules: globalRulesAnswer(output?.result),
  };
  const problems = [];
  if (output?.subtype !== 'success' || output?.is_error !== false) {
    problems.push(`status ${output?.subtype ?? 'missing'}`);
  }
  if (`${run.stdout}${run.stderr}`.includes(sentinel))
    problems.push('the sentinel reached the output');
  if (Array.isArray(denials)) {
    for (const route of ROUTES) {
      if (!denials.some((d) => route.denied(d, outside)))
        problems.push(`no denial recorded: ${route.name}`);
    }
    problems.push(...controlProblems(output, denials, inside));
  } else {
    problems.push('no denial list in the output');
  }
  return { ok: problems.length === 0, refused: false, problems, shape };
}

function initRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git(dir, ['init', '--quiet', '--template=', '.']);
  git(dir, ['add', '--', ...Object.keys(files)]);
  git(dir, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'Start'], { env: IDENTITY });
}

// One fresh process with the real flags, on a small made-up repo, without and then with a project
// settings file that tries to allow everything. Uses no project data.
export function runProbe({
  claude = 'claude',
  timeoutSec = PROBE_TIMEOUT_SEC,
  outDir = null,
} = {}) {
  const workspace = createWorkspace();
  const runs = [];
  try {
    const sentinel = `marker-${randomBytes(12).toString('hex')}`;
    const inside = `marker-${randomBytes(12).toString('hex')}`;
    const outside = join(workspace, 'elsewhere');
    initRepo(outside, { 'note.txt': `${sentinel}\n` });
    const agentsFile = join(workspace, 'agents.json');
    const agent = {
      name: PROBE_AGENT,
      description: 'Makes the attempts it is given and reports each outcome.',
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      prompt:
        "Make every attempt in the user's message, one tool call each, and report each outcome.\n",
    };
    writeJson(agentsFile, agentsJson(agent, PROBE_MODEL, PROBE_EFFORT));
    const args = reviewerArgs({
      agentsFile,
      agent: PROBE_AGENT,
      model: PROBE_MODEL,
      effort: PROBE_EFFORT,
    });
    for (const withSettings of [false, true]) {
      const clone = join(workspace, withSettings ? 'repo-b' : 'repo-a');
      initRepo(clone, { 'README.md': `A test folder. ${inside}\n` });
      if (withSettings) {
        mkdirSync(join(clone, '.claude'));
        writeJson(join(clone, '.claude', 'settings.json'), {
          permissions: {
            allow: ['Read', 'Glob', 'Grep', 'Bash'],
            additionalDirectories: [outside],
          },
        });
      }
      const prompt = probePrompt(outside, clone);
      const run = invoke(claude, args, { cwd: clone, prompt, timeoutSec });
      if (outDir) {
        const name = withSettings ? 'with-settings' : 'without-settings';
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${name}.json`), run.stdout);
        writeFileSync(join(outDir, `${name}.stderr.txt`), run.stderr);
      }
      const result = checkBoundary(run, { sentinel, outside, inside });
      runs.push({ withSettings, ...result });
      if (result.refused) break;
    }
  } finally {
    dropWorkspace(workspace);
  }
  return {
    ok: runs.length === 2 && runs.every((r) => r.ok),
    refused: runs.some((r) => r.refused),
    runs,
  };
}

function printProbe(report, out = process.stdout) {
  for (const run of report.runs) {
    const name = run.withSettings ? 'with project settings' : 'without project settings';
    out.write(`boundary ${name}: ${run.ok ? 'ok' : `failed: ${run.problems.join('; ')}`}\n`);
    if (run.shape) out.write(`shape ${name}: ${JSON.stringify(run.shape)}\n`);
  }
}

// --- The ledger: append-only ---

export function readLedger(file) {
  if (!existsSync(file)) return { exists: false, rows: [], malformed: 0 };
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines[0] !== LEDGER_COLUMNS.join(','))
    throw new Refusal(`unexpected header in ${basename(file)}`);
  if (!text.endsWith('\n')) throw new Refusal(`${basename(file)} has a cut-off last row`);
  const rows = [];
  let malformed = 0;
  for (const line of lines.slice(1, -1)) {
    const fields = line.split(',');
    if (fields.length !== LEDGER_COLUMNS.length) {
      malformed += 1;
      continue;
    }
    rows.push(Object.fromEntries(LEDGER_COLUMNS.map((name, i) => [name, fields[i]])));
  }
  return { exists: true, rows, malformed };
}

export function appendRow(file, values) {
  const row = LEDGER_COLUMNS.map((name) => {
    const value = values[name];
    return value === null || value === undefined ? '' : String(value);
  });
  if (row.some((v) => /[,\n\r]/.test(v)))
    throw new Refusal('a ledger value holds a comma or newline');
  const line = `${row.join(',')}\n`;
  if (existsSync(file)) appendFileSync(file, line);
  else writeFileSync(file, `${LEDGER_COLUMNS.join(',')}\n${line}`, { flag: 'wx' });
}

function rowValues({
  date,
  caseDef: c,
  effort,
  batch,
  batchCases,
  agentText,
  contextText,
  caseHashValue,
  result,
}) {
  return {
    date,
    case: c.id,
    kind: c.kind,
    reviewer: c.reviewer,
    model: result.model,
    effort,
    tier: c.tier,
    planted: c.bugs.length,
    caught: result.scored ? result.caught : null,
    other_findings: result.scored ? result.other : null,
    batch,
    batch_cases: batchCases,
    agent_text: agentText,
    malformed: result.scored ? result.malformed : null,
    context_text: contextText,
    case_hash: caseHashValue,
  };
}

export function batchSummary(rows, batch) {
  const inBatch = rows.filter((r) => r.batch === batch);
  return {
    rows: inBatch.length,
    scored: inBatch.filter((r) => r.caught !== '').length,
    batchCases: inBatch.length > 0 ? Number(inBatch[0].batch_cases) : 0,
  };
}

function caseLine(id, result, planted) {
  if (result.scored) {
    return `${id}: caught ${result.caught}, other ${result.other}, malformed ${result.malformed}, planted ${planted}`;
  }
  return `${id}: caught blank (${result.reasons.join('; ')})`;
}

// Only cases scored in both batches, per case, and per reviewer without ever summing across
// reviewers. Fewer than 3 in common says little, and the output says so. A pair run under different
// model, effort or texts is labeled and stays in the totals: that difference is often the point of
// the comparison. A case that changed between them is a different test, so it leaves the totals.
export function compareBatches(rows, a, b) {
  const scoredIn = (batch) =>
    new Map(rows.filter((r) => r.batch === batch && r.caught !== '').map((r) => [r.case, r]));
  const inA = scoredIn(a);
  const inB = scoredIn(b);
  const common = [...inA.keys()].filter((id) => inB.has(id)).sort();
  const seen = new Set(rows.filter((r) => r.batch === a || r.batch === b).map((r) => r.case));
  const lines = [
    `compare ${a} -> ${b}: common ${common.length}, not compared ${seen.size - common.length}`,
  ];
  const totals = new Map();
  const trend = (x, y) => (y < x ? ' (lower)' : y > x ? ' (higher)' : '');
  let comparable = 0;
  for (const id of common) {
    const [ra, rb] = [inA.get(id), inB.get(id)];
    const [ca, cb] = [Number(ra.caught), Number(rb.caught)];
    const sameCase = Boolean(ra.case_hash) && ra.case_hash === rb.case_hash;
    const differs = ['model', 'effort', 'agent_text', 'context_text'].filter((k) => ra[k] !== rb[k]);
    const label = differs.length > 0 ? ` [differs: ${differs.join(', ')}]` : '';
    const side = (r, n) => `${r.model} ${r.effort} ${n} of ${r.planted}`;
    lines.push(
      `${id} ${ra.reviewer}: ${side(ra, ca)}, ${side(rb, cb)}${trend(ca, cb)}${label}${sameCase ? '' : ' [case changed: not in the totals]'}`,
    );
    if (!sameCase) continue;
    comparable += 1;
    const t = totals.get(ra.reviewer) ?? { a: 0, b: 0, plantedA: 0, plantedB: 0, n: 0 };
    t.a += ca;
    t.b += cb;
    t.plantedA += Number(ra.planted);
    t.plantedB += Number(rb.planted);
    t.n += 1;
    totals.set(ra.reviewer, t);
  }
  for (const [reviewer, t] of totals) {
    lines.push(
      `${reviewer}: ${t.a} of ${t.plantedA}, then ${t.b} of ${t.plantedB}, n=${t.n}${trend(t.a, t.b)}`,
    );
  }
  if (comparable < 3) lines.push('fewer than 3 cases in common: too few to read as a change');
  return { common, lines };
}

// --- Commands ---

export function validateCase({ source, ledgerDir, id, install, date = localDate() }) {
  const { caseDir, caseDef: c, problems } = loadCase(ledgerDir, id);
  if (problems.length > 0) return { id, problems, anchors: [] };
  if (c.retired !== null) return { id, retired: true, problems: [], anchors: [] };
  const fromSource = sourceProblems(source, c);
  if (fromSource.length > 0) return { id, problems: fromSource, anchors: [] };
  const texts = readTexts(source);
  if (texts === null)
    return { id, problems: [`${OVERLAID.join(' or ')} missing at HEAD`], anchors: [] };
  const workspace = createWorkspace();
  try {
    const prepared = prepareClone({ source, caseDir, caseDef: c, workspace, texts, date });
    const found = checkClone({ source, ledgerDir, caseDef: c, prepared });
    found.push(
      ...neutralProblems({
        prompt: promptFor(prepared, c),
        folder: prepared.clone,
        profile: texts['docs/agents.md'].toString(),
        spec: readFileSync(join(caseDir, 'spec.md'), 'utf8'),
      }),
    );
    const windows = windowProblems({ ...prepared, caseDef: c });
    found.push(...windows.problems);
    if (c.kind === 'planted') {
      found.push(...runInstall(prepared.clone, install));
      const checks = parseChecks(c.checks);
      if (found.length === 0 && !runShell(checks.command, prepared.clone)) {
        found.push('the tests fail with the planted bug');
      }
    }
    return { id, problems: found, anchors: windows.anchors };
  } catch (err) {
    if (err instanceof Refusal) return { id, problems: [err.message], anchors: [] };
    throw err;
  } finally {
    dropWorkspace(workspace);
  }
}

function readTexts(source) {
  const texts = {};
  for (const file of OVERLAID) {
    const bytes = headFile(source, file);
    if (bytes === null) return null;
    texts[file] = bytes;
  }
  return texts;
}

function promptFor(prepared, c) {
  return buildPrompt({
    range: `${prepared.rangeStart}..${prepared.change}`,
    specPath: prepared.specPath,
    checks: c.checks,
  });
}

function cmdValidate(o) {
  const source = realpathSync(required(o, 'repo'));
  const ledgerDir = realpathSync(required(o, 'ledger-dir'));
  const ids = caseIds(ledgerDir, o.case);
  if (ids.length === 0) throw new Refusal('no cases to validate');
  let failed = 0;
  for (const id of ids) {
    const result = validateCase({ source, ledgerDir, id, install: o.install });
    if (result.retired) {
      process.stdout.write(`${id}: retired, skipped\n`);
    } else if (result.problems.length > 0) {
      failed += 1;
      process.stdout.write(`${id}: FAIL: ${result.problems.join('; ')}\n`);
    } else {
      process.stdout.write(`${id}: ok\n`);
    }
    if (o['show-anchors']) {
      for (const a of result.anchors)
        process.stdout.write(`  ${a.bug} window ${a.window}: ${a.anchor}\n`);
    }
  }
  process.stdout.write(`validated ${ids.length}, failed ${failed}\n`);
  return failed === 0 ? 0 : 1;
}

function runCase({
  source,
  ledgerDir,
  entry,
  rawDir,
  batch,
  batchCases,
  date,
  claude,
  timeoutSec,
  testAllow,
  install,
  texts,
}) {
  const { caseDir, caseDef: c, plan } = entry;
  mkdirSync(rawDir, { recursive: true });
  const meta = {
    case: c.id,
    batch,
    batchCases,
    date,
    requestedModel: plan.model,
    effort: plan.effort,
    agentText: plan.agentText,
    contextText: plan.contextText,
    caseHash: plan.caseHash,
    clone: null,
    specPath: null,
    files: null,
    refused: [],
  };
  const workspace = createWorkspace();
  try {
    let run = null;
    try {
      const fromSource = sourceProblems(source, c);
      if (fromSource.length > 0) throw new Refusal(fromSource.join('; '));
      const prepared = prepareClone({ source, caseDir, caseDef: c, workspace, texts, date });
      const prompt = promptFor(prepared, c);
      meta.clone = prepared.clone;
      meta.specPath = prepared.specPath;
      meta.files = reviewedFiles(prepared);
      meta.refused.push(...checkClone({ source, ledgerDir, caseDef: c, prepared }));
      meta.refused.push(
        ...neutralProblems({
          prompt,
          folder: prepared.clone,
          profile: texts['docs/agents.md'].toString(),
          spec: readFileSync(join(caseDir, 'spec.md'), 'utf8'),
          agentText: plan.agent.prompt,
        }),
      );
      meta.refused.push(...windowProblems({ ...prepared, caseDef: c }).problems);
      if (meta.refused.length === 0) meta.refused.push(...runInstall(prepared.clone, install));
      if (meta.refused.length === 0) {
        const agentsFile = join(workspace, 'agents.json');
        writeJson(agentsFile, agentsJson(plan.agent, plan.model, plan.effort));
        const checks = parseChecks(c.checks);
        const args = reviewerArgs({
          agentsFile,
          agent: plan.agent.name,
          model: plan.model,
          effort: plan.effort,
          extraAllowed: [`Bash(${checks.command})`, ...testAllow],
        });
        writeFileSync(join(rawDir, 'prompt.txt'), prompt);
        run = invoke(claude, args, { cwd: prepared.clone, prompt, timeoutSec });
      }
    } catch (err) {
      // Any failure here leaves a blank row, so the batch still shows planned above scored.
      meta.refused.push(err.message);
    }
    writeJson(join(rawDir, 'meta.json'), meta);
    if (run !== null) {
      writeFileSync(join(rawDir, 'answer.json'), run.stdout);
      writeFileSync(join(rawDir, 'stderr.txt'), run.stderr);
      writeJson(join(rawDir, 'exit.json'), {
        exit: run.exit,
        signal: run.signal,
        error: run.error,
        timedOut: run.timedOut,
      });
    }
    const result = scoreFromRaw(rawDir, c);
    writeJson(join(rawDir, 'score.json'), result);
    return result;
  } finally {
    dropWorkspace(workspace);
  }
}

// Scores from what is on disk, so a saved answer can be scored again with no tokens. `meta.refused`
// holds what was found when the clone still existed, anchors included.
function scoreFromRaw(rawDir, c) {
  const meta = readJson(join(rawDir, 'meta.json'));
  if (meta.refused.length > 0) {
    return { scored: false, reasons: [`refused: ${meta.refused.join('; ')}`], model: null };
  }
  const exit = readJson(join(rawDir, 'exit.json'));
  if (exit.error !== null) {
    return {
      scored: false,
      reasons: [exit.timedOut ? 'timed out' : `could not run: ${exit.error}`],
      model: null,
    };
  }
  return scoreRun({
    bugs: c.bugs,
    stdout: readFileSync(join(rawDir, 'answer.json'), 'utf8'),
    exit: exit.exit,
    requestedModel: meta.requestedModel,
    clone: meta.clone,
    specPath: meta.specPath,
    files: meta.files,
  });
}

function planCases({ ledgerDir, only, reviewer, agentsDir, model, effort, texts }) {
  const entries = [];
  const problems = [];
  const context = contextHash(texts['docs/agents.md'], texts['CLAUDE.md'], readGlobalRules());
  for (const id of caseIds(ledgerDir, only)) {
    const { caseDir, caseDef: c, problems: found } = loadCase(ledgerDir, id);
    // Another reviewer's case is left out before anything else, so a draft folder holding one agent
    // can run. A case too broken to say whose it is still stops the run.
    if (reviewer !== undefined && c !== null && c.reviewer !== reviewer) continue;
    if (found.length > 0) {
      problems.push(`${id}: ${found.join('; ')}`);
      continue;
    }
    if (c.retired !== null) {
      if (only) problems.push(`${id}: retired`);
      continue;
    }
    const fromProfile = profileModel(texts['docs/agents.md'].toString(), c.reviewer, c.tier);
    const planModel = model ?? fromProfile?.model;
    const planEffort = effort ?? fromProfile?.effort;
    if (!planModel || !planEffort || !MODEL_ID.test(planModel) || !EFFORT.test(planEffort)) {
      problems.push(`${id}: no model and effort for ${c.reviewer} in the profile`);
      continue;
    }
    const agentFile = join(agentsDir, `${c.reviewer}.md`);
    if (!existsSync(agentFile)) {
      problems.push(`${id}: no agent file for ${c.reviewer}`);
      continue;
    }
    const agentBytes = readFileSync(agentFile);
    const agent = parseAgentFile(agentBytes.toString());
    if (agent === null || agent.name !== c.reviewer) {
      problems.push(`${id}: agent file for ${c.reviewer} is not readable`);
      continue;
    }
    entries.push({
      caseDir,
      caseDef: c,
      plan: {
        model: planModel,
        effort: planEffort,
        agent,
        agentText: hashParts([agentBytes]),
        contextText: context,
        caseHash: caseHash(caseDir),
      },
    });
  }
  return { entries, problems };
}

function cmdRun(o) {
  const source = realpathSync(required(o, 'repo'));
  const ledgerDir = realpathSync(required(o, 'ledger-dir'));
  const batch = required(o, 'batch');
  if (!SLUG.test(batch)) throw new Refusal('batch must be a lowercase slug');
  if (o.reviewer !== undefined && !SLUG.test(o.reviewer)) {
    throw new Refusal('reviewer must be a lowercase slug');
  }
  const ledgerFile = join(ledgerDir, 'drill-ledger.csv');
  if (readLedger(ledgerFile).rows.some((r) => r.batch === batch)) {
    throw new Refusal(`batch ${batch} is already in the ledger`);
  }
  // Raw answers can quote private text, so they must never be committable.
  if (git(source, ['check-ignore', '-q', '.agent-runs/x'], { ok: [0, 1] }).status !== 0) {
    throw new Refusal('.agent-runs/ is not git-ignored in the repo');
  }
  const texts = readTexts(source);
  if (texts === null) throw new Refusal(`${OVERLAID.join(' or ')} missing at HEAD`);
  const { entries, problems } = planCases({
    ledgerDir,
    only: o.case,
    reviewer: o.reviewer,
    agentsDir: resolve(o['agents-dir'] ?? DEFAULT_AGENTS_DIR),
    model: o.model,
    effort: o.effort,
    texts,
  });
  if (problems.length > 0) throw new Refusal(`cases not ready: ${problems.join(' | ')}`);
  if (entries.length === 0) throw new Refusal('no cases to run');

  const date = localDate();
  const rawRoot = join(source, '.agent-runs', `${date}-${batch}`);
  for (const { caseDef: c } of entries) {
    if (existsSync(join(rawRoot, c.id))) throw new Refusal(`raw folder for ${c.id} already exists`);
  }
  const claude = o.claude ?? 'claude';
  const timeoutSec = seconds(o, 'timeout-sec', REVIEW_TIMEOUT_SEC);
  const probeTimeoutSec = seconds(o, 'probe-timeout-sec', PROBE_TIMEOUT_SEC);

  const report = runProbe({
    claude,
    timeoutSec: probeTimeoutSec,
    outDir: join(rawRoot, `boundary-${Date.now()}`),
  });
  printProbe(report);
  if (!report.ok) {
    process.stdout.write(`batch ${batch}: not started, the boundary check did not pass\n`);
    return 1;
  }

  for (const entry of entries) {
    const { caseDef: c, plan } = entry;
    const result = runCase({
      source,
      ledgerDir,
      entry,
      rawDir: join(rawRoot, c.id),
      batch,
      batchCases: entries.length,
      date,
      claude,
      timeoutSec,
      testAllow: o['test-allow'] ?? [],
      install: o.install,
      texts,
    });
    appendRow(
      ledgerFile,
      rowValues({
        date,
        caseDef: c,
        effort: plan.effort,
        batch,
        batchCases: entries.length,
        agentText: plan.agentText,
        contextText: plan.contextText,
        caseHashValue: plan.caseHash,
        result,
      }),
    );
    process.stdout.write(`${caseLine(c.id, result, c.bugs.length)}\n`);
    // Tokens are not spent on the rest of a batch that can no longer be complete.
    if (!result.scored) break;
  }
  const summary = batchSummary(readLedger(ledgerFile).rows, batch);
  process.stdout.write(
    `batch ${batch}: scored ${summary.scored}, batch_cases ${summary.batchCases}\n`,
  );
  return summary.scored === summary.batchCases ? 0 : 1;
}

function cmdProbe(o) {
  const report = runProbe({
    claude: o.claude ?? 'claude',
    timeoutSec: seconds(o, 'probe-timeout-sec', PROBE_TIMEOUT_SEC),
    outDir: o.out ? resolve(o.out) : null,
  });
  printProbe(report);
  return report.ok ? 0 : 1;
}

function cmdScore(o) {
  const ledgerDir = realpathSync(required(o, 'ledger-dir'));
  const rawDir = resolve(required(o, 'raw'));
  const meta = readJson(join(rawDir, 'meta.json'));
  const { caseDef: c, problems } = loadCase(ledgerDir, meta.case);
  if (problems.length > 0) throw new Refusal(`case not ready: ${problems.join('; ')}`);
  const result = scoreFromRaw(rawDir, c);
  process.stdout.write(`${caseLine(c.id, result, c.bugs.length)}\n`);
  if (o.write) {
    const ledgerFile = join(ledgerDir, 'drill-ledger.csv');
    if (readLedger(ledgerFile).rows.some((r) => r.batch === meta.batch && r.case === c.id)) {
      throw new Refusal(`${c.id} already has a row in batch ${meta.batch}`);
    }
    appendRow(
      ledgerFile,
      rowValues({
        date: meta.date,
        caseDef: c,
        effort: meta.effort,
        batch: meta.batch,
        batchCases: meta.batchCases,
        agentText: meta.agentText,
        contextText: meta.contextText,
        caseHashValue: meta.caseHash,
        result,
      }),
    );
  }
  return result.scored ? 0 : 1;
}

function cmdCompare(o) {
  const ledger = readLedger(join(realpathSync(required(o, 'ledger-dir')), 'drill-ledger.csv'));
  const { lines } = compareBatches(ledger.rows, required(o, 'a'), required(o, 'b'));
  process.stdout.write(`${lines.join('\n')}\n`);
  if (ledger.malformed > 0) process.stdout.write(`malformed ledger rows: ${ledger.malformed}\n`);
  return 0;
}

function required(o, name) {
  if (typeof o[name] !== 'string' || o[name] === '') throw new Refusal(`--${name} is required`);
  return o[name];
}

function seconds(o, name, fallback) {
  if (o[name] === undefined) return fallback;
  const value = Number(o[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Refusal(`--${name} must be above 0`);
  return value;
}

const OPTIONS = {
  repo: { type: 'string' },
  'ledger-dir': { type: 'string' },
  batch: { type: 'string' },
  case: { type: 'string' },
  reviewer: { type: 'string' },
  'agents-dir': { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  claude: { type: 'string' },
  'timeout-sec': { type: 'string' },
  'probe-timeout-sec': { type: 'string' },
  'test-allow': { type: 'string', multiple: true },
  install: { type: 'string' },
  'show-anchors': { type: 'boolean' },
  raw: { type: 'string' },
  write: { type: 'boolean' },
  out: { type: 'string' },
  a: { type: 'string' },
  b: { type: 'string' },
};

const COMMANDS = {
  validate: cmdValidate,
  run: cmdRun,
  probe: cmdProbe,
  score: cmdScore,
  compare: cmdCompare,
};

function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (err) {
    process.stderr.write(`drill: ${err.message}\n`);
    return 2;
  }
  const command = COMMANDS[parsed.positionals[0]];
  if (command === undefined || parsed.positionals.length !== 1) {
    process.stderr.write(
      'usage: drill.mjs validate|run|probe|score|compare [options] (see the file header)\n',
    );
    return 2;
  }
  try {
    return command(parsed.values);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    process.stderr.write(`drill: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
