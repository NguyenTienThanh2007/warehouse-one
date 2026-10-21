# Project Status

_Last updated: 2026-10-21_

| Item | State |
|------|-------|
| Active phase | **Phase 5: Multi-site logistics world**, in review on `feature/p5-multi-site-world` (base `0b25fa4`) |
| `main` | `0b25fa4`: Phases 0–3 merged (PR #1–#5) |
| Last merged phase | Phase 3, Real data engineering (`docs/phases/PHASE_3.md`), PR #5 |
| Not started | Phase 4 analytics (scope proposed in PR #6, closed unmerged) |

## Phase 5 (branch `feature/p5-multi-site-world`)

The DC inside a connected logistics park (container terminal, cross-dock, fleet depot, highway
gateway, road network) with deterministic line-haul transfers that hand over to the DC simulation;
world and facility views. Record, verification and limitations: `docs/phases/PHASE_5.md`. CI for
the branch runs on its pull request; the result is recorded there.

## Pending

- Phase 5 review and merge decision (owner)
- Phase 4 analytics implementation
- Owner decisions: repository licence, public-demo hosting (Phase 7)

## Known blockers

None. Ports 3000 and 8000 are used by other projects on the development machine; documented
overrides are in `docs/DEVELOPMENT.md`.

Details: [Phase 5](phases/PHASE_5.md) · [Phase 3](phases/PHASE_3.md) · [Phase 2](phases/PHASE_2.md) · [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
