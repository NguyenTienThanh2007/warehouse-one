import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";
import { resolveApiUrl } from "./src/lib/api/base-url";

// One API base URL for dev, build and start (precedence in src/lib/api/base-url.ts). The
// repository's .env is read for NEXT_PUBLIC_API_URL and API_PORT only, so `pnpm dev` follows the
// ports Docker Compose uses; nothing else from it reaches the web app.
const repoEnvFile = resolve(process.cwd(), "../../.env");
const repoEnv = existsSync(repoEnvFile) ? parseEnv(readFileSync(repoEnvFile, "utf8")) : {};
const api = resolveApiUrl(process.env, repoEnv);
console.log(`- API: ${api.url} (from ${api.source})`);
for (const w of api.warnings) console.warn(`⚠ ${w}`);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: [
    "@warehouse-one/contracts",
    "@warehouse-one/simulation",
    "@warehouse-one/recorder",
    "@warehouse-one/twin",
  ],
  poweredByHeader: false,
  env: { NEXT_PUBLIC_API_URL: api.url, NEXT_PUBLIC_API_URL_SOURCE: api.source },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
