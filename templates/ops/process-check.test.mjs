// Tests of the process check, run by the process job and by hand: node --test
// ops/process-check.test.mjs. Kept out of the normal suite on purpose, so they can never hold back a
// server (docs/ci.md). Synthetic git repos only, no network, no clock.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  agreementProblems,
  globToRegExp,
  parseConfig,
  parseTrailers,
  profilePathBullets,
} from './process-check.mjs';

const OPS = import.meta.dirname;
const SCRIPT = join(OPS, 'process-check.mjs');
const ROOT = join(OPS, '..');
const ZEROS = '0'.repeat(40);
// No GIT_* from a calling hook, no user config, and no repo found above the temp folder.
const BARE_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

const CONFIG = {
  tier2: ['packages/core/', 'ops/deploy.sh', 'ops/process-check.json', '.github/workflows/'],
  tier2New: ['apps/**/page.*'],
  tier0: ['docs/', '**/*.md', '**/*.test.*'],
  reviews: {
    0: [],
    1: ['code-reviewer-light'],
    2: ['code-reviewer'],
    3: ['code-reviewer', 'triage'],
  },
  profileBullets: {},
};

const ATTRIBUTION = 'Co-Authored-By: Example Bot <bot@example.invalid>';
const message = (subject, ...trailers) =>
  [subject, '', [...trailers, ATTRIBUTION].join('\n')].join('\n');
const closed = (slug, tier = 2, reviews = 'code-reviewer') =>
  message('Change', `Ship-Task: ${slug}`, `Ship-Tier: ${tier}`, `Ship-Reviews: ${reviews}`);
const chunk = (slug, tier = 2) => message('Chunk', `Ship-Task: ${slug}`, `Ship-Tier: ${tier}`);

/**
 * A synthetic repo: two seed commits, then the commit adding the config, which is the boundary.
 * Author and dates are fixed, and the same on every commit, so nothing rests on commit dates.
 */
