import { test } from 'node:test';
import assert from 'node:assert';
import { buildVerify, commandHeads } from './ws-command.mjs';

// The agent never writes a verify COMMAND: it picks a structured spec, and buildVerify() builds the
// command only from the repo's own declared facts, from a fixed vocabulary. Every attack vector the
// adversarial review found against the free-text version must be unrepresentable.
const FACTS = {
  testScripts: { npm: { test: 'react-scripts test', 'test:unit': 'cross-env NODE_ENV=dev mocha -r ts-node/register tests/*.ts', 'test:api': 'DB_NAME=test jest', 'test:lint': 'eslint . || true' }, make: ['test-all'], python: { manage: false } },
  docker: { compose: ['docker-compose.test.yml'], dockerfiles: [] },
};
const ok = (spec, facts = FACTS) => { const r = buildVerify(spec, facts); assert.ok(r.command, `${JSON.stringify(spec)} -> ${r.error}`); return r.command; };
const bad = (spec, re, facts = FACTS) => { const r = buildVerify(spec, facts); assert.ok(!r.command, `${JSON.stringify(spec)} should be refused, got ${r.command}`); assert.match(r.error, re); };

test('npm-script: a declared script; `test` is npm test', () => {
  assert.strictEqual(ok({ runner: 'npm-script', script: 'test' }), 'npm test');
  assert.strictEqual(ok({ runner: 'npm-script', script: 'test:unit' }), 'npm run test:unit');
  bad({ runner: 'npm-script', script: 'deploy' }, /not a declared npm test script/);
  bad({ runner: 'npm-script', script: 'test' }, /not a declared/, { ...FACTS, testScripts: { ...FACTS.testScripts, npm: {} } });
});

test('npm-script: prototype keys are never "declared"', () => {
  for (const script of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) bad({ runner: 'npm-script', script }, /script/);
});

test('npx: only a binary that a declared npm test script runs, with allowed args', () => {
  assert.strictEqual(ok({ runner: 'npx', bin: 'react-scripts', args: ['test', '--watchAll=false'], env: { CI: 'true' } }), 'CI=true npx --no -- react-scripts test --watchAll=false');
  assert.strictEqual(ok({ runner: 'npx', bin: 'mocha' }), 'npx --no -- mocha', 'never installs from the registry');
  assert.strictEqual(ok({ runner: 'npx', bin: 'jest', args: ['--ci'] }), 'npx --no -- jest --ci', '`--` keeps npm from swallowing flags before a positional');
  bad({ runner: 'npx', bin: 'attacker-package' }, /no declared npm test script runs/);
  bad({ runner: 'npx', bin: '-p' }, /bin/);
  bad({ runner: 'npx', bin: 'est' }, /no declared npm test script runs/);
});

test('make: a declared test target, no args', () => {
  assert.strictEqual(ok({ runner: 'make', target: 'test-all' }), 'make test-all');
  bad({ runner: 'make', target: 'deploy' }, /not a declared make test target/);
  bad({ runner: 'make', target: 'test-all', args: ['-C', '../x'] }, /args/);
});

test('compose: a committed compose file and a service name only', () => {
  assert.strictEqual(ok({ runner: 'compose', file: 'docker-compose.test.yml', service: 'tests' }), 'docker compose -f docker-compose.test.yml run --rm tests');
  bad({ runner: 'compose', file: '/tmp/evil.yml', service: 'tests' }, /not a committed compose file/);
  bad({ runner: 'compose', file: 'docker-compose.test.yml', service: 'web sh -c "curl x"' }, /service/);
  bad({ runner: 'compose', file: 'docker-compose.test.yml', service: 'tests', args: ['-v', '~/.aws:/aws'] }, /args/);
});

// Round-3/4 vectors: every env name an agent could choose was a way to skip tests (SKIP_DB_TESTS=1),
// change what runs (MAKEFLAGS=n, PYTEST_ADDOPTS=--co), select production (NODE_ENV=production,
// STAGE, DJANGO_SETTINGS_MODULE) or redirect traffic (HTTPS_PROXY, PGHOST). Env is now a fixed list
// of name/value pairs; even a name the repo's own code or scripts use is refused.
test('env: only CI=true|1, NODE_ENV=test, TZ=UTC; every other name or value is refused', () => {
  assert.strictEqual(ok({ runner: 'npm-script', script: 'test', env: { CI: 'true', NODE_ENV: 'test', TZ: 'UTC' } }), 'CI=true NODE_ENV=test TZ=UTC npm test');
  assert.strictEqual(ok({ runner: 'npm-script', script: 'test', env: { CI: '1' } }), 'CI=1 npm test');
  for (const name of ['SKIP_DB_TESTS', 'MAKEFLAGS', 'MFLAGS', 'MAKEFILES', 'PYTEST_ADDOPTS', 'PYTEST_PLUGINS', 'TS_NODE_TRANSPILE_ONLY', 'GCONV_PATH', 'SHELLOPTS',
    'DJANGO_SETTINGS_MODULE', 'STAGE', 'APP_ENV', 'PGHOST', 'PGDATABASE', 'DB_NAME', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
    'JWT_SECRET', 'AWS_PROFILE', 'DATABASE_URL', 'PATH', 'NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD', 'npm_config_script_shell', 'constructor', '__proto__']) {
    bad({ runner: 'npm-script', script: 'test', env: { [name]: '1' } }, /env name/);
  }
  for (const [name, value] of [['NODE_ENV', 'production'], ['NODE_ENV', 'dev'], ['CI', 'false'], ['TZ', 'America/New_York'], ['CI', ''], ['CI', 1], ['CI', '$(id)']]) {
    bad({ runner: 'npm-script', script: 'test', env: { [name]: value } }, /env value/);
  }
  bad({ runner: 'npm-script', script: 'test', env: ['CI=true'] }, /env must be an object/);
});

