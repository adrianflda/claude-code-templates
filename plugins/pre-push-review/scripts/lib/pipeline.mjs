// The review pipeline:
//
//   scope → deterministic tools + summary → reviewers → verification → result
//
// Each stage reports what it did and what it could not do. The result never claims more than
// what ran: a failed reviewer, a failed verifier batch or a tool that timed out all surface in
// the result, and a partial review does not advance the incremental-review pointer.

import { resolveClaudeBin, runAgent, runPool } from './agent.mjs';
import { assignIds, countBySeverity, dedupe, isBlocking, normalizeFinding, rank } from './findings.mjs';
import { collectGuidelines, relevantPathInstructions } from './guidelines.mjs';
import { loadLearnings, recordUsage, relevantLearnings } from './learnings.mjs';
import { buildReviewerPrompt, FINDINGS_SCHEMA, planDiff, renderContext, renderDiff, selectRoles, writePatches } from './reviewers.mjs';
import { summarize } from './summary.mjs';
import { runTools } from './tools.mjs';
import { verifyFindings } from './verify.mjs';

export const VERSION = '2.0.0';

function toolSummary(t) {
  return {
    name: t.name,
    status: t.status,
    findings: t.findings.length,
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.outsideChange ? { outsideChange: t.outsideChange } : {}),
    ...(t.required ? { required: true } : {}),
    ...(t.outputTail ? { outputTail: t.outputTail } : {}),
    ...(t.durationMs != null ? { durationMs: t.durationMs } : {}),
  };
}

/**
 * Run a review over a resolved scope.
 * @param {object} p
 *   scope    from resolveScope()
 *   config   effective configuration
 *   options  { verify, summary, tools, repoCommands } — per-run switches
 *   env      environment (injectable for tests)
 *   log      progress callback (message) => void
 */
