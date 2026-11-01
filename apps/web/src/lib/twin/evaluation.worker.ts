/**
 * Entry point of the twin evaluation worker (Phase 6.1). Built by scripts/build-twin-worker.mjs
 * into public/workers/twin-evaluation.js, because Turbopack (Next 16.3) does not bundle
 * `new Worker(new URL(...))` targets. Runs trajectories only: it cannot reach the live simulation,
 * the API or any credential.
 */
import { createJobHandler } from "./worker-core";
import type { FromWorker } from "./worker-protocol";

interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const handle = createJobHandler((message) => scope.postMessage(message));
scope.onmessage = (event) => void handle(event.data);
scope.postMessage({ type: "ready" });