function makeRepo(t, { config = CONFIG, seed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'process-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...BARE_ENV,
    HOME: dir,
    GIT_AUTHOR_NAME: 'Example',
    GIT_AUTHOR_EMAIL: 'example@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Example',
    GIT_COMMITTER_EMAIL: 'example@example.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (args, input) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', input });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (path, text = 'text\n') => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(['add', '--', path]);
  };
  const commit = (text = 'Plain subject') => {
    git(['commit', '--quiet', '--allow-empty', '--cleanup=whitespace', '-F', '-'], text);
    return git(['rev-parse', 'HEAD']);
  };
  /** One file changed in one new commit. */
  const change = (path, text = 'Plain subject') => {
    write(path, `changed by ${commit.count++}\n`);
    return commit(text);
  };
  commit.count = 0;
  const run = (...args) => {
    const r = spawnSync('node', [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  git(['init', '--quiet', '-b', 'main']);
  let boundary = null;
  if (seed) {
    write('packages/core/a.ts');
    write('ops/deploy.sh');
    write('src/glue.ts');
    write('apps/web/page.tsx');
    write('docs/a.md');
    commit('Seed one');
    write('src/other.ts');
    commit('Seed two');
    write('ops/process-check.json', `${JSON.stringify(config)}\n`);
    boundary = commit('Add the process check config');
  }
  return { dir, git, write, commit, change, run, boundary };
}

const short = (sha) => sha.slice(0, 12);
/** The whole line, so a failure is told apart from a notice holding the same words. */
function hasLine(out, line) {
  assert.ok(out.split('\n').includes(line), `no line "${line}" in:\n${out}`);
}
function passes(r, text) {
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(text), `no "${text}" in:\n${r.out}`);
}
function fails(r, line) {
  assert.equal(r.status, 1, r.out);
  hasLine(r.out, line);
}

describe('range and boundary', () => {
  test('older than the check: a range ending at the boundary checks nothing', (t) => {
    const repo = makeRepo(t);
    passes(repo.run(`${repo.boundary}~2`, repo.boundary), 'checked 0, older 2');
  });

  test('the boundary itself is excluded', (t) => {
    const repo = makeRepo(t);
    passes(repo.run(`${repo.boundary}~1`, repo.boundary), 'checked 0, older 1');
  });

  test('a range across the boundary counts the old part and checks the new part', (t) => {
    const repo = makeRepo(t);
    const bad = repo.change('packages/core/a.ts');
    const r = repo.run(`${repo.boundary}~2`, 'HEAD');
    fails(r, `${short(bad)} trust path: no Ship-Tier`);
    assert.match(r.out, /checked 1, older 2,/);
  });

  test('re-adding the config does not move the boundary forward', (t) => {
    const repo = makeRepo(t);
    const between = repo.change('packages/core/a.ts');
    repo.git(['rm', '--quiet', '--', 'ops/process-check.json']);
    repo.commit(closed('remove-config'));
    repo.write('ops/process-check.json', `${JSON.stringify(CONFIG)}\n`);
    repo.commit(closed('add-config-again'));
    fails(repo.run(ZEROS, 'HEAD'), `${short(between)} trust path: no Ship-Tier`);
  });

  test('the boundary is found when the config came in through a merge', (t) => {
    const repo = makeRepo(t, { seed: false });
    repo.write('packages/core/a.ts');
    repo.commit('Seed');
    repo.git(['checkout', '--quiet', '-b', 'side']);
    repo.write('ops/process-check.json', `${JSON.stringify(CONFIG)}\n`);
    const boundary = repo.commit('Add the config');
    repo.git(['checkout', '--quiet', 'main']);
    repo.write('src/x.ts');
    const mainSide = repo.commit(closed('x', 1, 'code-reviewer-light'));
    repo.git(['merge', '--quiet', '--no-ff', '-m', 'Merge', 'side']);
    const r = repo.run(ZEROS, 'HEAD');
    passes(r, 'checked 1, older 2,');
    assert.ok(!r.out.includes(short(boundary)) && !r.out.includes(short(mainSide)));
  });

  test('a config added and removed on a merged side branch still sets the boundary', (t) => {
    const repo = makeRepo(t, { seed: false });
    repo.write('packages/core/a.ts');
    repo.commit('Seed');
    repo.git(['checkout', '--quiet', '-b', 'side']);
    repo.write('ops/process-check.json', `${JSON.stringify(CONFIG)}\n`);
    repo.commit('Add the config');
    repo.git(['rm', '--quiet', '--', 'ops/process-check.json']);
    repo.commit('Remove the config');
    repo.git(['checkout', '--quiet', 'main']);
    repo.git(['merge', '--quiet', '--no-ff', '-m', 'Merge', 'side']);
    const between = repo.change('packages/core/a.ts');
    repo.write('ops/process-check.json', `${JSON.stringify(CONFIG)}\n`);
    repo.commit('Add the config again');
    fails(repo.run(ZEROS, 'HEAD'), `${short(between)} trust path: no Ship-Tier`);
  });

  test('a config that arrived by a rename still sets the boundary', (t) => {
    const repo = makeRepo(t, { seed: false });
    repo.write('packages/core/a.ts');
    repo.write('ops/old-name.json', `${JSON.stringify(CONFIG)}\n`);
    repo.commit('Seed');
    repo.git(['mv', 'ops/old-name.json', 'ops/process-check.json']);
    repo.commit('Rename');
    const bad = repo.change('packages/core/a.ts');
    const r = repo.run(ZEROS, 'HEAD');
    fails(r, `${short(bad)} trust path: no Ship-Tier`);
    assert.match(r.out, /checked 1, older 2,/);
  });

  test('no config and no workflow at after: pass', (t) => {
    const repo = makeRepo(t, { seed: false });
    repo.write('packages/core/a.ts');
    const first = repo.commit('Seed');
    repo.change('packages/core/a.ts');
    passes(repo.run(first, 'HEAD'), 'checked 0, no config and no workflow');
  });

  test('config gone but workflow present: fail', (t) => {
    const repo = makeRepo(t);
    repo.write('.github/workflows/process.yml', 'name: Process\n');
    repo.commit(closed('add-workflow'));
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.git(['rm', '--quiet', '--', 'ops/process-check.json']);
    repo.commit('Remove the config');
    fails(
      repo.run(before, 'HEAD'),
      'fail: ops/process-check.json is gone but .github/workflows/process.yml is still there',
    );
  });

  test('both removed: pass, the job that would run is gone too', (t) => {
    const repo = makeRepo(t);
    repo.git(['rm', '--quiet', '--', 'ops/process-check.json']);
    repo.commit('Remove the config');
    passes(repo.run(repo.boundary, 'HEAD'), 'no config and no workflow');
  });

  test('before is zeros: boundary..after is checked, a first push', (t) => {
    const repo = makeRepo(t);
    const bad = repo.change('packages/core/a.ts');
    const r = repo.run(ZEROS, 'HEAD');
    fails(r, `${short(bad)} trust path: no Ship-Tier`);
    assert.match(r.out, /checked 1, older 3,/);
  });

  test('before not found: range unknown', (t) => {
    const repo = makeRepo(t);
    const r = repo.run('b'.repeat(40), 'HEAD');
    assert.equal(r.status, 1);
    assert.match(r.out, /range unknown/);
  });

  test('before empty or an option: range unknown, never a pass', (t) => {
    const repo = makeRepo(t);
    for (const before of ['', '--all']) {
      const r = repo.run(before, 'HEAD');
      assert.equal(r.status, 1);
      assert.match(r.out, /range unknown/);
    }
  });

  test('before not an ancestor, as after a force push: range unknown', (t) => {
    const repo = makeRepo(t);
    const dropped = repo.change('docs/a.md');
    repo.git(['reset', '--quiet', '--hard', repo.boundary]);
    repo.change('docs/b.md');
    const r = repo.run(dropped, 'HEAD');
    assert.equal(r.status, 1);
    assert.match(r.out, /range unknown/);
  });

  test('after not found: range unknown', (t) => {
    const repo = makeRepo(t);
    const r = repo.run(repo.boundary, 'c'.repeat(40));
    assert.equal(r.status, 1);
    assert.match(r.out, /range unknown/);
  });

  test('a shallow clone: range unknown, its boundary would be wrong', (t) => {
    const repo = makeRepo(t);
    const clone = mkdtempSync(join(tmpdir(), 'process-check-shallow-'));
    t.after(() => rmSync(clone, { recursive: true, force: true }));
    repo.git(['clone', '--quiet', '--depth', '1', `file://${repo.dir}`, clone]);
    const run = (...args) =>
      spawnSync('node', [SCRIPT, ...args], { cwd: clone, encoding: 'utf8', env: BARE_ENV });
    for (const args of [[ZEROS, 'HEAD'], ['--audit']]) {
      const r = run(...args);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /range unknown: shallow/);
    }
  });

  test('an empty range passes and says it checked nothing', (t) => {
    const repo = makeRepo(t);
    passes(repo.run(repo.boundary, repo.boundary), 'pass: checked 0, older 0,');
  });

  test('after defaults to HEAD, and revisions by name work', (t) => {
    const repo = makeRepo(t);
    repo.git(['branch', 'published']);
    const bad = repo.change('packages/core/a.ts');
    fails(repo.run('published'), `${short(bad)} trust path: no Ship-Tier`);
  });

  test('runs from a subfolder', (t) => {
    const repo = makeRepo(t);
    const bad = repo.change('packages/core/a.ts');
    const r = spawnSync('node', [SCRIPT, repo.boundary], {
      cwd: join(repo.dir, 'packages'),
      encoding: 'utf8',
      env: BARE_ENV,
    });
    assert.equal(r.status, 1, r.stdout);
    hasLine(r.stdout, `${short(bad)} trust path: no Ship-Tier`);
  });

  test('outside a repo: a failure, not a pass', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'process-check-none-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync('node', [SCRIPT, ZEROS], { cwd: dir, encoding: 'utf8', env: BARE_ENV });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^fail: /);
  });

  test('wrong arguments: usage, exit 2', (t) => {
    const repo = makeRepo(t);
    for (const args of [
      [],
      ['a', 'b', 'c'],
      ['--audit', 'a', 'b'],
      ['--audit', '--reviewed'],
      ['--audit', '--reviewed', ''],
      ['--audit', 'a', 'b', '--reviewed', 'x'],
      ['HEAD', 'HEAD', '--reviewed', 'x'],
    ]) {
      const r = repo.run(...args);
      assert.equal(r.status, 2);
      assert.match(r.err, /usage/);
    }
  });
});

