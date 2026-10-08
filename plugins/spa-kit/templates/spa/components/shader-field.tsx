"use client";

import { useEffect, useState } from "react";
import { MeshGradient } from "@paper-design/shaders-react";
import { prefersReducedMotion } from "@/design";

/**
 * Decorative WebGL backdrop.
 *
 * Three constraints shape this component, and all three are load-bearing:
 *
 *  1. It is decorative. `aria-hidden` and `pointer-events: none` keep it out of
 *     the accessibility tree, and it carries no text, so removing it changes
 *     nothing a crawler or a screen reader can observe.
 *  2. It mounts after hydration. A WebGL context created during the critical
 *     path competes with the first paint; deferring it protects LCP.
 *  3. It honours reduced motion by holding a single frame (`speed={0}`) rather
 *     than disappearing — the composition stays intact, the movement stops.
 *
 * `data-visual-volatile` marks it for masking in visual regression: GPU output
 * is not reproducible pixel for pixel across machines.
 */
export function ShaderField({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    setStill(prefersReducedMotion());

    // Wait for an idle moment rather than the next frame. Creating a GL context
    // and compiling shaders is a long task; running it while the main thread is
    // still busy with hydration shows up directly in the long-task budget.
    // `requestIdleCallback` is not in Safari, hence the timeout fallback.
    const schedule: (cb: () => void) => number =
      typeof window.requestIdleCallback === "function"
        ? (cb) => window.requestIdleCallback(() => cb(), { timeout: 2000 })
        : (cb) => window.setTimeout(cb, 200);

    const cancel: (handle: number) => void =
      typeof window.cancelIdleCallback === "function"
        ? (handle) => window.cancelIdleCallback(handle)
        : (handle) => window.clearTimeout(handle);

    const handle = schedule(() => setMounted(true));
    return () => cancel(handle);
  }, []);

  if (!mounted) return null;

  return (
    <div
      aria-hidden="true"
      data-visual-volatile=""
      className={className}
      style={{ pointerEvents: "none" }}
    >
      <MeshGradient
        colors={["#07090d", "#0d2430", "#1b3a56", "#2ee6d6"]}
        distortion={0.85}
        swirl={0.6}
        grainOverlay={0.12}
        speed={still ? 0 : 0.18}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
