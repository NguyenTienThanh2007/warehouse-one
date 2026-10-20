# Asset Inventory & Attribution

WAREHOUSE ONE ships **no third-party 3D models, textures or HDR images**. Everything in the 3D
world is generated in code at runtime, so the assets are covered by the repository's own licence
and can be redistributed commercially.

| Asset | Source | Where |
|-------|--------|-------|
| Pallet (ISO 1.0 × 1.2 m, 7-board deck, 9 blocks) | Procedural, merged boxes | `apps/web/src/world/geometry.ts` `palletGeometry` |
| Cargo: mixed cartons, insulated cold-chain container, FIBC bulk bag, boxed electronics | Procedural | `cargoGeometry` |
| Selective pallet racking: uprights, frame bracing, load beams, post protectors | Procedural, instanced | `postGeometry`, `braceGeometry`, `beamGeometry`, `guardGeometry`; layout in `world/derive.ts` |
| Counterbalance forklift, reach truck | Procedural, per-material merged parts | `forkliftModel`, `reachTruckModel` |
| Tractor + 13.6 m trailer | Procedural | `truckModel` |
| Building envelope, cladding, columns, dock shelters, bumpers, levellers, bollards | Procedural | `components/world/warehouse-world.tsx` |
| Concrete, asphalt and cladding textures | Canvas-generated (seeded noise) | `world/materials.ts` |
| Floor and yard markings, row labels, dock numbers, charging bay | Canvas-drawn from facility data | `floorMarkingsTexture`, `yardMarkingsTexture` |
| Trailer livery ("WAREHOUSE ONE", our own product name) | Canvas-drawn | `liveryTexture` |
| Environment lighting | drei `<Environment>` with in-scene `<Lightformer>`s (no HDR file) | `components/world/lighting.tsx` |
| UI font | Geist Sans / Geist Mono, SIL Open Font License 1.1, self-hosted via the `geist` npm package | `apps/web/src/app/layout.tsx` |

## Dimensions (real-world scale, metres)

Rack bay 2.4 wide × 1.1 deep, 1.6 m beam pitch, 2 pallets per level. Working aisle 3.6 m. Flue
0.3 m. Dock door 3.0 × 3.2 m. Yard 1.2 m below floor (standard dock height). Truck 16.5 m overall.
Unit tests assert the pallet footprint, load heights below the beam pitch, and per-asset triangle
budgets (`apps/web/src/world/geometry.test.ts`).

## Policy for future assets

Any external model, texture or HDR must be added here with its source URL, author, licence and
the modifications made, before it is merged. Licences that forbid redistribution or commercial
use are not accepted. Prefer glTF with meshopt/KTX2 compression and keep per-instance triangle
budgets comparable to the procedural assets.
