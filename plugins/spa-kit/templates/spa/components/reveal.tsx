"use client";

import { type ReactNode, useRef } from "react";
import { motion, useInView } from "motion/react";
import { revealOnScroll } from "@/design";

/**
 * Scroll reveal that is safe for SEO and for agentic crawlers.
 *
 * The children are rendered unconditionally — this component animates an
 * element that already exists in the server HTML. It never gates mounting on
 * visibility, which would hide the content from crawlers that do not run JS.
 */
export function Reveal({
  children,
  delay = 0,
  distance = 24,
  className,
}: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const variants = revealOnScroll(distance, delay);

  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={inView ? "visible" : "hidden"}
      variants={variants}
    >
      {children}
    </motion.div>
  );
}