describe('floor by path', () => {
  test('a trust-path commit with no trailers fails', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts');
    const r = repo.run(repo.boundary, 'HEAD');
    fails(r, `${short(sha)} trust path: no Ship-Tier`);
    hasLine(r.out, `${short(sha)} trust path: no Ship-Task`);
  });

  test('a claim below the floor with no why fails', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts', closed('low', 1, 'code-reviewer-light'));
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} tier 1 below floor 2`);
  });

  test('a claim below the floor with a why passes with a notice', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change(
      'packages/core/a.ts',
      message('Comment only', 'Ship-Task: comment', 'Ship-Tier: 0', 'Ship-Tier-Why: comment only'),
    );
    const r = repo.run(repo.boundary, 'HEAD');
    passes(r, 'checked 1');
    hasLine(r.out, `notice ${short(sha)} tier 0 below floor 2: Ship-Tier-Why given`);
  });

  test('an empty why is no why', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change(
      'packages/core/a.ts',
      message('Change', 'Ship-Task: empty-why', 'Ship-Tier: 0', 'Ship-Tier-Why:'),
    );
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} tier 0 below floor 2`);
  });

  test('a trust file renamed into docs/ still counts its old path', (t) => {
    const repo = makeRepo(t);
    repo.git(['mv', 'packages/core/a.ts', 'docs/old-a.md']);
    const sha = repo.commit('Move');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('a deleted trust file counts', (t) => {
    const repo = makeRepo(t);
    repo.git(['rm', '--quiet', '--', 'ops/deploy.sh']);
    const sha = repo.commit('Delete');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('a test on a trust path is tier 0', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.test.ts');
    passes(repo.run(repo.boundary, 'HEAD'), 'exempt 1 (tier 0)');
  });

  test('a trust file next to docs is still floor 2', (t) => {
    const repo = makeRepo(t);
    repo.write('docs/a.md', 'other\n');
    repo.write('packages/core/a.ts', 'other\n');
    const sha = repo.commit('Both');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('an ordinary file is floor 1: trailers needed, tier 1 is enough', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('src/glue.ts');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} floor 1: no Ship-Tier`);
    const repo2 = makeRepo(t);
    repo2.change('src/glue.ts', closed('glue', 1, 'code-reviewer-light'));
    passes(repo2.run(repo2.boundary, 'HEAD'), 'checked 1');
  });

  test('tier 0 claimed on floor 1 with no why fails', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('src/glue.ts', message('Change', 'Ship-Task: x', 'Ship-Tier: 0'));
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} tier 0 below floor 1`);
  });

  test('tier2New: an added file is floor 2, a changed one is not', (t) => {
    const repo = makeRepo(t);
    const added = repo.change('apps/web/new/page.tsx');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(added)} trust path: no Ship-Tier`);
    const repo2 = makeRepo(t);
    const changed = repo2.change('apps/web/page.tsx');
    fails(repo2.run(repo2.boundary, 'HEAD'), `${short(changed)} floor 1: no Ship-Tier`);
  });

  test('a root commit merged in from unrelated history is read, not seen as empty', (t) => {
    const repo = makeRepo(t);
    repo.git(['checkout', '--quiet', '--orphan', 'other']);
    repo.git(['rm', '-r', '--quiet', '--force', '--', '.']);
    const root = repo.change('packages/core/from-other.ts');
    repo.git(['checkout', '--quiet', 'main']);
    repo.git(['merge', '--quiet', '--allow-unrelated-histories', '-m', 'Merge', 'other']);
    fails(repo.run(repo.boundary, 'HEAD'), `${short(root)} trust path: no Ship-Tier`);
  });
});

describe('gitlinks and tier 0', () => {
  const bump = (repo, sha, path = 'private') =>
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${sha},${path}`]);

  test('a gitlink-only commit needs no trailers', (t) => {
    const repo = makeRepo(t);
    bump(repo, 'a'.repeat(40));
    repo.commit('Bump private');
    bump(repo, 'b'.repeat(40));
    repo.commit('Bump private');
    passes(repo.run(repo.boundary, 'HEAD'), 'checked 0, older 0, exempt 2 (gitlink)');
  });

  test('a gitlink-only commit with trailers has them checked', (t) => {
    const repo = makeRepo(t);
    bump(repo, 'a'.repeat(40));
    const sha = repo.commit(message('Bump', 'Ship-Task: Bad_Slug'));
    const r = repo.run(repo.boundary, 'HEAD');
    fails(r, `${short(sha)} bad Ship-Task`);
    assert.match(r.out, /checked 1/);
  });

  test('a gitlink at a trust path stays exempt: only the other files are judged', (t) => {
    const repo = makeRepo(t);
    bump(repo, 'a'.repeat(40), 'packages/core/vendored');
    repo.commit('Bump');
    passes(repo.run(repo.boundary, 'HEAD'), 'exempt 1 (gitlink)');
  });

  test('a mixed commit is judged on its other files', (t) => {
    const repo = makeRepo(t);
    bump(repo, 'a'.repeat(40));
    repo.write('packages/core/a.ts', 'other\n');
    const trust = repo.commit('Bump and change');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(trust)} trust path: no Ship-Tier`);

    const docs = makeRepo(t);
    bump(docs, 'a'.repeat(40));
    docs.write('docs/a.md', 'other\n');
    docs.commit('Bump and docs');
    passes(docs.run(docs.boundary, 'HEAD'), 'exempt 1 (tier 0)');
  });

  test('a trust file replaced by a gitlink is judged as a file', (t) => {
    const repo = makeRepo(t);
    repo.git(['rm', '--quiet', '--cached', '--', 'packages/core/a.ts']);
    bump(repo, 'a'.repeat(40), 'packages/core/a.ts');
    const sha = repo.commit('Replace');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('a docs-only commit needs no trailers', (t) => {
    const repo = makeRepo(t);
    repo.change('docs/a.md');
    passes(
      repo.run(repo.boundary, 'HEAD'),
      'checked 0, older 0, exempt 0 (gitlink), exempt 1 (tier 0)',
    );
  });

  test('an empty commit with no trailers is tier 0', (t) => {
    const repo = makeRepo(t);
    repo.commit('Nothing');
    passes(repo.run(repo.boundary, 'HEAD'), 'exempt 1 (tier 0)');
  });

  test('a docs commit with reviews but no task fails', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('docs/a.md', message('Docs', 'Ship-Reviews: code-reviewer'));
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} no Ship-Task`);
  });
});

