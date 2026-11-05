#!/usr/bin/env node
// Process check: do the commits of a push carry the trailers their changed files require?
// It catches a forgotten review, not a false claim. Rules, reasons and limits: docs/ci.md,
// "Process check". No dependencies: CI runs it from a bare checkout.
//
//   node ops/process-check.mjs <before> [<after>]   check before..after (after: HEAD by default)
//   node ops/process-check.mjs --audit [<after>] [--reviewed <file>]
//                                                   boundary..after: tasks never closed, commits
//                                                   that failed with no task to close, those of
//                                                   them not listed in the file, counts
//
// Exit 0: pass, or an audit. Exit 1: a rule failed, or the range cannot be trusted. Exit 2: usage.
//
// It prints shas, fixed texts, validated slugs and config names, never commit text: a message is
// free text, and CI logs read some lines as commands.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH = 'ops/process-check.json';
export const WORKFLOW_PATH = '.github/workflows/process.yml';

const GITLINK_MODE = '160000';
const ABSENT_MODE = '000000';
const SLUG = /^[a-z0-9-]+$/;
const ALL_ZEROS = /^(0{40}|0{64})$/;
// Trailers that ask to be checked, on a commit of any floor. Ship-Owner is handled apart.
const TASK_TRAILERS = ['Ship-Task', 'Ship-Tier', 'Ship-Tier-Why', 'Ship-Reviews'];

/**
 * Patterns are anchored at the repo root. `*` and `?` stay inside one folder, a `**` segment spans
 * any number of folders, and a trailing `/` means everything under that folder. Anything else that
 * looks like glob syntax is refused: it would otherwise silently match nothing.
 */
