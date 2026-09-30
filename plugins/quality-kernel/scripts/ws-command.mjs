// Builds the gate's `verify` command from a STRUCTURED spec chosen by a profiler agent, using only
// the repo's own declared facts (ws-profile) and a fixed vocabulary. The agent never writes a command:
// free text, unknown runners or keys, dangerous environment names, non-plain values and any argument
// outside a short flag list are refused, so no shell metacharacter can reach the built command.
//
//   { runner: 'npm-script', script, env? }          -> [ENV=v ...] npm test | npm run <script>
//   { runner: 'npx', bin, args?, env? }             -> [ENV=v ...] npx --no <bin> [args]   (never installs)
//   { runner: 'make', target, env? }                -> [ENV=v ...] make <target>
//   { runner: 'compose', file, service, env? }      -> [ENV=v ...] docker compose -f <file> run --rm <service>
//
// `script` must be a declared npm test script, `bin` a binary one of them runs, `target` a declared
// make test target, `file` a committed compose file. What those run is the repo's own code — the
// documented execution-trust limit — but the agent can no longer choose it.

const RUNNER_KEYS = {
  'npm-script': ['script'], npx: ['bin', 'args'], make: ['target'], compose: ['file', 'service'],
};
const ALLOWED_ARGS = new Set(['test', '--watchAll=false', '--ci', '--runInBand', '--passWithNoTests', '--forceExit', '--exit', '--silent', '--verbose', '--no-cache']);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_VALUE = /^[A-Za-z0-9._-]{1,64}$/;
const ENV_DENY = new Set(['PATH', 'ENV', 'SHELL', 'HOME', 'IFS', 'PS4', 'PROMPT_COMMAND', 'CDPATH', 'TMPDIR', 'PERL5OPT', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH']);
const ENV_DENY_PREFIX = ['LD_', 'DYLD_', 'GIT_', 'NPM_', 'PYTHON', 'BASH_', 'ZDOTDIR', 'SSH_', 'DOCKER_', 'COMPOSE_'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;           // npm script / make target / compose service
const BIN = /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,63}$/i;  // an npm binary name
const FILE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function envPrefix(env) {
  if (env === undefined) return { text: '' };
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { error: 'env must be an object of NAME: value' };
  const pairs = Object.entries(env);
  if (pairs.length > 8) return { error: 'env: at most 8 variables' };
  for (const [k, v] of pairs) {
    if (!ENV_NAME.test(k) || ENV_DENY.has(k) || ENV_DENY_PREFIX.some((p) => k.startsWith(p)) || (k.startsWith('NODE_') && k !== 'NODE_ENV')) return { error: `env name "${k}" is not allowed` };
    if (typeof v !== 'string' || !ENV_VALUE.test(v)) return { error: `env value of ${k} must match [A-Za-z0-9._-]{1,64}` };
  }
  return { text: pairs.map(([k, v]) => `${k}=${v} `).join('') };
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
    const tokens = Object.values(npm).flatMap((v) => String(v).split(/\s+/));
    if (!tokens.includes(spec.bin)) return { error: `no declared npm test script runs "${spec.bin}"` };
    const args = spec.args === undefined ? [] : spec.args;
    if (!Array.isArray(args) || args.length > 6 || args.some((a) => typeof a !== 'string' || !ALLOWED_ARGS.has(a))) return { error: `npx args must come from: ${[...ALLOWED_ARGS].join(' ')}` };
    return { command: `${env.text}npx --no ${spec.bin}${args.length ? ` ${args.join(' ')}` : ''}` };
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
