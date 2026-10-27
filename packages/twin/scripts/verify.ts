/**
 * Verify a stored proposal (Phase 6): fetch its evaluation and input snapshot from the API, re-run
 * the evaluation in the engine and compare every figure. The API stores what the browser computed
 * but never simulates; this is how anyone can check that a proposal's numbers are reproducible.
 *
 *   pnpm twin:verify --api http://localhost:8010 --proposal <uuid>
 *
 * Exits 0 when everything matches, 1 on any mismatch.
 */
import { loadSnapshot } from "@warehouse-one/simulation";
import { verifyEvaluation, type Evaluation } from "../src/index";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
};

const api = arg("api").replace(/\/$/, "");
const id = arg("proposal");
const base = `${api}/api/v1/twin/proposals/${id}`;

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const proposal = await get<{ evaluation: Evaluation; status: string }>(base);
// loadSnapshot checks the snapshot's own hash and the engine invariants before anything runs.
const snapshot = loadSnapshot(JSON.stringify(await get<unknown>(`${base}/snapshot`)));
const result = await verifyEvaluation(proposal.evaluation, snapshot);
console.log(JSON.stringify({ proposal: id, status: proposal.status, ...result }));
process.exit(result.ok ? 0 : 1);
