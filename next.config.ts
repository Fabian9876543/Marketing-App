import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native Module laufen nur im Node-Prozess, nicht im Bundle.
  serverExternalPackages: ["better-sqlite3", "@napi-rs/keyring"],
  poweredByHeader: false,
  experimental: {
    // Next.js weist nur auf Sicherheits-Updates hin (nicht auf jede neue Version).
    agentUpgrade: "security",
  },
};

export default nextConfig;
