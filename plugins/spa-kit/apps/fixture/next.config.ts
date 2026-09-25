import type { NextConfig } from "next";

const config: NextConfig = {
  // The design system ships TypeScript source, not a build artifact.
  transpilePackages: ["@kit/design-system"],
  // Fail the build on type errors instead of shipping them. Linting is a
  // separate repo-wide step (`npm run lint`), not part of the build.
  typescript: { ignoreBuildErrors: false },
};

export default config;
