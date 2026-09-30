import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findPushTargets, splitCommands } from '../scripts/push-target.mjs';

const BASE = '/work/session';
const dirs = (command) => findPushTargets(command, BASE).map((t) => t.dir);
const here = (dir = BASE) => [{ dir, known: true, skip: false }];

test('a plain push runs in the session directory', () => {
  assert.deepEqual(findPushTargets('git push', BASE), here());
  assert.deepEqual(dirs('git push -u origin feature 2>&1 | tail -5'), [BASE]);
});

test('cd before the push moves the target', () => {
  assert.deepEqual(dirs('cd /repos/other && git push'), ['/repos/other']);
  assert.deepEqual(dirs('cd ../sibling && git status && git push origin main'), ['/work/sibling']);
  assert.deepEqual(dirs('cd "/repos/with space" && git push'), ['/repos/with space']);
});

test('successive cd commands accumulate', () => {
  assert.deepEqual(dirs('cd /repos && cd app; git push'), ['/repos/app']);
});

test('cd ~ and bare cd go to the home directory', () => {
  assert.deepEqual(dirs('cd ~/code/app && git push'), [join(homedir(), 'code/app')]);
  assert.deepEqual(dirs('cd && git push'), [homedir()]);
});

test('flags of cd are not mistaken for its target', () => {
  assert.deepEqual(dirs('cd -P /repos/a && git push'), ['/repos/a']);
});

test('git -C sets the target for that push only', () => {
  assert.deepEqual(dirs('git -C /repos/a push && git push'), ['/repos/a', BASE]);
  assert.deepEqual(dirs('cd /repos && git -C b push'), ['/repos/b']);
});

test('other git global options are skipped, not mistaken for the verb', () => {
  assert.deepEqual(dirs('git -c user.name=x --no-pager push'), [BASE]);
});

test('several pushes in one command are all reported', () => {
  assert.deepEqual(dirs('cd /a && git push; cd /b && git push'), ['/a', '/b']);
});

test('a directory that depends on the shell is reported as unknown', () => {
  for (const command of ['cd $REPO && git push', 'cd "$(pwd)/x" && git push', 'cd - && git push', 'git -C $REPO push']) {
    const targets = findPushTargets(command, BASE);
    assert.equal(targets.length, 1, command);
    assert.equal(targets[0].known, false, command);
  }
});

test('a push whose repository is set some other way is reported as unknown', () => {
  for (const command of [
    'git --git-dir /r/.git push',
    'git --git-dir=/r/.git push',
    'git --work-tree /r push',
    'GIT_DIR=/r/.git git push',
    'ls | xargs -I{} git -C {} push',
    'find . -maxdepth 1 -exec git -C {} push ;',
    'pushd /a && popd && git push',
  ]) {
    const targets = findPushTargets(command, BASE);
    assert.equal(targets.length, 1, command);
    assert.equal(targets[0].known, false, command);
  }
});

test('a single-quoted path is literal, so it is known', () => {
  assert.deepEqual(findPushTargets("cd '/repos/$literal' && git push", BASE), here('/repos/$literal'));
});

test('text that mentions a push is not a push', () => {
  const message = ['git', 'commit', '-m'].join(' ');
  for (const command of [
    `${message} "push the fix"`,
    `${message} "fix: a; git push"`,
    `${message} "fix: a && git push origin main"`,
    'echo "git push"',
    "echo 'x' && printf 'git push'",
    'git log --oneline',
    'git stash push',
    'npm run push',
    '',
  ]) {
    assert.deepEqual(findPushTargets(command, BASE), [], command);
  }
});

test('separators and redirections inside or next to quotes do not split a command', () => {
  assert.deepEqual(splitCommands('printf "a; b && c | d" && git push 2>&1 | tail -3'), [
    'printf "a; b && c | d"',
    'git push 2>&1',
    'tail -3',
  ]);
  assert.deepEqual(dirs('cd "/repos/a&&b" && git push >out.log 2>&1 &'), ['/repos/a&&b']);
});

test('here-document bodies are data, not commands', () => {
  const command = [
    "cd /repos/app && cat > notes.txt <<'EOF'",
    'some notes',
    '',
    'cd /somewhere/else',
    'git push --force',
    'EOF',
    'git log -1 && git push origin feature 2>&1 | tail -3',
  ].join('\n');
  assert.deepEqual(findPushTargets(command, BASE), here('/repos/app'));
});

test('here-document forms: unquoted, tab-stripped, two on one line', () => {
  assert.deepEqual(dirs('cat <<EOF\ngit push\nEOF\ngit -C /r push'), ['/r']);
  assert.deepEqual(dirs('cat <<-"END"\n\tgit push\n\tEND\ngit -C /r push'), ['/r']);
  assert.deepEqual(dirs('cat <<A <<B\ngit push\nA\ngit push\nB\ngit -C /r push'), ['/r']);
});

test('"<<" inside quotes does not start a here-document', () => {
  assert.deepEqual(dirs('echo "use the << operator EOF"\ncd /repos/a && git push'), ['/repos/a']);
});

test('a here-string is not a here-document', () => {
  assert.deepEqual(dirs('cat <<< "x"\ncd /repos/a && git push'), ['/repos/a']);
});

test('a push inside a subshell is found, and its cd does not leak out', () => {
  assert.deepEqual(dirs('(cd /repos/a && git push)'), ['/repos/a']);
  assert.deepEqual(dirs('(cd /repos/a && git push); git push'), ['/repos/a', BASE]);
  assert.deepEqual(dirs('(cd /repos/a && git status) && git push'), [BASE]);
  assert.deepEqual(dirs('((cd /repos/a && git push)); git push'), ['/repos/a', BASE]);
});

