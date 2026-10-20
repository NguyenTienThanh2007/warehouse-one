# Project Status

_Last updated: 2026-10-20_

| Item | State |
|------|-------|
| Active phase | **Phase 1: Premium 3D World**, implementation complete and in review |
| Branch / PR | `feature/p1-3d-world` → `main`, draft PR (link in the PR list; created with this branch) |
| `main` | `c512733`, Phase 0 accepted and merged; CI green |
| Next phase | Phase 2, Living warehouse simulation. **Blocked on Phase 1 approval** |

## Verified locally (Apple M2)

- TS: format, lint, typecheck, 104 unit tests, production build: PASS
- Python: ruff, mypy `--strict`, 20 unit + 2 PostgreSQL integration tests: PASS
- Playwright e2e: 18/18 on GPU and 18/18 under SwiftShader (`CI=1`)
- Benchmarks: 60 FPS (vsync), p95 18.0–20.6 ms at 100 / 300 / 1,000 pallets, High tier, two runs

## Pending

- GitHub Actions on the Phase 1 PR
- Owner review and approval of Phase 1
- Owner decisions: repository licence, public-demo hosting (Phase 7)

## Known blockers

None. Local dev ports 3000, 8000 and 5432 are occupied on the development machine; documented
overrides are in `docs/DEVELOPMENT.md`.

Details: [Phase 1](phases/PHASE_1.md) · [Phase 0](phases/PHASE_0.md).
