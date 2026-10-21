# Project Status

_Last updated: 2026-10-21_

| Item | State |
|------|-------|
| Active phase | **Phase 3: Real data engineering**, in development on `feature/p3-data-engineering` (base `d2dc4d9`) |
| `main` | `d2dc4d9`: Phases 0, 1 and 2 merged (PR #1, #2, #3, #4); `main` CI run 39536339237: 4/4 jobs green |
| Last merged phase | Phase 2, Living warehouse simulation (`docs/phases/PHASE_2.md`), merged 2026-10-21 |

## Phase 2 at merge (verified)

- PR #4 merged as `d2dc4d9`; the PR's CI run 39534274827 on `6812be4` and `main` CI run
  39536339237 on `d2dc4d9`: TypeScript, Python (with migrations), Docker Compose and Playwright,
  all green.
- Open Phase 2 limitations (from `PHASE_2.md`):
  - workers are deferred;
  - order lead time is not bounded by a test;
  - bench-1000 High tier measured 55 and 60 FPS in two runs.

## Phase 3 progress (branch `feature/p3-data-engineering`)

See `docs/phases/PHASE_3.md` for the milestone record, the test evidence and the limitations. CI
for the branch runs on its pull request; its result is recorded there once known.

## Pending

- Phase 3 review and merge decision (owner)
- Owner decisions: repository licence, public-demo hosting (Phase 7)

## Known blockers

None. Ports 3000 and 8000 are used by other projects on the development machine; documented
overrides are in `docs/DEVELOPMENT.md`.

Details: [Phase 3](phases/PHASE_3.md) · [Phase 2](phases/PHASE_2.md) · [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