test('pushd and a brace group move the target', () => {
  assert.deepEqual(dirs('pushd /repos/a && git push'), ['/repos/a']);
  assert.deepEqual(dirs('{ cd /repos/a && git push; }'), ['/repos/a']);
});

test('an environment prefix does not hide a push', () => {
  assert.deepEqual(dirs('GIT_SSH_COMMAND="ssh -i key" git push'), [BASE]);
  assert.deepEqual(dirs('cd /repos/a && FOO=1 BAR=2 git push'), ['/repos/a']);
});

test('wrappers in front of git are seen through', () => {
  for (const command of [
    'env git push',
    'env FOO=1 git push',
    'command git push',
    'sudo git push',
    'nohup git push',
    'time git push',
    '/usr/bin/git push',
    '\\git push',
    '"git" push',
  ]) {
    assert.deepEqual(findPushTargets(command, BASE), here(), command);
  }
});

test('shell keywords in front of git are seen through', () => {
  assert.deepEqual(dirs('if true; then git push; fi'), [BASE]);
  assert.deepEqual(dirs('for r in a b; do git push; done'), [BASE]);
  assert.deepEqual(dirs('cd /repos/a && if test -d .git; then git push; else git push -f; fi'), [
    '/repos/a',
    '/repos/a',
  ]);
  assert.deepEqual(dirs('! git push'), [BASE]);
});

test('separators inside a substitution stay inside it', () => {
  assert.deepEqual(splitCommands('OUT=$(cd /repos/a && git push) && echo "$OUT"'), [
    'OUT=$(cd /repos/a && git push)',
    'echo "$OUT"',
  ]);
  assert.deepEqual(dirs('OUT=$(cd /repos/a && git push) && echo done'), ['/repos/a']);
  assert.deepEqual(dirs('echo `cd /repos/b; git push`'), ['/repos/b']);
  assert.deepEqual(dirs('X=$(echo $(cd /repos/c && git push))'), ['/repos/c']);
  // The `cd` happened inside the substitution, so it does not move what follows.
  assert.deepEqual(dirs('OUT=$(cd /repos/a && git status); git push'), [BASE]);
});

test('GIT_DIR set for the rest of the command makes every later push unknown', () => {
  for (const command of [
    'export GIT_DIR=/other/.git && git push',
    'export GIT_WORK_TREE=/other; git push',
    'declare -x GIT_DIR=/other/.git; git push',
    'GIT_DIR=/other/.git; git push',
    'export GIT_DIR=/other/.git && bash -c "git push"',
  ]) {
    const targets = findPushTargets(command, BASE);
    assert.equal(targets.length, 1, command);
    assert.equal(targets[0].known, false, command);
  }
  assert.deepEqual(findPushTargets('export FOO=1 && git push', BASE), here());
});

test('a push the rules cannot place is reported as unknown, never dropped', () => {
  for (const command of [
    'sudo -u deploy git push',
    'sudo -E git push',
    'env -C /other git push',
    'env -u VAR git push',
    'nice -n 10 git push',
    'timeout 60 git push',
    'timeout -s KILL 5 git push',
    'stdbuf -oL git push',
    'ssh-agent git push',
  ]) {
    const targets = findPushTargets(command, BASE);
    assert.equal(targets.length, 1, command);
    assert.equal(targets[0].known, false, command);
  }
});

test('a push inside a command substitution is found', () => {
  assert.deepEqual(dirs('echo "$(git push 2>&1)"'), [BASE]);
  assert.deepEqual(dirs('cd /repos/a && OUT=`git push` && echo done'), ['/repos/a']);
  assert.deepEqual(dirs("echo '$(git push)'"), [], 'single quotes: no substitution');
});

test('a script fed to a shell through a here-document or a here-string is read', () => {
  assert.deepEqual(dirs('bash <<EOF\ncd /repos/a\ngit push\nEOF'), ['/repos/a']);
  assert.deepEqual(dirs("cd /repos/b && sh <<< 'git push'"), ['/repos/b']);
  assert.deepEqual(dirs('cat <<EOF\ngit push\nEOF'), [], 'the same body given to cat is data');
});

test('a script given to a shell or to eval is read too', () => {
  assert.deepEqual(dirs("bash -c 'cd /repos/a && git push'"), ['/repos/a']);
  assert.deepEqual(dirs('cd /repos && sh -c "git -C b push"'), ['/repos/b']);
  assert.deepEqual(dirs("bash -lc 'git push'; git push"), [BASE, BASE]);
  assert.deepEqual(dirs("eval 'git push'"), [BASE]);
  assert.equal(findPushTargets('bash -c "cd $DIR && git push"', BASE)[0].known, false);
  assert.equal(findPushTargets("eval 'cd /x' && git push", BASE)[0].known, false);
});

test('only the documented switch, set to 1 on the push itself, marks it as skipped', () => {
  const skip = (command) => findPushTargets(command, BASE).map((t) => t.skip);
  assert.deepEqual(skip('PREPUSH_REVIEW_SKIP=1 git push'), [true]);
  assert.deepEqual(skip('AI_REVIEW_SKIP=1 git push'), [true]);
  assert.deepEqual(skip('PREPUSH_REVIEW_SKIP=0 git push'), [false]);
  assert.deepEqual(skip('PREPUSH_REVIEW_SKIP=1 git status && git push'), [false]);
});
