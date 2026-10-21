/** Minimal `--name value` / `--flag` parsing for the recorder CLIs. */
export function args(argv = process.argv.slice(2)): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(key.slice(2), next);
      i++;
    } else out.set(key.slice(2), "true");
  }
  return out;
}

export function required(a: Map<string, string>, name: string): string {
  const v = a.get(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}