describe('trailers', () => {
  test('correct trailers pass', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', closed('good-task'));
    passes(repo.run(repo.boundary, 'HEAD'), 'pass: checked 1,');
  });

  test('trailers in a body paragraph are not read', (t) => {
    const repo = makeRepo(t);
    const text = [
      'Subject',
      '',
      'Ship-Task: good-task',
      'Ship-Tier: 2',
      'Ship-Reviews: code-reviewer',
      '',
      'A closing sentence.',
    ].join('\n');
    const sha = repo.change('packages/core/a.ts', text);
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('trailers above a separate attribution paragraph are not read', (t) => {
    const repo = makeRepo(t);
    const text = [
      'Subject',
      '',
      'Ship-Task: good-task',
      'Ship-Tier: 2',
      'Ship-Reviews: code-reviewer',
      '',
      ATTRIBUTION,
    ].join('\n');
    const sha = repo.change('packages/core/a.ts', text);
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('a last paragraph with a line that is no trailer is not read', () => {
    assert.equal(parseTrailers('S\n\nShip-Tier: 2\nA sentence.').size, 0);
  });

  test('a subject is never a trailer', (t) => {
    assert.equal(parseTrailers('Ship-Tier: 2').size, 0);
    assert.equal(parseTrailers('Ship-Tier: 2\nShip-Task: x\n\n').size, 0);
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts', 'Ship-Tier: 2');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('parsing: continuation lines, CRLF, empty values, exact keys', () => {
    const folded = parseTrailers('S\n\nShip-Reviews: a,\n  b\nOther: x');
    assert.deepEqual(folded.get('Ship-Reviews'), ['a, b']);
    assert.deepEqual(parseTrailers('S\r\n\r\nShip-Tier: 2\r\n').get('Ship-Tier'), ['2']);
    assert.equal(parseTrailers('S\n\nShip-Tier:').has('Ship-Tier'), false);
    assert.equal(parseTrailers('S\n\nship-tier: 2').has('Ship-Tier'), false);
    assert.equal(parseTrailers('S\n\n  Ship-Tier: 2').size, 0);
    assert.equal(parseTrailers('').size, 0);
  });

  test('slugs are held to lowercase, digits and hyphens', (t) => {
    for (const slug of ['Upper', 'with_underscore', 'with space', 'dots.dots']) {
      const repo = makeRepo(t);
      const sha = repo.change('packages/core/a.ts', closed(slug));
      fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} bad Ship-Task`);
    }
  });

  test('a tier that is not 0 to 3 fails', (t) => {
    for (const tier of ['4', 'high', '2a', '-1']) {
      const repo = makeRepo(t);
      const sha = repo.change('packages/core/a.ts', closed('x', tier));
      fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} bad Ship-Tier`);
    }
  });

  test('a repeated trailer fails rather than picking one', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change(
      'packages/core/a.ts',
      message(
        'Change',
        'Ship-Task: x',
        'Ship-Tier: 0',
        'Ship-Tier: 2',
        'Ship-Reviews: code-reviewer',
      ),
    );
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} more than one Ship-Tier`);
  });

  test('commit text never reaches the output', (t) => {
    const repo = makeRepo(t);
    const evil = '::error::planted';
    repo.change(
      'packages/core/a.ts',
      message(evil, `Ship-Task: ${evil}`, `Ship-Tier: ${evil}`, `Ship-Tier-Why: ${evil}`),
    );
    repo.change(
      'src/glue.ts',
      message(evil, 'Ship-Task: x', 'Ship-Tier: 0', `Ship-Tier-Why: ${evil}`),
    );
    repo.change('docs/a.md', message(evil, `Ship-Owner: ${evil}`));
    const r = repo.run(repo.boundary, 'HEAD');
    assert.equal(r.status, 1);
    assert.ok(!r.out.includes('planted'), r.out);
  });
});

describe('tasks in a range', () => {
  test('a chunk then a closing commit, same slug', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    repo.change('packages/core/a.ts', closed('feature'));
    passes(repo.run(repo.boundary, 'HEAD'), 'pass: checked 2,');
  });

  test('a chunk then an empty closing commit with the reviews', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    repo.commit(message('Close', 'Ship-Task: feature', 'Ship-Reviews: code-reviewer'));
    passes(repo.run(repo.boundary, 'HEAD'), 'pass: checked 2,');
  });

  test('a chunk with no closing commit: the task is open at the end of the push', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    fails(repo.run(repo.boundary, 'HEAD'), 'task feature open');
  });

  test('a reviewed task does not cover an unreviewed one pushed with it', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('first'));
    repo.change('packages/core/a.ts', closed('second'));
    const r = repo.run(repo.boundary, 'HEAD');
    fails(r, 'task first open');
    assert.ok(!r.out.includes('task second'), r.out);
  });

  test('a reviewer missing from the list is named', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', closed('feature', 2, 'someone-else'));
    fails(repo.run(repo.boundary, 'HEAD'), 'task feature missing code-reviewer');
  });

  test('every required reviewer must be listed', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', closed('feature', 3, 'code-reviewer'));
    fails(repo.run(repo.boundary, 'HEAD'), 'task feature missing triage');
    const ok = makeRepo(t);
    ok.change('packages/core/a.ts', closed('feature', 3, 'triage, code-reviewer'));
    passes(ok.run(ok.boundary, 'HEAD'), 'checked 1');
    const spaced = makeRepo(t);
    spaced.change('packages/core/a.ts', closed('feature', 3, 'triage code-reviewer'));
    passes(spaced.run(spaced.boundary, 'HEAD'), 'checked 1');
  });

  test('the highest tier of the task decides, not the last one', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature', 2));
    repo.change('src/glue.ts', closed('feature', 1, 'code-reviewer-light'));
    fails(repo.run(repo.boundary, 'HEAD'), 'task feature missing code-reviewer');
  });

  test('only the last commit of the task counts: code after a review reopens it', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', closed('feature'));
    repo.change('packages/core/a.ts', chunk('feature'));
    fails(repo.run(repo.boundary, 'HEAD'), 'task feature open');
  });

  test('tasks may interleave', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('one'));
    repo.change('packages/core/a.ts', closed('two'));
    repo.change('packages/core/a.ts', closed('one'));
    passes(repo.run(repo.boundary, 'HEAD'), 'pass: checked 3,');
  });

  test('a tier 0 task needs no reviews', (t) => {
    const repo = makeRepo(t);
    repo.change('docs/a.md', message('Docs', 'Ship-Task: words', 'Ship-Tier: 0'));
    passes(repo.run(repo.boundary, 'HEAD'), 'pass: checked 1,');
  });

  test('a mistake is red once: the fix in the next push passes', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    const firstPush = repo.git(['rev-parse', 'HEAD']);
    fails(repo.run(repo.boundary, firstPush), 'task feature open');
    repo.commit(message('Close', 'Ship-Task: feature', 'Ship-Reviews: code-reviewer'));
    passes(repo.run(firstPush, 'HEAD'), 'pass: checked 1,');
  });
});

describe('owner commits, reverts and merges', () => {
  test('Ship-Owner passes with a notice', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts', message('Mine', 'Ship-Owner: urgent fix'));
    const r = repo.run(repo.boundary, 'HEAD');
    passes(r, 'owner 1');
    hasLine(r.out, `notice ${short(sha)} Ship-Owner: no review check on this commit`);
  });

  test('no automatic exemption: an owner commit with no trailer is red', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts', 'Plain owner commit, no attribution');
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('an attribution line is not what passes a commit', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts', message('Attributed'));
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('an empty Ship-Owner is no owner', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts', message('Mine', 'Ship-Owner:'));
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('an owner commit does not close a task', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    repo.change(
      'packages/core/a.ts',
      message('Mine', 'Ship-Owner: x', 'Ship-Task: feature', 'Ship-Reviews: code-reviewer'),
    );
    fails(repo.run(repo.boundary, 'HEAD'), 'task feature open');
  });

  test('a revert has no exemption', (t) => {
    const repo = makeRepo(t);
    const reviewed = repo.change('packages/core/a.ts', closed('feature'));
    const after = repo.git(['rev-parse', 'HEAD']);
    repo.git(['revert', '--no-edit', reviewed]);
    const revert = repo.git(['rev-parse', 'HEAD']);
    fails(repo.run(after, 'HEAD'), `${short(revert)} trust path: no Ship-Tier`);
  });

  test('a merge is not checked and is counted', (t) => {
    const repo = makeRepo(t);
    repo.git(['checkout', '--quiet', '-b', 'side']);
    repo.change('docs/b.md');
    repo.git(['checkout', '--quiet', 'main']);
    repo.git(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side']);
    const r = repo.run(repo.boundary, 'HEAD');
    passes(r, 'merges 1 not checked');
    assert.match(r.out, /checked 0, older 0, exempt 0 \(gitlink\), exempt 1 \(tier 0\)/);
  });

  test('a merge parent is checked', (t) => {
    const repo = makeRepo(t);
    repo.git(['checkout', '--quiet', '-b', 'side']);
    const parent = repo.change('packages/core/a.ts');
    repo.git(['checkout', '--quiet', 'main']);
    repo.git(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side']);
    fails(repo.run(repo.boundary, 'HEAD'), `${short(parent)} trust path: no Ship-Tier`);
  });
});

describe('--audit', () => {
  test('one open task, one why, one owner line; exit 0', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('never-closed'));
    repo.change(
      'src/glue.ts',
      message('Comment', 'Ship-Task: comment', 'Ship-Tier: 0', 'Ship-Tier-Why: comment only'),
    );
    repo.change('packages/core/a.ts', message('Mine', 'Ship-Owner: urgent'));
    const r = repo.run('--audit');
    passes(r, 'open 1, unclaimed 0, unreviewed 0, why 1, owner 1');
    hasLine(r.out, 'task never-closed open');
    assert.match(r.out, /audit: tasks 2,/);
  });

  test('a task closed in a later push is not open', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    repo.commit(message('Close', 'Ship-Task: feature', 'Ship-Reviews: code-reviewer'));
    passes(repo.run('--audit'), 'open 0, unclaimed 0, unreviewed 0, why 0, owner 0');
  });

  test('a task closed with the wrong reviewer is open, by its whole-history tier', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('feature'));
    repo.commit(message('Close', 'Ship-Task: feature', 'Ship-Reviews: code-reviewer-light'));
    const r = repo.run('--audit');
    passes(r, 'open 1,');
    hasLine(r.out, 'task feature missing code-reviewer');
  });

  test('reads only after the boundary', (t) => {
    const repo = makeRepo(t, { seed: false });
    repo.write('packages/core/a.ts');
    repo.commit(chunk('before-the-check'));
    repo.write('ops/process-check.json', `${JSON.stringify(CONFIG)}\n`);
    repo.commit('Add the config');
    passes(
      repo.run('--audit'),
      'audit: tasks 0, open 0, unclaimed 0, unreviewed 0, why 0, owner 0',
    );
  });

  test('a merge is not read, whatever its message says', (t) => {
    const repo = makeRepo(t);
    repo.git(['checkout', '--quiet', '-b', 'side']);
    repo.change('docs/b.md');
    repo.git(['checkout', '--quiet', 'main']);
    const text = message('Merge', 'Ship-Task: in-a-merge', 'Ship-Tier: 2', 'Ship-Tier-Why: x');
    repo.git(['merge', '--quiet', '--no-ff', '-m', text, 'side']);
    passes(
      repo.run('--audit'),
      'audit: tasks 0, open 0, unclaimed 0, unreviewed 0, why 0, owner 0',
    );
  });

  test('no config: says so, exit 0', (t) => {
    const repo = makeRepo(t, { seed: false });
    repo.commit('Seed');
    passes(repo.run('--audit'), 'audit: no config');
  });

  test('takes a revision', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', chunk('later'));
    passes(repo.run('--audit', repo.boundary), 'audit: tasks 0,');
  });

  test('a trust commit with no trailers is unclaimed, with its sha, once; exit 0', (t) => {
    const repo = makeRepo(t);
    const bare = repo.change('packages/core/a.ts');
    repo.change('src/glue.ts', closed('fine', 1, 'code-reviewer-light'));
    const low = repo.change('packages/core/a.ts', chunk('low', 1));
    const r = repo.run('--audit');
    passes(r, 'audit: tasks 2, open 1, unclaimed 2, unreviewed 2, why 0, owner 0');
    hasLine(r.out, `unclaimed 2: ${short(bare)} ${short(low)}`);
    hasLine(r.out, `unreviewed 2: ${short(bare)} ${short(low)}`);
  });

  test('no failure prints no unclaimed list', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts', closed('fine'));
    const r = repo.run('--audit');
    passes(r, 'unclaimed 0');
    assert.ok(!r.out.includes('unclaimed 0:'), r.out);
    assert.ok(!r.out.includes('unreviewed 0:'), r.out);
  });
});

describe('--audit --reviewed', () => {
  // The file sits beside the checkout's own files and is never committed: the audit reads revisions.
  const auditWith = (repo, text) => {
    if (text !== undefined) writeFileSync(join(repo.dir, 'reviewed.txt'), text);
    return repo.run('--audit', '--reviewed', 'reviewed.txt');
  };

  test('prints unclaimed and unreviewed, with the shas not listed; exit 0', (t) => {
    const repo = makeRepo(t);
    const one = repo.change('packages/core/a.ts');
    const two = repo.change('packages/core/a.ts');
    const r = auditWith(repo, `${one}\n`);
    passes(r, 'unclaimed 2, unreviewed 1,');
    hasLine(r.out, `unclaimed 2: ${short(one)} ${short(two)}`);
    hasLine(r.out, `unreviewed 1: ${short(two)}`);
    assert.ok(!r.out.includes(`unreviewed 1: ${short(one)}`), r.out);
  });

  test('every sha listed: nothing open', (t) => {
    const repo = makeRepo(t);
    const one = repo.change('packages/core/a.ts');
    const two = repo.change('packages/core/a.ts');
    const r = auditWith(repo, `${one}\n${two}\n`);
    passes(r, 'unclaimed 2, unreviewed 0,');
    assert.ok(!r.out.includes('unreviewed 0:'), r.out);
  });

  test('a missing file, and an empty one, list nothing: every unclaimed sha counts', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts');
    passes(repo.run('--audit', '--reviewed', 'absent.txt'), 'unclaimed 1, unreviewed 1,');
    passes(auditWith(repo, ''), 'unclaimed 1, unreviewed 1,');
    passes(auditWith(repo, '\n\n'), 'unclaimed 1, unreviewed 1,');
  });

  test('any sha length from 7, blank lines and a CRLF file read the same', (t) => {
    const repo = makeRepo(t);
    const one = repo.change('packages/core/a.ts');
    for (const line of [one, short(one), one.slice(0, 7)]) {
      passes(auditWith(repo, `\n${line}\r\n\n`), 'unreviewed 0,');
    }
  });

  test('a sha of another commit, or one that only shares a few digits, lists nothing', (t) => {
    const repo = makeRepo(t);
    const one = repo.change('packages/core/a.ts');
    const notAt = (i) => (one[i] === 'a' ? 'b' : 'a');
    passes(auditWith(repo, `${notAt(0).repeat(40)}\n`), 'unreviewed 1,');
    passes(auditWith(repo, `${one.slice(0, 7)}${notAt(7)}\n`), 'unreviewed 1,');
  });

  test('a line that is not a sha fails, naming the line, and is never skipped', (t) => {
    const repo = makeRepo(t);
    const one = repo.change('packages/core/a.ts');
    for (const [text, line] of [
      [`${one}\nnot a sha\n`, 2],
      [`abc123\n`, 1],
      [`${one.toUpperCase()}\n`, 1],
      [`${one} looked at it\n`, 1],
      [`${'a'.repeat(41)}\n`, 1],
    ]) {
      const r = auditWith(repo, text);
      assert.equal(r.status, 1, text);
      assert.match(
        r.out,
        new RegExp(`^fail: reviewed\\.txt: line ${line} is not a sha$`, 'm'),
        text,
      );
    }
  });

  test('a path that cannot be read fails', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts');
    const r = repo.run('--audit', '--reviewed', 'packages');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^fail: packages: could not be read$/m);
  });

  test('takes a revision on either side of the flag', (t) => {
    const repo = makeRepo(t);
    const one = repo.change('packages/core/a.ts');
    repo.change('packages/core/a.ts');
    passes(repo.run('--audit', '--reviewed', 'absent.txt', one), 'unclaimed 1, unreviewed 1,');
    passes(repo.run('--audit', one, '--reviewed', 'absent.txt'), 'unclaimed 1, unreviewed 1,');
  });

  test('a push check takes no such flag, and the audit needs no file', (t) => {
    const repo = makeRepo(t);
    repo.change('packages/core/a.ts');
    assert.equal(repo.run(ZEROS, '--reviewed', 'x').status, 2);
    passes(repo.run('--audit'), 'unclaimed 1, unreviewed 1,');
  });

  test('a new unreviewed commit plus a config change: a count would not move, the shas do', (t) => {
    const repo = makeRepo(t);
    const old = repo.change('src/glue.ts', chunk('old-low', 0));
    passes(auditWith(repo, `${old}\n`), 'unclaimed 1, unreviewed 0,');
    // The config stops failing the old commit, and a new one fails: still one unclaimed.
    const relaxed = { ...CONFIG, tier0: [...CONFIG.tier0, 'src/'] };
    repo.write('ops/process-check.json', `${JSON.stringify(relaxed)}\n`);
    repo.commit(closed('relax'));
    const fresh = repo.change('packages/core/b.ts');
    const r = auditWith(repo);
    passes(r, 'unclaimed 1, unreviewed 1,');
    hasLine(r.out, `unclaimed 1: ${short(fresh)}`);
    hasLine(r.out, `unreviewed 1: ${short(fresh)}`);
  });

  test('a config tightening makes a reviewed task read unclaimed, until it is looked at', (t) => {
    const repo = makeRepo(t);
    const done = repo.change('src/glue.ts', closed('fine', 1, 'code-reviewer-light'));
    passes(auditWith(repo, ''), 'unclaimed 0, unreviewed 0,');
    const tighter = { ...CONFIG, tier2: [...CONFIG.tier2, 'src/'] };
    repo.write('ops/process-check.json', `${JSON.stringify(tighter)}\n`);
    repo.commit(closed('tighten'));
    const before = auditWith(repo);
    passes(before, 'unclaimed 1, unreviewed 1,');
    hasLine(before.out, `unreviewed 1: ${short(done)}`);
    passes(auditWith(repo, `${done}\n`), 'unclaimed 1, unreviewed 0,');
  });
});

describe('a push that changes the config', () => {
  const edited = (over) => `${JSON.stringify({ ...CONFIG, ...over })}\n`;

  test('emptying a reviewer list fails by the rules from before the push', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.write('ops/process-check.json', edited({ reviews: { ...CONFIG.reviews, 2: [] } }));
    const weakened = repo.commit(chunk('weaken'));
    const r = repo.run(before, 'HEAD');
    fails(r, 'task weaken open (by the config before this push)');
    hasLine(
      r.out,
      'notice this push changes the config: judged by both, a failure of either fails',
    );
    // The new rules alone pass it, which is the hole. Red once: the next push starts from them.
    passes(repo.run(weakened, 'HEAD'), 'checked 0');
    repo.change('packages/core/a.ts', chunk('next'));
    passes(repo.run(weakened, 'HEAD'), 'checked 1');
  });

  test('moving a trust path to tier 0 fails by the rules from before the push', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.write('ops/process-check.json', edited({ tier0: [...CONFIG.tier0, 'packages/core/'] }));
    repo.commit(closed('reword'));
    const trust = repo.change('packages/core/a.ts');
    const r = repo.run(before, 'HEAD');
    fails(r, `${short(trust)} trust path: no Ship-Tier (by the config before this push)`);
    fails(r, `${short(trust)} trust path: no Ship-Task (by the config before this push)`);
  });

  test('a rule the push adds counts too, with no suffix', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.write(
      'ops/process-check.json',
      edited({ reviews: { ...CONFIG.reviews, 2: ['code-reviewer', 'triage'] } }),
    );
    repo.commit(closed('tighten'));
    fails(repo.run(before, 'HEAD'), 'task tighten missing triage');
  });

  test('a failure under both rules prints once, with no suffix', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.write('ops/process-check.json', edited({ tier2New: [] }));
    const bare = repo.commit('No trailers');
    const r = repo.run(before, 'HEAD');
    fails(r, `${short(bare)} trust path: no Ship-Tier`);
    assert.equal(r.out.split(`${short(bare)} trust path: no Ship-Tier`).length, 2, r.out);
  });

  test('passes when both rules pass, and says it read both', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.write('ops/process-check.json', edited({ tier2New: [] }));
    repo.commit(closed('harmless'));
    const r = repo.run(before, 'HEAD');
    passes(r, 'checked 1');
    hasLine(
      r.out,
      'notice this push changes the config: judged by both, a failure of either fails',
    );
  });

  test('an unchanged config is read once: no notice', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.change('packages/core/a.ts', closed('plain'));
    const r = repo.run(before, 'HEAD');
    passes(r, 'checked 1');
    assert.ok(!r.out.includes('judged by both'), r.out);
  });

  test('no config before the push: the new rules alone, no notice', (t) => {
    const repo = makeRepo(t);
    const r = repo.run(`${repo.boundary}~1`, repo.boundary);
    passes(r, 'checked 0');
    assert.ok(!r.out.includes('judged by both'), r.out);
    assert.ok(!repo.run(ZEROS, 'HEAD').out.includes('judged by both'));
  });

  test('a config before the push that it cannot use fails, naming which', (t) => {
    const repo = makeRepo(t);
    repo.write('ops/process-check.json', 'not json\n');
    const broken = repo.commit(closed('break'));
    repo.write('ops/process-check.json', `${JSON.stringify(CONFIG)}\n`);
    repo.commit(closed('repair'));
    fails(repo.run(broken, 'HEAD'), 'fail: ops/process-check.json before this push: not JSON');
  });
});

describe('the failure message', () => {
  test('says what to do with a commit that has no task to close', (t) => {
    const repo = makeRepo(t);
    const before = repo.git(['rev-parse', 'HEAD']);
    repo.change('packages/core/a.ts');
    const r = repo.run(before, 'HEAD');
    assert.equal(r.status, 1, r.out);
    const text = r.out.replace(/\s+/g, ' ');
    assert.ok(text.includes('This run does not hold back a server.'), r.out);
    assert.ok(text.includes('A commit with no Ship-Task has no task to close'), r.out);
    assert.ok(text.includes('--audit lists it as unclaimed'), r.out);
  });
});

describe('config', () => {
  test('a config it cannot use fails the run', (t) => {
    const broken = [
      'not json',
      'null',
      '[]',
      JSON.stringify({ ...CONFIG, tier2: 'packages/core/' }),
      JSON.stringify({ ...CONFIG, tier0: undefined }),
      JSON.stringify({ ...CONFIG, tier2New: [1] }),
      JSON.stringify({ ...CONFIG, reviews: undefined }),
      JSON.stringify({ ...CONFIG, reviews: { 0: [], 1: [], 2: [] } }),
      JSON.stringify({ ...CONFIG, reviews: { ...CONFIG.reviews, 2: ['Bad Name'] } }),
      JSON.stringify({ ...CONFIG, profileBullets: [] }),
      JSON.stringify({ ...CONFIG, tier2: ['packages/{core,db}/'] }),
    ];
    for (const text of broken) {
      assert.throws(() => parseConfig(text));
    }
    const repo = makeRepo(t);
    repo.write('ops/process-check.json', 'not json\n');
    repo.commit(closed('break-config'));
    const r = repo.run(repo.boundary, 'HEAD');
    assert.equal(r.status, 1);
    assert.match(r.out, /^fail: ops\/process-check\.json: not JSON/m);
  });

  test('the config is read from the commit, not the working tree', (t) => {
    const repo = makeRepo(t);
    const sha = repo.change('packages/core/a.ts');
    writeFileSync(
      join(repo.dir, 'ops/process-check.json'),
      JSON.stringify({ ...CONFIG, tier2: [] }),
    );
    fails(repo.run(repo.boundary, 'HEAD'), `${short(sha)} trust path: no Ship-Tier`);
  });

  test('patterns', () => {
    const cases = [
      ['packages/core/', 'packages/core/a.ts', true],
      ['packages/core/', 'packages/core/deep/a.ts', true],
      ['packages/core/', 'packages/core', false],
      ['packages/core/', 'packages/core-extra/a.ts', false],
      ['packages/core/', 'other/packages/core/a.ts', false],
      ['ops/deploy.sh', 'ops/deploy.sh', true],
      ['ops/deploy.sh', 'ops/deployXsh', false],
      ['ops/deploy.sh', 'ops/deploy.sh.bak', false],
      ['ops/*.sh', 'ops/deploy.sh', true],
      ['ops/*.sh', 'ops/sub/deploy.sh', false],
      ['ops/?.sh', 'ops/a.sh', true],
      ['ops/?.sh', 'ops/ab.sh', false],
      ['**/*.md', 'README.md', true],
      ['**/*.md', 'a/b/c.md', true],
      ['**/*.md', 'a/b/c.mdx', false],
      ['**/*.test.*', 'packages/core/a.test.ts', true],
      ['apps/**/page.*', 'apps/page.tsx', true],
      ['apps/**/page.*', 'apps/web/src/app/x/page.tsx', true],
      ['apps/**/page.*', 'apps/web/src/app/x/subpage.tsx', false],
      ['.github/workflows/', '.github/workflows/ci.yml', true],
      ['.github/workflows/', 'xgithub/workflows/ci.yml', false],
      ['a/**', 'a/b/c', true],
      ['a+b/', 'a+b/c', true],
      ['a+b/', 'aab/c', false],
    ];
    for (const [pattern, path, expected] of cases) {
      assert.equal(globToRegExp(pattern).test(path), expected, `${pattern} on ${path}`);
    }
    for (const bad of ['', '/abs', './rel', 'a/[bc]/', 'a/{b,c}', '!a', 'a**/b', 'a\\b', 5]) {
      assert.throws(() => globToRegExp(bad), /bad pattern/, String(bad));
    }
  });
});

describe('the config agrees with the profile', () => {
  const profile = (paths) => `# Agent profile

## Trust territory (Tier 2)

Areas: where a mistake is silent.

Paths (a changed file here makes the change Tier 2):
${paths}

## Domain checklist

- Not a path bullet.
`;
  const base = {
    tier2: ['packages/core/', 'ops/deploy.sh'],
    tier2New: [],
    profileBullets: {
      '`packages/core/`': { patterns: ['packages/core/'] },
      '`ops/deploy.sh`': { patterns: ['ops/deploy.sh'] },
    },
  };
  const text = profile('- `packages/core/`\n- `ops/deploy.sh`');

  test('agreeing files have no problems', () => {
    assert.deepEqual(agreementProblems(base, text), []);
  });

  test('a new bullet with no entry is a problem', () => {
    const problems = agreementProblems(
      base,
      profile('- `packages/core/`\n- `ops/deploy.sh`\n- any page'),
    );
    assert.deepEqual(problems, ['bullet with no profileBullets entry: any page']);
  });

  test('a reworded bullet is a problem both ways', () => {
    const problems = agreementProblems(base, profile('- `packages/core/`\n- the deploy script'));
    assert.ok(problems.includes('bullet with no profileBullets entry: the deploy script'));
    assert.ok(problems.includes('entry that is no longer a bullet: `ops/deploy.sh`'));
  });

  test('a pattern that belongs to no bullet is a problem', () => {
    const config = { ...base, tier2: [...base.tier2, 'secret/'] };
    assert.deepEqual(agreementProblems(config, text), [
      'pattern that belongs to no bullet: secret/',
    ]);
  });

  test('a tier2New pattern belongs to a bullet too', () => {
    const config = { ...base, tier2New: ['apps/**/page.*'] };
    assert.deepEqual(agreementProblems(config, text), [
      'pattern that belongs to no bullet: apps/**/page.*',
    ]);
  });

  test('a bullet naming a pattern nothing enforces is a problem', () => {
    const config = { ...base, tier2: ['packages/core/'] };
    assert.deepEqual(agreementProblems(config, text), [
      'bullet pattern not enforced: ops/deploy.sh',
    ]);
  });

  test('a bullet may give a reason instead of patterns; an entry with neither is a problem', () => {
    const paths = profile('- `packages/core/`\n- `ops/deploy.sh`\n- `private/` code');
    const withReason = {
      ...base,
      profileBullets: {
        ...base.profileBullets,
        '`private/` code': { reason: 'not visible to CI' },
      },
    };
    assert.deepEqual(agreementProblems(withReason, paths), []);
    for (const entry of [{}, { reason: '  ' }, { patterns: [] }, null, 'text']) {
      const config = {
        ...base,
        profileBullets: { ...base.profileBullets, '`private/` code': entry },
      };
      assert.deepEqual(agreementProblems(config, paths), [
        'entry with neither patterns nor a reason: `private/` code',
      ]);
    }
  });

  test('a profile with no Paths list is a problem, not a pass', () => {
    const empty = { ...base, tier2: [], profileBullets: {} };
    for (const body of [
      '# Agent profile\n',
      '## Trust territory\n\nAreas: x\n\n## Next\n\nPaths:\n- `a`\n',
    ]) {
      assert.deepEqual(agreementProblems(empty, body), [
        'no trust-territory Paths list in the profile',
      ]);
    }
  });

  test('bullets: a blank line after the Paths line, wrapped bullets, normalized spaces', () => {
    const body = `## Trust territory (Tier 2)

Areas: x.

Paths (a changed file here makes
the change Tier 2):

- \`a/\`,   \`b/\`
- \`c.sh\`, \`d.sh\`,
  \`e.sh\`

Some later paragraph.

- Not a path bullet.
`;
    assert.deepEqual(profilePathBullets(body), ['`a/`, `b/`', '`c.sh`, `d.sh`, `e.sh`']);
    const config = {
      tier2: [],
      tier2New: [],
      profileBullets: {
        '`a/`, `b/`': { reason: 'x' },
        '`c.sh`,   `d.sh`,\n `e.sh`': { reason: 'x' },
      },
    };
    assert.deepEqual(agreementProblems(config, body), []);
  });

  test('this repo: the config parses and agrees with docs/agents.md', () => {
    const config = parseConfig(readFileSync(join(OPS, 'process-check.json'), 'utf8'));
    const problems = agreementProblems(config, readFileSync(join(ROOT, 'docs/agents.md'), 'utf8'));
    assert.deepEqual(problems, []);
  });

  test('this repo: the process files and the CI workflows are on trust paths', () => {
    const config = parseConfig(readFileSync(join(OPS, 'process-check.json'), 'utf8'));
    for (const path of [
      '.github/workflows/process.yml',
      '.github/workflows/ci.yml',
      'ops/process-check.mjs',
      'ops/process-check.json',
      'ops/ci-status.sh',
    ]) {
      assert.ok(
        config.matchers.tier2.some((re) => re.test(path)),
        path,
      );
      assert.ok(!config.matchers.tier0.some((re) => re.test(path)), path);
    }
  });
});

