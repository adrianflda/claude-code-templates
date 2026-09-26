/**
 * Motion primitives.
 *
 * Two hard rules are encoded here, because both are expensive to retrofit:
 *
 *  1. SEO/AEO safety. A reveal animation may only animate `opacity` and
 *     `transform` on nodes that are ALREADY in the server-rendered HTML.
 *     Mounting content on scroll hides it from GPTBot/ClaudeBot/PerplexityBot,
 *     which fetch raw HTML and never execute JavaScript. `revealOnScroll`
 *     therefore animates in place and never gates rendering.
 *
 *  2. Determinism. Durations and easings come from the same source as the CSS
 *     tokens, so freezing motion for a screenshot is one switch, not a hunt.
 */

/** Easing curves, mirroring `--kit-ease-*` in tokens.css. */
export const ease = {
  /** Leaves fast, lands soft. The default for UI transitions. */
  glide: [0.32, 0.72, 0, 1],
  /** Long deceleration. Entrances and hero reveals. */
  expo: [0.16, 1, 0.3, 1],
  /** Emphasized and mechanical. State changes. */
  snap: [0.2, 0, 0, 1],
  /** Overshoot. Direct manipulation only — never for entrances. */
  spring: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Durations in seconds, mirroring `--kit-dur-*` in tokens.css. */
export const duration = {
  instant: 0.08,
  fast: 0.16,
  base: 0.24,
  slow: 0.42,
  cinematic: 0.9,
} as const;

export type EaseName = keyof typeof ease;
export type DurationName = keyof typeof duration;

/** True when the viewer asked for reduced motion, or motion is frozen for tests. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true; // SSR renders the settled state
  if (document.documentElement.dataset["motion"] === "frozen") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Transition {
  duration: number;
  ease: readonly [number, number, number, number];
  delay?: number;
}

/** Build a transition from named tokens, collapsing to 0s under reduced motion. */
export function transition(
  name: DurationName = "base",
  curve: EaseName = "glide",
  delay = 0,
): Transition {
  const reduced = prefersReducedMotion();
  return {
    duration: reduced ? 0 : duration[name],
    ease: ease[curve],
    delay: reduced ? 0 : delay,
  };
}

/** Shaped for `motion`'s `variants` prop; the index signature is what it requires. */
interface RevealVariants {
  [state: string]: {
    opacity: number;
    y: number;
    filter: string;
    transition?: Transition;
  };
}

/**
 * Variants for a scroll reveal. The element is always present in the DOM; only
 * its opacity, offset and blur change, so crawlers and screen readers see the
 * full content regardless of whether the animation ever runs.
 */
export function revealOnScroll(distance = 24, delay = 0): RevealVariants {
  const reduced = prefersReducedMotion();
  return {
    hidden: {
      opacity: reduced ? 1 : 0,
      y: reduced ? 0 : distance,
      filter: reduced ? "blur(0px)" : "blur(6px)",
    },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: transition("slow", "expo", delay),
    },
  };
}

/** Stagger helper for lists. Returns a delay in seconds for index `i`. */
export function stagger(i: number, step = 0.06, max = 0.36): number {
  if (prefersReducedMotion()) return 0;
  return Math.min(i * step, max);
}
