# Decision Log

Short architecture decision records. Status: **Accepted** unless noted. Newest at the bottom.

---

### DEC-001 — Monorepo with pnpm workspaces + a separate uv-managed Python project
**Context:** TypeScript (web, simulation, contracts) and Python (API, later data pipelines) must
share contracts and live in one repo. **Decision:** pnpm workspaces for TS packages (`apps/*`,
`packages/*`) with recursive scripts. `apps/api` is a standalone uv project with its own lockfile.
No Turborepo or Nx yet. **Consequences:** simple tooling with a fast install. Build caching is
revisited if CI time exceeds ~10 minutes.

### DEC-002 — Simulation is the operational source of truth and runs as pure TypeScript
**Decision:** `step(config, state, commands)` is pure and deterministic. The runner is the only
imperative shell, and renderers receive deep-frozen state. **Why:** replay, snapshot verification,
testability, and running the same engine in the browser, in Node (benchmarks, fixture generation)
and later in a worker or server. **Consequences:** every system must be written without ambient
time or randomness (enforced by lint).

### DEC-003 — Integer fixed tick (100 ms) and integer quantities
**Why:** floating-point time accumulation and fractional stock make determinism and reconciliation
fragile. **Consequences:** sub-tick motion in Phase 2 is interpolated in the renderer only.

### DEC-004 — Deterministic event IDs (UUID v8 from `simulation_id` + `sequence`)
**Alternatives:** random UUID v4/v7. **Why:** replays and redeliveries produce identical IDs, so
downstream deduplication by `event_id` is correct across replays. **Trade-off:** IDs encode no
wall-clock time, so ingestion time is a separate column.

### DEC-005 — Contracts authored in Zod, published as JSON Schema, mirrored in Pydantic
**Alternatives:** JSON Schema as the hand-written source, with code generated for both languages;
Protobuf/Avro now. **Why:** Zod gives the strongest TS ergonomics where most producers live. JSON
Schema is language-neutral for Python and the pipeline. Drift is caught by tests on both sides.
**Revisit:** Phase 3 may adopt a schema registry (Avro/JSON Schema) for Kafka. The committed
JSON Schemas are designed to seed it.

### DEC-006 — Event `occurred_at` is simulated business time; wall-clock is added downstream
**Why:** keeps the engine deterministic and makes analytical time meaningful (a simulated shift).
Ingestion and processing timestamps are added by the publisher and consumers for freshness metrics.

### DEC-007 — Create directories only when they hold real code
**Context:** the master brief proposes `packages/graphics`, `packages/ui`, `data/dbt`,
`infrastructure/` and others. **Decision:** they are created in the phase that fills them. Phase 0
deviations: the compose file lives at the repo root (one file, conventional location), and API
integration tests live in `apps/api/tests/integration`.

### DEC-008 — Tooling versions: TypeScript 6.0 and ESLint 9 (not the newest majors)
**Context (2026-10):** TypeScript 7.0 (native compiler) drops the classic compiler API, and
`typescript-eslint` 8.71 supports `<6.1`. `eslint-plugin-react` (via `eslint-config-next`) does not
support ESLint 10. **Decision:** pin TypeScript 6.0.3 and ESLint 9.39.5. Revisit when
typescript-eslint supports TS 7. All dependency pins were at least two weeks old at selection time.

### DEC-009 — Next.js app consumes workspace packages as TypeScript source
`transpilePackages` compiles `@warehouse-one/contracts` and `@warehouse-one/simulation` directly,
so there is no package build step and no stale `dist`. If the packages are ever published they get
a real build.

### DEC-010 — Phase 0 Docker stack is PostgreSQL + API only
**Why:** the brief requires introducing infrastructure when its responsibilities are real. The dev
machine also has a ~4 GB Docker memory budget. Kafka (KRaft), MinIO and Airflow arrive in Phase 3
with their consumers and tests.

### DEC-011 — State management: Zustand as a read-only projection
The store holds the runner privately and exposes a projection (tick, inventory reference, recent
events, hash) plus actions. Components subscribe with selectors. The fixed-step loop is driven by
its own `requestAnimationFrame`, independent of R3F's render loop.

### DEC-012 — Synthetic workload lives inside the engine as an optional system
It reuses command handlers, so invariants still hold, and is driven by the in-state RNG, so it is
deterministic and snapshot-safe. It is labelled as synthetic and disabled when the config omits it.
Phase 2 replaces it with real inbound/outbound processes.

### DEC-013 — `httpx2` for FastAPI's TestClient
Starlette 1.9 deprecates `httpx` in its TestClient in favour of `httpx2` (maintained by the
Pydantic organisation). It is used in tests only.
