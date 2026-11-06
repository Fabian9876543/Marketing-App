import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native Module laufen nur im Node-Prozess, nicht im Bundle.
  serverExternalPackages: ["better-sqlite3", "@napi-rs/keyring"],
  poweredByHeader: false,
};

export default nextConfig;
