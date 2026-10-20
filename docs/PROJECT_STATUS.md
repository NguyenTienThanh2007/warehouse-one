# Project Status

_Last updated: 2026-10-20_

| Item | State |
|------|-------|
| Active phase | **Phase 2: Living warehouse simulation**, in development on `feature/p2-simulation` (base `0463395`) |
| `main` | `0463395`: Phase 0 and Phase 1 merged (PR #1, #2, follow-up #3); CI green (run 39429621800) |
| Last accepted phase | Phase 1, Premium 3D world (`docs/phases/PHASE_1.md`) |

## Phase 1 at merge (verified)

- CI on `main` @ `0463395`: TypeScript, Python + PostgreSQL integration, Docker Compose, Playwright e2e 18/18 (no flaky results)
- Phase 1 checks recorded as not done: live-scene contrast audit (visual checklist 3b), per-bookmark FPS (checklist 5)

## Pending

- Phase 2 implementation and review (`docs/phases/PHASE_2.md`)
- Owner decisions: repository licence, public-demo hosting (Phase 7)

## Known blockers

None. Local dev ports 3000, 8000 and 5432 are occupied on the development machine; documented
overrides are in `docs/DEVELOPMENT.md`.

Details: [Phase 2](phases/PHASE_2.md) · [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