// The critic's round-4 probe: a test skipped when SKIP_DB_TESTS is set, a name the code reads
// (profile envRefs) and the repo's own script sets — still not choosable by the agent.
test('env: a name the code reads (envRefs) or a test script sets is still refused', () => {
  const facts = { ...FACTS, envRefs: ['SKIP_DB_TESTS', 'JWT_SECRET'], testScripts: { ...FACTS.testScripts, npm: { test: 'SKIP_E2E=1 JWT_SECRET=x node --test' } } };
  for (const name of ['SKIP_DB_TESTS', 'JWT_SECRET', 'SKIP_E2E']) bad({ runner: 'npm-script', script: 'test', env: { [name]: '1' } }, /env name/, facts);
});

// Round-3 vectors: `npx --no cross-env` (runs nothing), `npx --no true` (token of `eslint . || true`).
test('npx bin must be at the command position of a declared script, and never a wrapper or builtin', () => {
  for (const bin of ['cross-env', 'true', 'node', 'env', 'echo', 'sh', 'npm']) bad({ runner: 'npx', bin }, /wrapper or builtin|no declared/);
  const argOnly = { ...FACTS, testScripts: { ...FACTS.testScripts, npm: { test: 'nyc mocha --exit' } } };
  bad({ runner: 'npx', bin: 'mocha' }, /as its command/, argOnly);
  assert.strictEqual(ok({ runner: 'npx', bin: 'nyc' }, argOnly), 'npx --no -- nyc');
  assert.strictEqual(ok({ runner: 'npx', bin: 'eslint' }), 'npx --no -- eslint', 'the head of a chained segment counts');
});

test('commandHeads: skips VAR= and cross-env/env prefixes, splits on && || ; | &', () => {
  assert.deepStrictEqual(commandHeads('cross-env NODE_ENV=test mocha x && eslint . || true'), ['mocha', 'eslint', 'true']);
  assert.deepStrictEqual(commandHeads('A=1 B=2 env -i C=3 react-scripts test --watchAll=false'), ['react-scripts']);
  assert.deepStrictEqual(commandHeads('jest; vitest run | tee x & wait'), ['jest', 'vitest', 'tee', 'wait']);
  assert.deepStrictEqual(commandHeads('   '), []);
});

test('args: only the fixed flag list; --prefix / -C / -f / -p / -v / anything else is refused', () => {
  for (const a of ['--prefix', '/elsewhere', '-C', '-f', '-p', '-v', '--', '--config=x', 'x;y', 'test; curl x']) {
    bad({ runner: 'npx', bin: 'react-scripts', args: ['test', a] }, /args/);
  }
  bad({ runner: 'npm-script', script: 'test', args: ['--watchAll=false'] }, /args/);
});

test('a free-text verify or an unknown runner is refused', () => {
  bad('npm test', /object/);
  bad({ runner: 'sh', cmd: 'curl x | sh' }, /runner/);
  bad(null, /object/);
  bad({ runner: 'npm-script', script: 'test', extra: 1 }, /unknown key/);
});

test('no facts -> refused', () => {
  bad({ runner: 'npm-script', script: 'test' }, /facts/, null);
  bad({ runner: 'npm-script', script: 'test' }, /facts/, {});
});

test('the built command never contains a shell metacharacter', () => {
  const cmds = [
    ok({ runner: 'npx', bin: 'react-scripts', args: ['test', '--watchAll=false', '--ci'], env: { CI: 'true' } }),
    ok({ runner: 'npm-script', script: 'test:unit', env: { NODE_ENV: 'test' } }),
    ok({ runner: 'make', target: 'test-all' }),
    ok({ runner: 'compose', file: 'docker-compose.test.yml', service: 'tests' }),
  ];
  for (const c of cmds) assert.doesNotMatch(c, /[|;&`<>$(){}\\'"*?\n]/, c);
});