export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern === '' || /^(\/|\.\/)|[[\]{}!\\]/.test(pattern)) {
    throw new Error(`bad pattern: ${pattern}`);
  }
  const full = pattern.endsWith('/') ? `${pattern}**` : pattern;
  if (full.split('/').some((segment) => segment.includes('**') && segment !== '**')) {
    throw new Error(`bad pattern: ${pattern}`);
  }
  let out = '';
  for (let i = 0; i < full.length;) {
    if (full.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (full.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (full[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (full[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += full[i].replace(/[.^$+()|]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, 's');
}

const isList = (value) => Array.isArray(value) && value.every((s) => typeof s === 'string');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reads ops/process-check.json. Throws on anything it cannot use: never a partial config. */
export function parseConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  if (!isObject(config)) throw new Error('not an object');
  for (const key of ['tier2', 'tier2New', 'tier0']) {
    if (!isList(config[key])) throw new Error(`${key} must be a list of patterns`);
  }
  for (const tier of ['0', '1', '2', '3']) {
    const names = isObject(config.reviews) ? config.reviews[tier] : undefined;
    if (!isList(names) || !names.every((name) => SLUG.test(name))) {
      throw new Error(`reviews.${tier} must be a list of reviewer names`);
    }
  }
  if (!isObject(config.profileBullets)) throw new Error('profileBullets must be an object');
  return {
    ...config,
    matchers: {
      tier2: config.tier2.map(globToRegExp),
      tier2New: config.tier2New.map(globToRegExp),
      tier0: config.tier0.map(globToRegExp),
    },
  };
}

/**
 * Only the last paragraph is read, and only when every line of it is a trailer (or a continuation
 * of one) and it is not the subject. A trailer in a body paragraph is therefore missing, and fails
 * loudly. Empty values count as absent. Keys are exact: `ship-tier` is not read.
 */
export function parseTrailers(message) {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  const trailers = new Map();
  const lastBlank = lines.findLastIndex((line) => line.trim() === '');
  if (lastBlank === -1) return trailers;
  const entries = [];
  for (const line of lines.slice(lastBlank + 1)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (match) entries.push({ key: match[1], value: match[2].trim() });
    else if (/^\s/.test(line) && entries.length > 0) {
      entries.at(-1).value = `${entries.at(-1).value} ${line.trim()}`.trim();
    } else return trailers;
  }
  for (const { key, value } of entries) {
    if (value !== '') trailers.set(key, [...(trailers.get(key) ?? []), value]);
  }
  return trailers;
}

/** A gitlink on both sides of the change. A file replaced by a gitlink is judged as a file. */
function isGitlink(file) {
  const gitlinkOrAbsent = (mode) => mode === GITLINK_MODE || mode === ABSENT_MODE;
  return (
    gitlinkOrAbsent(file.oldMode) &&
    gitlinkOrAbsent(file.newMode) &&
    (file.oldMode === GITLINK_MODE || file.newMode === GITLINK_MODE)
  );
}

const matchesAny = (matchers, path) => matchers.some((re) => re.test(path));

/**
 * The lowest tier the paths allow. Gitlinks are left out, so a mixed commit is judged on its other
 * files. 2: a file matches tier2 and not tier0, or is added and matches tier2New. 0: every file
 * matches tier0 (an empty commit too). Otherwise 1.
 */
export function floorOf(files, matchers) {
  const judged = files.filter((file) => !isGitlink(file));
  const isTrust = (file) =>
    (matchesAny(matchers.tier2, file.path) && !matchesAny(matchers.tier0, file.path)) ||
    (file.status === 'A' && matchesAny(matchers.tier2New, file.path));
  if (judged.some(isTrust)) return 2;
  return judged.every((file) => matchesAny(matchers.tier0, file.path)) ? 0 : 1;
}

/**
 * Judges commits, oldest first. Each commit with floor 1 or more needs Ship-Task and a Ship-Tier at
 * or above the floor; a lower claim needs Ship-Tier-Why. A commit of floor 0 needs nothing, but any
 * trailer it carries is checked. Ship-Owner passes with a notice and joins no task.
 */
export function judgeCommits(commits, config) {
  const failures = [];
  const notices = [];
  const counts = { checked: 0, gitlink: 0, tier0: 0, owner: 0, why: 0 };
  const tasks = new Map();

  for (const commit of commits) {
    const short = commit.sha.slice(0, 12);
    const values = (key) => commit.trailers.get(key) ?? [];
    if (values('Ship-Tier-Why').length > 0) counts.why += 1;

    if (values('Ship-Owner').length > 0) {
      counts.owner += 1;
      notices.push(`notice ${short} Ship-Owner: no review check on this commit`);
      continue;
    }

    const floor = floorOf(commit.files, config.matchers);
    if (floor === 0 && !TASK_TRAILERS.some((key) => values(key).length > 0)) {
      const gitlinkOnly = commit.files.length > 0 && commit.files.every(isGitlink);
      counts[gitlinkOnly ? 'gitlink' : 'tier0'] += 1;
      continue;
    }
    counts.checked += 1;

    const prefix = floor === 2 ? 'trust path: ' : floor === 1 ? 'floor 1: ' : '';
    for (const key of ['Ship-Task', 'Ship-Tier', 'Ship-Reviews']) {
      if (values(key).length > 1) failures.push(`${short} more than one ${key}`);
    }

    const [tierText] = values('Ship-Tier');
    let tier = null;
    if (tierText === undefined) {
      if (floor > 0) failures.push(`${short} ${prefix}no Ship-Tier`);
    } else if (!/^[0-3]$/.test(tierText)) {
      failures.push(`${short} bad Ship-Tier`);
    } else {
      tier = Number(tierText);
      if (tier < floor) {
        if (values('Ship-Tier-Why').length > 0) {
          notices.push(`notice ${short} tier ${tier} below floor ${floor}: Ship-Tier-Why given`);
        } else {
          failures.push(`${short} tier ${tier} below floor ${floor}`);
        }
      }
    }

    const [slug] = values('Ship-Task');
    if (slug === undefined) {
      failures.push(`${short} ${prefix}no Ship-Task`);
    } else if (!SLUG.test(slug)) {
      failures.push(`${short} bad Ship-Task`);
    } else {
      const task = tasks.get(slug) ?? { slug, tier: 0 };
      if (tier !== null) task.tier = Math.max(task.tier, tier);
      const [reviews] = values('Ship-Reviews');
      task.reviews = reviews === undefined ? null : reviews.split(/[\s,]+/).filter(Boolean);
      tasks.set(slug, task);
    }
  }
  return { failures, notices, counts, tasks: [...tasks.values()] };
}

/**
 * What keeps a task open: its highest tier decides the reviewers, and its last commit must list
 * them all. No list at all reads `open`, an incomplete one names who is missing.
 */
export function taskProblems(task, config) {
  const required = config.reviews[String(task.tier)];
  if (required.length === 0) return [];
  if (task.reviews === null) return [`task ${task.slug} open`];
  return required
    .filter((name) => !task.reviews.includes(name))
    .map((name) => `task ${task.slug} missing ${name}`);
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

/** The bullets of the profile's trust-territory Paths list, joined and whitespace normalized. */
export function profilePathBullets(profile) {
  const lines = profile.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+Trust territory/.test(line));
  if (heading === -1) return [];
  let i = heading + 1;
  while (i < lines.length && !/^##\s/.test(lines[i]) && !/^Paths\b/.test(lines[i])) i += 1;
  if (i === lines.length || !/^Paths\b/.test(lines[i])) return [];
  const bullets = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (/^[-*]\s/.test(line)) bullets.push(line.slice(2));
    else if (bullets.length === 0) continue;
    else if (line.trim() === '' || !/^\s/.test(line)) break;
    else bullets[bullets.length - 1] += ` ${line}`;
  }
  return bullets.map(normalize);
}

/**
 * Config against profile, both ways. Every bullet has an entry naming patterns or a reason, so a
 * bullet with no backticks is covered and a reworded bullet forces a look. Every entry is still a
 * bullet. Every tier2 and tier2New pattern belongs to a bullet, and every pattern a bullet names is
 * enforced. Run by the process job's tests, not on every commit.
 */
export function agreementProblems(config, profile) {
  const problems = [];
  const bullets = profilePathBullets(profile);
  if (bullets.length === 0) problems.push('no trust-territory Paths list in the profile');
  const entries = new Map(
    Object.entries(config.profileBullets).map(([bullet, entry]) => [normalize(bullet), entry]),
  );
  for (const bullet of bullets) {
    if (!entries.has(bullet)) problems.push(`bullet with no profileBullets entry: ${bullet}`);
  }
  const named = new Set();
  for (const [bullet, entry] of entries) {
    if (!bullets.includes(bullet)) problems.push(`entry that is no longer a bullet: ${bullet}`);
    const patterns = isObject(entry) && isList(entry.patterns) ? entry.patterns : [];
    const reason = isObject(entry) && typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (patterns.length === 0 && reason === '') {
      problems.push(`entry with neither patterns nor a reason: ${bullet}`);
    }
    for (const pattern of patterns) named.add(pattern);
  }
  const enforced = new Set([...config.tier2, ...config.tier2New]);
  for (const pattern of enforced) {
    if (!named.has(pattern)) problems.push(`pattern that belongs to no bullet: ${pattern}`);
  }
  for (const pattern of named) {
    if (!enforced.has(pattern)) problems.push(`bullet pattern not enforced: ${pattern}`);
  }
  return problems;
}

function makeGit(cwd) {
  return (args, { allowFail = false } = {}) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 2 ** 28 });
    if (result.error) throw new Error(`git ${args[0]} could not run`);
    if (result.status !== 0) {
      if (allowFail) return null;
      throw new Error(`git ${args[0]} failed`);
    }
    return result.stdout;
  };
}

function resolveCommit(git, rev) {
  const out = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
  return out === null ? null : out.trim();
}

const existsAt = (git, commit, path) =>
  git(['cat-file', '-e', `${commit}:${path}`], { allowFail: true }) !== null;

/**
 * The check starts at the oldest commit that added the config, so re-adding it later cannot move
 * the start forward. Limited to that one path, a rename into it also reads as an add.
 */
function findBoundary(git, after) {
  const adds = git([
    'log',
    '--full-history',
    '--topo-order',
    '--reverse',
    '--diff-filter=A',
    '--format=%H',
    after,
    '--',
    CONFIG_PATH,
  ]);
  return adds.split('\n')[0] || null;
}

const revList = (git, args) =>
  git(['rev-list', '--topo-order', '--reverse', ...args])
    .split('\n')
    .filter(Boolean);

function readCommit(git, sha) {
  const raw = git([
    'diff-tree',
    '-r',
    '--no-renames',
    '--root',
    '--no-commit-id',
    '--raw',
    '-z',
    sha,
  ]);
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])/.exec(parts[i]);
    if (!match) throw new Error('git diff-tree gave an unreadable answer');
    files.push({ oldMode: match[1], newMode: match[2], status: match[3], path: parts[i + 1] });
  }
  return { sha, files, trailers: parseTrailers(git(['show', '-s', '--format=%B', sha])) };
}

