import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Vercel supplies its own traced function output. Forcing Next's standalone
  // self-hosting bundle there makes Vercel's post-build hook look for a trace
  // file that Next 16 does not emit in this build mode. Keep standalone output
  // for the Docker/self-hosted target only.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  turbopack: { root: process.cwd() },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        // Camera remains same-origin only and is requested exclusively after an
        // explicit gesture on /optical-lab. Microphone and geolocation stay off.
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
