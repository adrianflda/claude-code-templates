// Builds the gate's `verify` command from a STRUCTURED spec chosen by a profiler agent, using only
// the repo's own declared facts (ws-profile) and a fixed vocabulary. The agent never writes a command:
// free text, unknown runners or keys, dangerous environment names, non-plain values and any argument
// outside a short flag list are refused, so no shell metacharacter can reach the built command.
//
//   { runner: 'npm-script', script, env? }          -> [ENV=v ...] npm test | npm run <script>
//   { runner: 'npx', bin, args?, env? }             -> [ENV=v ...] npx --no -- <bin> [args]   (never installs)
//   { runner: 'make', target, env? }                -> [ENV=v ...] make <target>
//   { runner: 'compose', file, service, env? }      -> [ENV=v ...] docker compose -f <file> run --rm <service>
//
// `script` must be a declared npm test script, `bin` the binary at the COMMAND POSITION of one of
// them (after `VAR=` and `cross-env`/`env` prefixes; wrappers and shell builtins such as `node`,
// `sh`, `true`, `echo` are refused), `target` a declared make test target, `file` a committed
// compose file. `--` keeps npm from swallowing the args.
// `env` is a FIXED list of name/value pairs: CI=true|1, NODE_ENV=test, TZ=UTC. Nothing else, because
// any other name the agent could set can skip tests (SKIP_DB_TESTS=1), select a production
// configuration (STAGE=production, DJANGO_SETTINGS_MODULE=...) or redirect traffic (HTTPS_PROXY,
// PGHOST) — and the suite runs with the user's credentials. A variable a suite really needs (e.g. a
// dummy JWT_SECRET read at import) is added BY A HUMAN to the proposed tools.json before approval;
// the profile's `envRefs` lists the names the code reads so the agent can point at them in its notes.
// What those commands run is the repo's own code — the documented execution-trust limit. The RED
// canary at verify time shows the command exits non-zero when its test files are broken (not that it
// executes them: a lint command that parses them passes too — CHANGELOG open gap G1); it cannot
// show which tests execute (a repo script that skips or only collects tests passes it) — that is
// left to the human who approves the command.

const RUNNER_KEYS = {
  'npm-script': ['script'], npx: ['bin', 'args'], make: ['target'], compose: ['file', 'service'],
};
const ALLOWED_ARGS = new Set(['test', '--watchAll=false', '--ci', '--runInBand', '--passWithNoTests', '--forceExit', '--exit', '--silent', '--verbose', '--no-cache']);
// The only env an agent-chosen spec may set: name -> allowed values.
const ENV_ALLOWED = { CI: ['true', '1'], NODE_ENV: ['test'], TZ: ['UTC'] };
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
// Never a test binary: interpreters, shells, env wrappers, package managers and no-op builtins.
const WRAPPERS = new Set(['cross-env', 'env', 'node', 'nodejs', 'deno', 'bun', 'sh', 'bash', 'zsh', 'dash', 'fish', 'true', 'false', 'echo', 'printf', 'exit', 'test', 'command', 'exec', 'time', 'nohup', 'sudo', 'xargs', 'npm', 'npx', 'yarn', 'pnpm', 'run-s', 'run-p', 'npm-run-all', 'concurrently']);

// The binary at the command position of each simple command of a script, e.g.
// `cross-env NODE_ENV=test mocha x && eslint . || true` -> ['mocha', 'eslint', 'true'].
export function commandHeads(script) {
  return String(script).split(/&&|\|\||[;|&\n]/).map((seg) => {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < t.length && ASSIGN.test(t[i])) i++;
    while (t[i] === 'cross-env' || t[i] === 'env') { i++; while (i < t.length && (ASSIGN.test(t[i]) || t[i].startsWith('-'))) i++; }
    return t[i];
  }).filter(Boolean);
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;           // npm script / make target / compose service
const BIN = /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,63}$/i;  // an npm binary name
const FILE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function envPrefix(env) {
  if (env === undefined) return { text: '' };
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { error: 'env must be an object of NAME: value' };
  const allowed = Object.entries(ENV_ALLOWED).map(([k, vs]) => `${k}=${vs.join('|')}`).join(', ');
  for (const [k, v] of Object.entries(env)) {
    if (!own(ENV_ALLOWED, k)) return { error: `env name "${k}" is not allowed: an agent may only set ${allowed} (a variable the suite really needs is added by a human to the proposed tools.json)` };
    if (!ENV_ALLOWED[k].includes(v)) return { error: `env value of ${k} must be one of ${ENV_ALLOWED[k].join(', ')}` };
  }
  return { text: Object.entries(env).map(([k, v]) => `${k}=${v} `).join('') };
}

export function buildVerify(spec, facts) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'verify must be an object { runner, ... } (free-text commands are not accepted)' };
  const keys = RUNNER_KEYS[spec.runner];
  if (!keys) return { error: `verify runner must be one of ${Object.keys(RUNNER_KEYS).join(', ')}` };
  for (const k of Object.keys(spec)) if (k !== 'runner' && k !== 'env' && !keys.includes(k)) return { error: `verify: unknown key "${k}" for runner ${spec.runner}${k === 'args' ? ' (args are only allowed for npx)' : ''}` };
  if (!facts || !facts.testScripts) return { error: 'no profile facts to build verify from' };
  const npm = facts.testScripts.npm || {};
  const env = envPrefix(spec.env);
  if (env.error) return env;

  if (spec.runner === 'npm-script') {
    if (typeof spec.script !== 'string' || !NAME.test(spec.script) || !own(npm, spec.script)) return { error: `npm script "${spec.script}" is not a declared npm test script` };
    return { command: `${env.text}${spec.script === 'test' ? 'npm test' : `npm run ${spec.script}`}` };
  }
  if (spec.runner === 'npx') {
    if (typeof spec.bin !== 'string' || !BIN.test(spec.bin)) return { error: 'npx bin must be a plain npm binary name' };
    if (WRAPPERS.has(spec.bin)) return { error: `npx bin "${spec.bin}" is a wrapper or builtin, not a test runner` };
    const heads = Object.values(npm).flatMap(commandHeads);
    if (!heads.includes(spec.bin)) return { error: `no declared npm test script runs "${spec.bin}" as its command` };
    const args = spec.args === undefined ? [] : spec.args;
    if (!Array.isArray(args) || args.length > 6 || args.some((a) => typeof a !== 'string' || !ALLOWED_ARGS.has(a))) return { error: `npx args must come from: ${[...ALLOWED_ARGS].join(' ')}` };
    return { command: `${env.text}npx --no -- ${spec.bin}${args.length ? ` ${args.join(' ')}` : ''}` };
  }
  if (spec.runner === 'make') {
    const make = facts.testScripts.make || [];
    if (typeof spec.target !== 'string' || !NAME.test(spec.target) || !make.includes(spec.target)) return { error: `make target "${spec.target}" is not a declared make test target` };
    return { command: `${env.text}make ${spec.target}` };
  }
  // compose
  const compose = (facts.docker && facts.docker.compose) || [];
  if (typeof spec.file !== 'string' || !FILE.test(spec.file) || !compose.includes(spec.file)) return { error: `compose file "${spec.file}" is not a committed compose file` };
  if (typeof spec.service !== 'string' || !NAME.test(spec.service)) return { error: 'compose service must be a plain service name' };
  return { command: `${env.text}docker compose -f ${spec.file} run --rm ${spec.service}` };
}