// Read from the commit, not the working tree, so a dirty tree cannot change the verdict.
function loadConfig(git, commit, label = CONFIG_PATH) {
  try {
    return parseConfig(git(['show', `${commit}:${CONFIG_PATH}`]));
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

/**
 * The rules from before this push, when there were any and the push changed them. A push must not
 * be judged only by the rules it brings, or emptying a reviewer list would pass in the same push.
 */
function earlierConfig(git, before, after) {
  if (before === null || !existsAt(git, before, CONFIG_PATH)) return null;
  const [was, now] = [before, after].map((commit) => git(['show', `${commit}:${CONFIG_PATH}`]));
  return was === now ? null : loadConfig(git, before, `${CONFIG_PATH} before this push`);
}

function isShallow(git) {
  return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
}

const fail = (reason) => ({ status: 1, lines: [`fail: ${reason}`] });

function runCheck(git, beforeArg, afterArg) {
  const after = resolveCommit(git, afterArg);
  if (after === null) return fail('range unknown: after not found');
  if (isShallow(git)) return fail('range unknown: shallow clone (needs fetch-depth: 0)');

  if (!existsAt(git, after, CONFIG_PATH)) {
    return existsAt(git, after, WORKFLOW_PATH)
      ? fail(`${CONFIG_PATH} is gone but ${WORKFLOW_PATH} is still there`)
      : { status: 0, lines: ['pass: checked 0, no config and no workflow at this commit'] };
  }

  // Zeros: the first push of a repo, so the whole history up to the boundary is older.
  const exclude = [];
  let before = null;
  if (!ALL_ZEROS.test(beforeArg)) {
    before = resolveCommit(git, beforeArg);
    if (before === null) return fail('range unknown: before not found');
    const ancestor = git(['merge-base', '--is-ancestor', before, after], { allowFail: true });
    if (ancestor === null) return fail('range unknown: before is not an ancestor of after');
    exclude.push(`^${before}`);
  }

  const config = loadConfig(git, after);
  const earlier = earlierConfig(git, before, after);
  const boundary = findBoundary(git, after);
  if (boundary === null) return fail('range unknown: no commit added the config');

  const all = revList(git, [after, ...exclude]);
  const scope = [after, ...exclude, `^${boundary}`];
  const inScope = revList(git, scope);
  const commits = revList(git, ['--no-merges', ...scope]).map((sha) => readCommit(git, sha));

  const { failures, notices, counts, tasks } = judgeCommits(commits, config);
  const problems = [...failures, ...tasks.flatMap((task) => taskProblems(task, config))];
  if (earlier !== null) {
    notices.push('notice this push changes the config: judged by both, a failure of either fails');
    const old = judgeCommits(commits, earlier);
    const oldProblems = [...old.failures, ...old.tasks.flatMap((t) => taskProblems(t, earlier))];
    for (const line of oldProblems) {
      if (!problems.includes(line)) problems.push(`${line} (by the config before this push)`);
    }
  }
  const summary = [
    `checked ${counts.checked}`,
    `older ${all.length - inScope.length}`,
    `exempt ${counts.gitlink} (gitlink)`,
    `exempt ${counts.tier0} (tier 0)`,
    `owner ${counts.owner}`,
    `merges ${inScope.length - commits.length} not checked`,
  ].join(', ');
  if (problems.length === 0) return { status: 0, lines: [...notices, `pass: ${summary}`] };
  return {
    status: 1,
    lines: [
      ...notices,
      ...problems,
      `fail: ${summary}`,
      'This run does not hold back a server. To fix: run the missing review, then commit under the',
      'same Ship-Task with Ship-Reviews. A commit with no Ship-Task has no task to close, and only a',
      'history rewrite could add one: review it and log it; --audit lists it as unclaimed',
      '(docs/ci.md, "Process check").',
    ],
  };
}

/**
 * The commits a session has looked at: one sha per line, any length from 7. A missing file lists
 * nothing, so every unclaimed commit counts. A line that is not a sha is never skipped: a file that
 * cannot be trusted fails the audit, rather than quietly leaving a commit out or in.
 */
function readReviewed(path) {
  if (path === null) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`${path}: could not be read`);
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  lines.forEach((line, i) => {
    if (line !== '' && !/^[0-9a-f]{7,40}$/.test(line)) {
      throw new Error(`${path}: line ${i + 1} is not a sha`);
    }
  });
  return lines.filter((line) => line !== '');
}

function runAudit(git, afterArg, reviewedPath) {
  const reviewed = readReviewed(reviewedPath);
  const after = resolveCommit(git, afterArg);
  if (after === null) return fail('range unknown: after not found');
  if (isShallow(git)) return fail('range unknown: shallow clone (needs fetch-depth: 0)');
  if (!existsAt(git, after, CONFIG_PATH)) {
    return { status: 0, lines: ['audit: no config at this commit, nothing to read'] };
  }
  const config = loadConfig(git, after);
  const boundary = findBoundary(git, after);
  if (boundary === null) return fail('range unknown: no commit added the config');
  const commits = revList(git, ['--no-merges', after, `^${boundary}`]).map((sha) =>
    readCommit(git, sha),
  );
  const { failures, counts, tasks } = judgeCommits(commits, config);
  const problems = tasks.map((task) => taskProblems(task, config));
  const open = problems.filter((list) => list.length > 0).length;
  // Every failure line starts with its commit's short sha. These join no task, so without this line
  // a trust commit with no trailers would be invisible here after its one red run.
  const unclaimed = [...new Set(failures.map((line) => line.split(' ')[0]))];
  // Shas, not a count: a count cannot tell a new commit from an old one that stopped failing.
  const unreviewed = unclaimed.filter(
    (sha) => !reviewed.some((seen) => seen.startsWith(sha) || sha.startsWith(seen)),
  );
  const listing = (name, shas) =>
    shas.length > 0 ? [`${name} ${shas.length}: ${shas.join(' ')}`] : [];
  return {
    status: 0,
    lines: [
      ...problems.flat(),
      ...listing('unclaimed', unclaimed),
      ...listing('unreviewed', unreviewed),
      `audit: tasks ${tasks.length}, open ${open}, unclaimed ${unclaimed.length}, ` +
        `unreviewed ${unreviewed.length}, why ${counts.why}, owner ${counts.owner}`,
    ],
  };
}

function main(argv) {
  const audit = argv[0] === '--audit';
  const args = audit ? argv.slice(1) : [...argv];
  const flag = args.indexOf('--reviewed');
  const reviewedPath = flag === -1 ? null : (args[flag + 1] ?? '');
  if (flag !== -1) args.splice(flag, 2);
  if (
    reviewedPath === '' ||
    (!audit && flag !== -1) ||
    (audit && args.length > 1) ||
    (!audit && (args.length < 1 || args.length > 2))
  ) {
    console.error(
      'usage: process-check.mjs <before> [<after>] | --audit [<after>] [--reviewed <file>]',
    );
    return 2;
  }
  let result;
  try {
    const top = makeGit(process.cwd())(['rev-parse', '--show-toplevel']).trim();
    const git = makeGit(top);
    result = audit
      ? runAudit(git, args[0] ?? 'HEAD', reviewedPath)
      : runCheck(git, args[0], args[1] ?? 'HEAD');
  } catch (error) {
    // Never a pass: a config it cannot use, or a git that does not answer, is a failure.
    result = fail(error.message);
  }
  for (const line of result.lines) console.log(line);
  return result.status;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
