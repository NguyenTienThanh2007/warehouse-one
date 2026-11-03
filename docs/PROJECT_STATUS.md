# Project Status

_Last updated: 2026-11-02_

| Item | State |
|------|-------|
| Active work | **Phase 7.1.1: dependency security** (Next.js and Zod upgrades, CI dependency audits, Dependabot), in review on `fix/p7-1-1-dependency-security`. Phase 7.0 (production-readiness audit) was delivered as a report; the rest of Phase 7 has not started |
| `main` | `b4285aa`: Phases 0–6.2 merged (PR #1–#5, #7–#16); `main` CI run 41473060803: 5/5 jobs green |
| Last merged | PR #16, Phase 6.2 documentation completion (`b4285aa`, 2026-11-02); PR #15, Phase 6.2 confidence-interval display precision (`6b1794b`, 2026-11-02); PR #14, Phase 6.2 statistical verdict correction (`2117d38`, 2026-11-02; `main` CI run 41453506465: 5/5 jobs green); PR #13, Phase 6.2 multi-seed robustness validation (`61c67d5`, 2026-11-01; `main` CI run 41322552933: 5/5 jobs green) |
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
| 6 AI and digital twin | merged (PR #11; first slice: fleet standby); 6.1 merged (PR #12); 6.2 merged (PR #13) with its statistical corrections (PR #14 verdict, PR #15 interval display): complete | `docs/phases/PHASE_6.md` |
| 7 Production | 7.0 audit done (report); **7.1.1 dependency security in review**; 7.1 (security and identity) otherwise not started | `docs/DEVELOPMENT.md` (dependency security) |

## Modes in the app

Explore, Operate, Analytics and AI (fleet decision support: optimiser, what-if, review and
approval, optional AI explanations) are available on `main`, with evaluations on background workers
(Phase 6.1) and advisory multi-seed validation of a plan (Phase 6.2). Build (layout editing) is
planned but not scheduled.

## Pending

- Owner decisions: repository licence, public-demo hosting (Phase 7)
- Optional: an AI provider key for the API (`WAREHOUSE_AI_PROVIDER`, `WAREHOUSE_AI_API_KEY`) to try
  AI explanations; everything else works without it

## Known blockers

None. Ports 3000, 5432 and 8000 are used by other applications on the development machine; the
owner's stack runs on `API_PORT=8010` / `POSTGRES_PORT=5442`, and checks use throwaway containers
on other ports (documented in `docs/DEVELOPMENT.md`).

Details: [Phase 6, 6.1 and 6.2](phases/PHASE_6.md) · [Phase 4](phases/PHASE_4.md) · [Phase 5](phases/PHASE_5.md) · [Phase 3](phases/PHASE_3.md) · [Phase 2](phases/PHASE_2.md) · [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
