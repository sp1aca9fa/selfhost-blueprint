import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  addMessages,
  buildSpend,
  emptyTotals,
  parseTranscript,
  renderSpend,
  transcriptsDir,
  weigh,
} from './spend-view.mjs';

const SCRIPT = fileURLToPath(new URL('./spend-view.mjs', import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const at = (minute) => new Date(Date.UTC(2026, 10, 7, 0, minute)).toISOString();

function line(id, minute, usage, content = []) {
  return JSON.stringify({ type: 'assistant', timestamp: at(minute), message: { id, usage, content } });
}
const usage = (input, cacheWrite, cacheRead, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
});
const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });
const edit = { type: 'tool_use', name: 'Edit', input: { file_path: '/secret/path.ts' } };

function totalsFor(lines, isBuilder = false) {
  const totals = emptyTotals();
  addMessages(totals, parseTranscript(lines.join('\n')).messages, isBuilder);
  return totals;
}

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'spend-view-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

describe('reading a transcript', () => {
  it('weighs each kind of token', () => {
    assert.equal(weigh({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 20 }), 10 + 125 + 100 + 100);
  });

  it('merges the lines of one message, keeping the largest of each field', () => {
    const { messages } = parseTranscript(
      [line('m1', 0, usage(1, 100, 500, 2)), line('m1', 0, usage(1, 100, 500, 90), [edit])].join('\n'),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].output, 90);
    assert.equal(messages[0].edits, true);
  });

  it('counts a line that is not JSON and ignores other kinds of row', () => {
    const { messages, skipped } = parseTranscript(
      ['{broken', JSON.stringify({ type: 'user', message: { id: 'u' } }), line('m1', 0, usage(1, 0, 0, 1))].join('\n'),
    );
    assert.equal(skipped, 1);
    assert.equal(messages.length, 1);
  });

  it('adds no spend for a message with no usage', () => {
    const totals = totalsFor([JSON.stringify({ type: 'assistant', timestamp: at(0), message: { id: 'm1' } })]);
    assert.equal(totals.turns, 1);
    assert.equal(totals.weighted, 0);
  });
});

describe('pools', () => {
  it('counts a miss on a large rewritten context, and whether an idle gap came before it', () => {
    const totals = totalsFor([
      line('a', 0, usage(0, 1000, 60_000, 10)),
      line('b', 1, usage(0, 50_000, 10_000, 10)), // a miss with no idle gap
      line('c', 10, usage(0, 50_000, 10_000, 10)), // a miss after 9 minutes
    ]);
    assert.equal(totals.misses, 2);
    assert.equal(totals.idleMisses, 1);
    assert.equal(totals.missWeighted, 2 * 50_000 * 1.25);
    assert.equal(totals.idleMissWeighted, 50_000 * 1.25);
  });

  it('does not call the first read of a small context a miss', () => {
    const totals = totalsFor([line('a', 0, usage(0, 15_000, 0, 10))]);
    assert.equal(totals.misses, 0);
  });

  it('treats exactly half rewritten as no miss', () => {
    const totals = totalsFor([line('a', 0, usage(0, 30_000, 30_000, 0))]);
    assert.equal(totals.misses, 0);
  });

  it('counts only active gaps under the idle limit', () => {
    const totals = totalsFor([line('a', 0, usage(0, 0, 0, 1)), line('b', 2, usage(0, 0, 0, 1)), line('c', 60, usage(0, 0, 0, 1))]);
    assert.equal(totals.activeMs, 2 * 60_000);
  });

  for (const command of ['sleep 30', 'x=1; sleep 5', 'pgrep -f job', 'tail -f a.log', 'timeout 170 tail -n 0 -f a.log']) {
    it(`calls "${command}" polling`, () => {
      assert.equal(totalsFor([line('a', 0, usage(0, 0, 100, 1), [bash(command)])]).polls, 1);
    });
  }

  for (const command of ['git log', 'tail -n 5 a.log', 'grep sleep a.txt', 'pnpm test']) {
    it(`does not call "${command}" polling`, () => {
      assert.equal(totalsFor([line('a', 0, usage(0, 0, 100, 1), [bash(command)])]).polls, 0);
    });
  }

  it('counts spend up to and including the turn of the first edit, for builders only', () => {
    const lines = [
      line('a', 0, usage(0, 0, 1000, 0)),
      line('b', 1, usage(0, 0, 1000, 0), [edit]),
      line('c', 2, usage(0, 0, 1000, 0)),
    ];
    assert.equal(totalsFor(lines, true).preEdit, 200);
    assert.equal(totalsFor(lines, false).preEdit, 0);
  });

  it('counts only the context above the limit', () => {
    const totals = totalsFor([line('a', 0, usage(0, 0, 250_000, 0)), line('b', 1, usage(0, 0, 200_000, 0))]);
    assert.equal(totals.overLimitTurns, 1);
    assert.equal(totals.overLimitWeighted, 5000);
  });
});