describe('the workflow and the gate agree', () => {
  /** Job ids and whether any job sets `name:`, read by indent: no YAML parser here. */
  function readJobs(yaml) {
    const lines = yaml.split('\n');
    const start = lines.indexOf('jobs:');
    assert.notEqual(start, -1, 'no jobs: key');
    const ids = [];
    const names = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (id) ids.push(id[1]);
      const name = /^ {4}name:\s*(.*)$/.exec(line);
      if (name) names.push(name[1]);
    }
    return { ids, names };
  }
  const workflow = readFileSync(join(ROOT, '.github/workflows/process.yml'), 'utf8');
  const status = readFileSync(join(OPS, 'ci-status.sh'), 'utf8');

  test('the job id in the workflow is the name the gate drops', () => {
    const dropped = /const PROCESS_JOB = "([^"]+)";/.exec(status);
    assert.ok(dropped, 'ops/ci-status.sh names no process job');
    const { ids, names } = readJobs(workflow);
    assert.deepEqual(ids, [dropped[1]]);
    // A `name:` would rename the check run, and the gate would count it.
    assert.deepEqual(names, []);
  });

  test('push to main only, the whole history, tests and the range check both run', () => {
    assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n\n/m);
    assert.ok(!workflow.includes('pull_request'));
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /run: node --test ops\/process-check\.test\.mjs$/m);
    assert.match(workflow, /BEFORE: \$\{\{ github\.event\.before \}\}/);
    assert.match(workflow, /AFTER: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /run: node ops\/process-check\.mjs "\$BEFORE" "\$AFTER"$/m);
    assert.ok(!workflow.includes('continue-on-error'));
  });
});