export async function runReview({ scope, config, options = {}, env = process.env, log = () => {} }) {
  const started = Date.now();
  const opts = { verify: config.verify, summary: config.summary, tools: true, repoCommands: true, ...options };
  const bin = resolveClaudeBin(env);
  const byPath = new Map(scope.files.map((f) => [f.path, f]));
  const changedPaths = scope.files.map((f) => f.path);
  const dropped = [];
  let costUsd = 0;

  // Guidance, learnings and path instructions come from the developer's own checkout
  // (scope.root), never from code fetched from a pull request: a change under review must not
  // be able to rewrite the instructions it is reviewed against.
  const guidelines = collectGuidelines(scope.root, changedPaths, config.guidelineChars);
  const pathInstructions = relevantPathInstructions(config.pathInstructions, changedPaths);
  const learnings = relevantLearnings(loadLearnings(scope.root, env), changedPaths);

  // --- stage 1: deterministic tools and the change summary ------------------------------------
  log(`Running deterministic tools${opts.summary ? ' and summary' : ''}...`);
  const [toolResults, summaryResult] = await Promise.all([
    opts.tools ? runTools({ scope, config, byPath, allowRepoCommands: opts.repoCommands }) : Promise.resolve([]),
    opts.summary ? summarize({ scope, config, bin, env }) : Promise.resolve(null),
  ]);
  if (summaryResult) costUsd += summaryResult.costUsd ?? 0;

  const toolFindings = [];
  for (const t of toolResults) {
    for (const raw of t.findings) {
      const n = normalizeFinding(raw, { kind: 'tool', name: t.name, category: t.name }, byPath);
      if (n.finding) toolFindings.push(n.finding);
    }
  }

  // --- stage 2: reviewers -----------------------------------------------------------------------
  const roles = selectRoles(config);
  const plan = planDiff(scope.files, config.inlineDiffLines);
  const patches = writePatches(plan.deferred);
  const addDirs = patches.dir ? [patches.dir] : [];
  const context = renderContext({ scope, guidelines, pathInstructions, learnings, toolFindings });
  const diff = renderDiff({ plan, patches });

  let reviewerFindings = [];
  let reviewers = [];
  let verification;
  try {
    log(`Reviewing with ${roles.length} agent(s) [model=${config.models.reviewer}]...`);
    const prompt = buildReviewerPrompt({ context, diff });
    const runs = await runPool(roles, config.concurrency, (role) =>
      runAgent({
        bin,
        model: config.models.reviewer,
        systemPrompt: role.system,
        prompt,
        schema: FINDINGS_SCHEMA,
        cwd: scope.reviewRoot,
        addDirs,
        timeoutMs: config.timeoutMs,
        maxBudgetUsd: config.maxBudgetUsd,
        env,
      }),
    );

    reviewers = runs.map((res, i) => {
      const role = roles[i];
      costUsd += res.costUsd ?? 0;
      if (!res.ok) return { role: role.key, title: role.title, ok: false, error: res.error, findings: 0, costUsd: res.costUsd ?? 0, durationMs: res.durationMs };

      let kept = 0;
      for (const raw of Array.isArray(res.output.findings) ? res.output.findings : []) {
        const n = normalizeFinding(raw, { kind: 'reviewer', name: role.title, category: role.key }, byPath);
        if (n.rejected) {
          dropped.push({ title: String(raw?.title ?? raw?.issue ?? '').slice(0, 160), file: raw?.file ?? null, reportedBy: [role.title], droppedReason: 'invalid', detail: n.rejected });
        } else if (!n.finding.inDiff) {
          dropped.push({ ...n.finding, droppedReason: 'outside the change', detail: 'the file is not part of the reviewed change' });
        } else {
          reviewerFindings.push(n.finding);
          kept += 1;
        }
      }
      return {
        role: role.key,
        title: role.title,
        ok: true,
        findings: kept,
        summary: typeof res.output.summary === 'string' ? res.output.summary.trim() : '',
        costUsd: res.costUsd ?? 0,
        turns: res.turns,
        denials: res.denials,
        durationMs: res.durationMs,
      };
    });

    // Ids are assigned once, over tool and reviewer findings together, so an id means the same
    // finding in the report, in the verifier's verdicts and in `learn --reject`.
    const merged = assignIds([...dedupe(toolFindings), ...dedupe(reviewerFindings)]);
    const fromTools = merged.filter((f) => f.source === 'tool');
    reviewerFindings = merged.filter((f) => f.source === 'reviewer');

    // --- stage 3: verification ------------------------------------------------------------------
    if (reviewerFindings.length === 0) {
      verification = { ran: false, ok: true, skipped: null, confirmed: 0, refuted: 0, unverifiable: 0, unverified: 0, failedBatches: 0, batches: 0, costUsd: 0 };
    } else if (!opts.verify) {
      verification = { ran: false, ok: true, skipped: 'disabled for this run', confirmed: 0, refuted: 0, unverifiable: 0, unverified: reviewerFindings.length, failedBatches: 0, batches: 0, costUsd: 0 };
    } else {
      log(`Verifying ${reviewerFindings.length} finding(s) [model=${config.models.verifier}]...`);
      const v = await verifyFindings({ findings: reviewerFindings, context, diff, addDirs, config, bin, cwd: scope.reviewRoot, learnings, env });
      costUsd += v.costUsd;
      reviewerFindings = v.findings;
      const count = (verdict) => reviewerFindings.filter((f) => f.verdict === verdict).length;
      verification = {
        ran: true,
        ok: v.ok,
        skipped: null,
        confirmed: count('confirmed'),
        refuted: count('refuted'),
        unverifiable: count('unverifiable'),
        unverified: count('unverified'),
        failedBatches: v.failedBatches,
        batches: v.batches,
        costUsd: v.costUsd,
        durationMs: v.durationMs,
      };
      recordUsage(reviewerFindings.map((f) => f.verification?.learningId).filter(Boolean), env);
    }

    for (const f of reviewerFindings) {
      if (f.verdict === 'refuted') dropped.push({ ...f, droppedReason: 'refuted', detail: f.verification?.reason ?? '' });
    }
    const findings = rank([...fromTools, ...reviewerFindings.filter((f) => f.verdict !== 'refuted')]);

    const blocking = findings.filter((f) => isBlocking(f, config.blockOn)).map((f) => f.id);
    for (const t of toolResults) {
      if (t.required && t.status === 'failed') blocking.push(`check:${t.name}`);
    }

    const allReviewersFailed = reviewers.length > 0 && reviewers.every((r) => !r.ok);
    return {
      version: VERSION,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      scope,
      config: { profile: config.profile, models: config.models, blockOn: config.blockOn },
      context: { guidelines: guidelines.map((g) => g.path), pathInstructions: pathInstructions.length, learnings: learnings.map((l) => l.id), deferredFiles: plan.deferred.length },
      summary: summaryResult?.ok ? summaryResult.summary : null,
      summaryError: summaryResult && !summaryResult.ok ? summaryResult.error : null,
      tools: toolResults.map(toolSummary),
      reviewers,
      verification,
      findings,
      dropped,
      counts: countBySeverity(findings),
      blocking,
      allReviewersFailed,
      costUsd,
    };
  } finally {
    patches.cleanup();
  }
}

/** True when every stage that should have run did; only then may incremental state advance. */
export function isComplete(result) {
  return (
    result.reviewers.every((r) => r.ok) &&
    result.verification.ok &&
    result.tools.every((t) => t.status !== 'error' && t.status !== 'timeout')
  );
}