describe('a project', () => {
  const files = () => ({
    's1.jsonl': line('m', 0, usage(100, 0, 0, 0)),
    's1/subagents/agent-a.jsonl': line('b', 0, usage(0, 0, 1000, 10)),
    's1/subagents/agent-a.meta.json': JSON.stringify({ agentType: 'builder-heavy', description: 'my-task: Build it' }),
    's1/subagents/agent-b.jsonl': line('c', 0, usage(0, 0, 500, 0)),
    's1/subagents/agent-b.meta.json': JSON.stringify({ agentType: 'code-reviewer', description: 'Review secret-feature' }),
    's2.jsonl': line('n', 0, usage(200, 0, 0, 0)),
  });

  it('splits main session and agents, by role and by task', () => {
    const spend = buildSpend({ dir: project(files()) });
    assert.equal(spend.main.weighted, 300);
    assert.equal(spend.agents.weighted, 200);
    assert.equal(spend.roles.get('builder-heavy').totals.weighted, 150);
    assert.equal(spend.tasks.get('my-task').runs, 1);
    assert.equal(spend.tasks.get('(no slug)').runs, 1);
  });

  it('prints no description text beyond a slug, and no command or path', () => {
    const dir = project({
      ...files(),
      's1/subagents/agent-a.jsonl': line('b', 0, usage(0, 0, 1000, 10), [edit, bash('cat /secret/file')]),
    });
    const text = renderSpend(buildSpend({ dir })).join('\n');
    assert.match(text, /my-task/);
    assert.doesNotMatch(text, /secret/);
    assert.doesNotMatch(text, /Build it/);
  });

  it('prints misses apart for the main session and agents', () => {
    const missed = usage(0, 2_000_000, 0, 0);
    const dir = project({
      's.jsonl': line('m', 0, missed),
      's/subagents/agent-a.jsonl': [line('b', 0, usage(0, 0, 100, 0)), line('c', 10, missed)].join('\n'),
    });
    const text = renderSpend(buildSpend({ dir })).join('\n');
    assert.match(text, /cache misses, main session: 1 turns, 2\.5; after an idle gap: 0 turns, 0\.0/);
    assert.match(text, /cache misses, agents: 1 turns, 2\.5; after an idle gap: 1 turns, 2\.5/);
  });

  it('never prints a role that is not a plain name', () => {
    const dir = project({
      's.jsonl': line('m', 0, usage(1, 0, 0, 0)),
      's/subagents/agent-a.jsonl': line('b', 0, usage(1, 0, 0, 0)),
      's/subagents/agent-a.meta.json': JSON.stringify({ agentType: 'Secret Name!' }),
    });
    const text = renderSpend(buildSpend({ dir })).join('\n');
    assert.doesNotMatch(text, /Secret/);
    assert.match(text, /unknown: runs 1/);
  });

  it('filters by session prefix', () => {
    const spend = buildSpend({ dir: project(files()), session: 's2' });
    assert.equal(spend.main.weighted, 200);
    assert.equal(spend.agents.weighted, 0);
  });

  it('filters by date, keeping only the messages on or after it', () => {
    const old = JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { id: 'o', usage: usage(1000, 0, 0, 0) } });
    const dir = project({ 's.jsonl': [old, line('m', 0, usage(5, 0, 0, 0))].join('\n') });
    assert.equal(buildSpend({ dir, since: '2026-11-01' }).main.weighted, 5);
  });

  it('drops a message with no timestamp under a date filter, since its date is unknown', () => {
    const noTime = JSON.stringify({ type: 'assistant', message: { id: 'o', usage: usage(1000, 0, 0, 0) } });
    assert.equal(buildSpend({ dir: project({ 's.jsonl': noTime }), since: '2026-11-01' }).main.weighted, 0);
  });

  it('reads a missing meta file as an unknown role', () => {
    const dir = project({ 's.jsonl': line('m', 0, usage(1, 0, 0, 0)), 's/subagents/agent-a.jsonl': line('b', 0, usage(1, 0, 0, 0)) });
    assert.equal(buildSpend({ dir }).roles.get('unknown').runs, 1);
  });

  it('says spend is unknown, never zero, with no transcripts', () => {
    const lines = renderSpend(buildSpend({ dir: project({}) }));
    assert.deepEqual(lines, ['No transcripts found: spend unknown.']);
  });

  it('changes nothing on disk', () => {
    const dir = project(files());
    const before = readdirSync(dir, { recursive: true }).sort();
    renderSpend(buildSpend({ dir }));
    assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
  });
});

describe('command line', () => {
  it('finds a project folder the way Claude Code names it', () => {
    assert.match(transcriptsDir('/home/a/my_code/tora-v2'), /-home-a-my-code-tora-v2$/);
  });

  it('prints unknown for a folder that does not exist', () => {
    const out = execFileSync('node', [SCRIPT, '--transcripts', join(tmpdir(), 'no-such-spend-folder')], { encoding: 'utf8' });
    assert.match(out, /spend unknown/);
  });

  it('prints a report for a real folder', () => {
    const dir = project({ 's.jsonl': line('m', 0, usage(100, 0, 0, 0)) });
    const out = execFileSync('node', [SCRIPT, '--transcripts', dir, '--since', '2026-01-01'], { encoding: 'utf8' });
    assert.match(out, /Total 0\.0: main session 0\.0, agents 0\.0/);
  });

  for (const args of [['--nope', 'x'], ['--since'], ['--since', 'yesterday']]) {
    it(`refuses ${args.join(' ')}`, () => {
      assert.throws(() => execFileSync('node', [SCRIPT, ...args], { stdio: 'pipe' }), (e) => e.status === 2);
    });
  }
});
