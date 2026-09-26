import type { NextConfig } from "next";

const config: NextConfig = {
  // Fail the build on type errors instead of shipping them.
  typescript: { ignoreBuildErrors: false },
};

export default config;
