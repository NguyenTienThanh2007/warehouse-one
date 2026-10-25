/**
 * The one API base URL of the web app. next.config.ts resolves it when Next.js starts (dev, build
 * or start) and inlines it into the browser bundle as NEXT_PUBLIC_API_URL, so a production build
 * keeps the URL it was built with. Precedence, first match wins:
 *
 *   1. NEXT_PUBLIC_API_URL in the environment (shell, or apps/web/.env*)
 *   2. NEXT_PUBLIC_API_URL in the repository's .env (the file Docker Compose reads)
 *   3. http://localhost:<API_PORT>, API_PORT from the environment, then the repository's .env
 *   4. http://localhost:8000, the Compose default for API_PORT
 *
 * Pure; unit-tested.
 */
export type ApiUrlSource = "environment" | "repository .env" | "API_PORT" | "default";

export interface ApiBase {
  url: string;
  source: ApiUrlSource;
  /** Configuration that is valid but probably not what was meant. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const DEFAULT_PORT = "8000";

function parseBase(raw: string, from: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${from} is not a URL: "${raw}". Expected e.g. http://localhost:8000.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`${from} must be an http(s) URL, got "${raw}".`);
  if (u.search || u.hash) throw new Error(`${from} must not have a query or fragment: "${raw}".`);
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

function parsePort(raw: string, from: string): string {
  const port = raw.trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
    throw new Error(`${from} must be a TCP port, got "${raw}".`);
  return port;
}

export function resolveApiUrl(env: Env, repoEnv: Env = {}): ApiBase {
  const pick = (k: string) => (env[k]?.trim() ? env[k] : undefined);
  const fromRepo = (k: string) => (repoEnv[k]?.trim() ? repoEnv[k] : undefined);
  const apiPortRaw = pick("API_PORT") ?? fromRepo("API_PORT");
  const apiPort = apiPortRaw === undefined ? undefined : parsePort(apiPortRaw, "API_PORT");

  let base: Omit<ApiBase, "warnings">;
  const explicit = pick("NEXT_PUBLIC_API_URL");
  const repoExplicit = fromRepo("NEXT_PUBLIC_API_URL");
  if (explicit !== undefined)
    base = { url: parseBase(explicit, "NEXT_PUBLIC_API_URL"), source: "environment" };
  else if (repoExplicit !== undefined)
    base = {
      url: parseBase(repoExplicit, "NEXT_PUBLIC_API_URL in .env"),
      source: "repository .env",
    };
  else if (apiPort !== undefined) base = { url: `http://localhost:${apiPort}`, source: "API_PORT" };
  else base = { url: `http://localhost:${DEFAULT_PORT}`, source: "default" };

  const warnings: string[] = [];
  const u = new URL(base.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (local && apiPort !== undefined && port !== apiPort)
    warnings.push(
      `The API URL ${base.url} (${base.source}) does not use API_PORT=${apiPort}, the host port Docker Compose publishes the API on.`,
    );
  return { ...base, warnings };
}
