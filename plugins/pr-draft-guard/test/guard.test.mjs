import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'guard.mjs');

function repoOn(branch) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'prdg-')));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', branch);
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('remote', 'add', 'origin', 'https://example.invalid/r.git');
  return dir;
}

const FEATURE = repoOn('feature/x');
const MAIN = repoOn('main');

function run(command, { cwd = FEATURE, tool = 'Bash', env = {} } = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, stderr: r.stderr };
}
const blocked = (cmd, opts) => {
  const r = run(cmd, opts);
  assert.equal(r.code, 2, `expected BLOCK for: ${cmd}\n${r.stderr}`);
  return r;
};
const allowed = (cmd, opts) => {
  const r = run(cmd, opts);
  assert.equal(r.code, 0, `expected ALLOW for: ${cmd}\n${r.stderr}`);
};

test('gh pr create without --draft is blocked, with the reason', () => {
  const r = blocked('gh pr create --base development --title "x" --body "y"');
  assert.match(r.stderr, /--draft/);
});

test('gh pr create as a draft is allowed in every spelling', () => {
  allowed('gh pr create --draft --base development --title x --body y');
  allowed('gh pr create -d -t x -b y');
  allowed('gh pr create --draft=true --fill');
  allowed('gh pr create -fd');
  allowed('gh pr new --draft --fill');
});

test('--draft=false and the alias `gh pr new` without draft are blocked', () => {
  blocked('gh pr create --draft=false --fill');
  blocked('gh pr new --fill');
});

test('a draft flag that only appears inside the body text does not count', () => {
  blocked('gh pr create --title x --body "remember to pass --draft"');
});

test('gh pr create without --draft is caught inside compound commands and wrappers', () => {
  blocked('cd repo && gh pr create --fill');
  blocked('git push -u origin feature/x; gh pr create --fill');
  blocked('GH_TOKEN=abc gh pr create --fill');
  blocked('env -u GH_HOST command gh pr create --fill');
  blocked('/opt/homebrew/bin/gh pr create --fill');
  blocked('bash -c "gh pr create --fill"');
  blocked('timeout 60 gh pr create --fill');
});

test('any gh pr merge is blocked, including auto-merge', () => {
  blocked('gh pr merge 280 --squash');
  blocked('gh pr merge --auto --merge 12');
  blocked('gh -R Matchbox-Virtual/x pr merge 1');
  blocked('gh pr merge 1 --repo Matchbox-Virtual/x');
});

test('gh pr ready is blocked, gh pr ready --undo (back to draft) is allowed', () => {
  blocked('gh pr ready 280');
  allowed('gh pr ready 280 --undo');
});

test('merging through the API is blocked; reading through it is allowed', () => {
  blocked('gh api -X PUT repos/o/r/pulls/12/merge');
  blocked('gh api repos/o/r/pulls/12/merge -f merge_method=squash');
  blocked(`gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }'`);
  blocked(`gh api graphql -f query='mutation { markPullRequestReadyForReview(input:{pullRequestId:"x"}) { clientMutationId } }'`);
  allowed('gh api repos/o/r/pulls/12');
  allowed('gh api -X GET repos/o/r/pulls/12/merge');
});

test('text that only mentions the commands is not a command', () => {
  allowed('echo "never run gh pr merge"');
  allowed("git commit -m 'docs: explain why gh pr merge is blocked'");
  allowed('grep -rn "gh pr create" docs/');
  allowed(`cat > notes.md <<'EOF'\ngh pr merge 1\ngh pr create --fill\nEOF`);
  allowed('gh pr view 280 --json isDraft');
  allowed('gh pr list --state open');
});

test('merging a base branch into a feature branch is blocked unless explicitly allowed', () => {
  blocked('git merge origin/development', { cwd: FEATURE });
  blocked('git merge --no-edit origin/prod', { cwd: FEATURE });
  blocked('git -c core.editor=true merge main', { cwd: FEATURE });
  blocked('git pull origin production', { cwd: FEATURE });
  allowed('ALLOW_BASE_MERGE=1 git merge origin/development', { cwd: FEATURE });
});

test('ordinary merges and syncing a base branch with itself are allowed', () => {
  allowed('git merge feature/other', { cwd: FEATURE });
  allowed('git merge --abort', { cwd: FEATURE });
  allowed('git pull', { cwd: FEATURE });
  allowed('git merge --ff-only origin/main', { cwd: MAIN });
  allowed('git pull origin main', { cwd: MAIN });
});

test('git -C <dir> decides the current branch from that directory', () => {
  blocked(`git -C ${FEATURE} merge origin/main`, { cwd: MAIN });
  allowed(`git -C ${MAIN} merge origin/main`, { cwd: FEATURE });
});

test('the list of base branches is configurable', () => {
  allowed('git merge origin/trunk', { cwd: FEATURE });
  blocked('git merge origin/trunk', { cwd: FEATURE, env: { PR_DRAFT_GUARD_BASES: 'trunk' } });
});

test('non-Bash tools and malformed input are ignored', () => {
  assert.equal(run('gh pr merge 1', { tool: 'Read' }).code, 0);
  const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});
