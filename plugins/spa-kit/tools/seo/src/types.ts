/** A single assertion outcome. `evidence` must quote what was actually observed. */
export interface Check {
  id: string;
  target: string;
  passed: boolean;
  /** What was observed, verbatim where possible. Never a restatement of the rule. */
  evidence: string;
  /** Advisory checks report but do not fail the run. */
  advisory?: boolean;
}

export interface Suite {
  name: string;
  checks: Check[];
}

export function pass(id: string, target: string, evidence: string): Check {
  return { id, target, passed: true, evidence };
}

export function fail(id: string, target: string, evidence: string): Check {
  return { id, target, passed: false, evidence };
}

export function advise(id: string, target: string, passed: boolean, evidence: string): Check {
  return { id, target, passed, evidence, advisory: true };
}
