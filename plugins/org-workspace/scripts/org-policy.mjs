// Shared validation primitives for org-workspace's two schemas — guide.json's `validateGuide`
// (org-guide.mjs) and the integration map's `validateIntegrations` (org-map.mjs): one repo-name rule
// and one single-line/control-char/length text rule, so both validators enforce the same standard
// instead of each keeping its own copy (docs/contracts/org-guide-v1.md, "One policy module").
//
// A leaf module on purpose: it imports nothing of its own, so org-guide.mjs and org-map.mjs can both
// import it without creating a cycle between them (org-guide.mjs already imports org-map.mjs, for the
// integration-map rendering).

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isRepoName = (n) => typeof n === 'string' && REPO_NAME.test(n) && n !== '.' && n !== '..';

// C0/C1 controls and bidi overrides (a U+202E can make a rendered path read differently).
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
export const TEXT_MAX_LENGTH = 300;

// A single-line, bounded, control-character-free string — the shape both guide.json's free-text
// fields and the integration map's endpoint/note/reason fields must have before either validator
// runs its own secret check on top.
export const isBoundedSingleLineText = (v, maxLength = TEXT_MAX_LENGTH) =>
  typeof v === 'string' && v.trim() !== '' && v.length <= maxLength && !CONTROL_CHARS.test(v);
