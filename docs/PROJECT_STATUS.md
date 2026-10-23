# Project Status

_Last updated: 2026-10-23_

| Item | State |
|------|-------|
| Active phase | **Phase 4: Operations analytics**, in review on `feature/p4-analytics-refresh` (base `9459fd5`) |
| `main` | `9459fd5`: Phases 0–3 and 5 merged, plus the top-bar modes fix (PR #1–#5, #7, #8); `main` CI run 39717397640: 5/5 jobs green |
| Last merged | PR #8, working top-bar modes with accurate coming-soon states (2026-10-22) |
| Closed unmerged | PR #6 (Phase 4 planning docs); not used as a basis |

## Phase status

| Phase | State | Record |
|-------|-------|--------|
| 0 Foundation | merged | `docs/phases/PHASE_0.md` |
| 1 3D world | merged | `docs/phases/PHASE_1.md` |
| 2 Living simulation | merged (PR #4) | `docs/phases/PHASE_2.md` |
| 3 Data engineering | merged (PR #5) | `docs/phases/PHASE_3.md` |
| 4 Operations analytics | **in review** on `feature/p4-analytics-refresh` | `docs/phases/PHASE_4.md` |
| 5 Multi-site world | merged (PR #7), follow-up PR #8 | `docs/phases/PHASE_5.md` |
| 6 AI and digital twin | not started | — |
| 7 Production | not started | — |

## Modes in the app

Explore and Operate are available; Analytics becomes available with the Phase 4 pull request
(published, reconciled data of recorded runs); Build (layout editing) is planned but not scheduled;
AI is planned for Phase 6.

## Pending

- Phase 4 review and merge decision (owner)
- Owner decisions: repository licence, public-demo hosting (Phase 7)

## Known blockers

None. Ports 3000, 5432, 8000, 9000 and 9094 are used by the owner's running stack on the development
machine; checks use throwaway containers on other ports (documented in `docs/DEVELOPMENT.md`).

Details: [Phase 4](phases/PHASE_4.md) · [Phase 5](phases/PHASE_5.md) · [Phase 3](phases/PHASE_3.md) · [Phase 2](phases/PHASE_2.md) · [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
