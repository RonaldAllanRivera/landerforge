import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone — the runner stage copies only that, so the image
  // carries no toolchain and no dev dependencies.
  output: "standalone",
  // playwright-core + sharp are used only inside Inngest steps on the Node runtime.
  // playwright-core is used only inside Inngest steps, on the Node runtime.
  serverExternalPackages: ["playwright-core"],
  typedRoutes: true,
};

export default nextConfig;
