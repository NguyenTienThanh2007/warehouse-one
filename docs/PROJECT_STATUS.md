# Project Status

_Last updated: 2026-11-01_

| Item | State |
|------|-------|
| Active phase | **Phase 6.1: evaluation off the main thread** (twin worker pool), in review on `feature/p6-1-evaluation-worker` (base `72a2a0f`) |
| `main` | `72a2a0f`: Phases 0–6 merged (PR #1–#5, #7–#11); `main` CI run 40541684889: 5/5 jobs green |
| Last merged | PR #11, Phase 6 AI and digital twin: fleet decision support (`72a2a0f`, 2026-10-27); before it PR #10 (analytics connection fix) and PR #9 (Phase 4) |
| Closed unmerged | PR #6 (Phase 4 planning docs); not used as a basis |

## Phase status

| Phase | State | Record |
|-------|-------|--------|
| 0 Foundation | merged | `docs/phases/PHASE_0.md` |
| 1 3D world | merged | `docs/phases/PHASE_1.md` |
| 2 Living simulation | merged (PR #4) | `docs/phases/PHASE_2.md` |
| 3 Data engineering | merged (PR #5) | `docs/phases/PHASE_3.md` |
| 4 Operations analytics | merged (PR #9), follow-up PR #10 | `docs/phases/PHASE_4.md` |
| 5 Multi-site world | merged (PR #7), follow-up PR #8 | `docs/phases/PHASE_5.md` |
| 6 AI and digital twin | merged (PR #11; first slice: fleet standby); **6.1 in review** on `feature/p6-1-evaluation-worker` | `docs/phases/PHASE_6.md` |
| 7 Production | not started | — |

## Modes in the app

Explore, Operate, Analytics and AI (fleet decision support: optimiser, what-if, review and
approval, optional AI explanations) are available on `main`. Phase 6.1 moves AI-mode evaluations to
background workers. Build (layout editing) is planned but not scheduled.

## Pending

- Phase 6.1 review and merge decision (owner)
- Owner decisions: repository licence, public-demo hosting (Phase 7)
- Optional: an AI provider key for the API (`WAREHOUSE_AI_PROVIDER`, `WAREHOUSE_AI_API_KEY`) to try
  AI explanations; everything else works without it

## Known blockers

None. Ports 3000, 5432 and 8000 are used by other applications on the development machine; the
owner's stack runs on `API_PORT=8010` / `POSTGRES_PORT=5442`, and checks use throwaway containers
on other ports (documented in `docs/DEVELOPMENT.md`).

Details: [Phase 6 and 6.1](phases/PHASE_6.md) · [Phase 4](phases/PHASE_4.md) · [Phase 5](phases/PHASE_5.md) · [Phase 3](phases/PHASE_3.md) · [Phase 2](phases/PHASE_2.md) · [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
