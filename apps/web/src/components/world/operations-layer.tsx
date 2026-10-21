"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { FacilityConfig, MheKind, SimulationConfig } from "@warehouse-one/simulation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  Euler,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Group,
  type InstancedMesh,
  type Material,
} from "three";
import { renderAlpha, useSimulation, type Selection } from "@/lib/sim/store";
import { publishSceneDebug, type MovingDebug } from "@/lib/world/scene-debug";
import { useView } from "@/lib/world/view-store";
import { CARGO_ARCHETYPES, VEHICLE_SIZE, YARD_LEVEL, type CargoArchetype } from "@/world/derive";
import {
  cargoGeometry,
  FORK_BLADE_OFFSET,
  forkliftModel,
  palletGeometry,
  reachTruckModel,
  truckModel,
  type Model,
  type VehiclePart,
} from "@/world/geometry";
import {
  CARGO_COLOR,
  decalMaterial,
  liveryTexture,
  PALLET_COLOR,
  type WorldMaterials,
} from "@/world/materials";
import {
  carriedPallets,
  truckViews,
  vehicleViews,
  type PalletView,
  type TruckView,
  type VehicleView,
} from "@/world/ops-view";

/**
 * Everything that moves: material-handling vehicles (with forks at the simulated lift height),
 * trucks in the yard and at the docks, and pallets on forks. Poses are read from the authoritative
 * state every frame and interpolated between the last two ticks; nothing here is animated on its
 * own, so a paused simulation shows a still scene.
 */

const BODY_PARTS: VehiclePart[] = ["body", "dark", "steel", "tyre", "glass"];
const noRaycast = () => null;
const PICK_MATERIAL = new MeshBasicMaterial({ visible: false });
const HOVER_COLOR = new Color("#e8edf3");
const SELECT_COLOR = new Color("#f5b83d");

/** Trucks that can be on site at once: one per dock plus the yard row. */
export function truckCapacity(f: FacilityConfig): number {
  return f.docks.length + Math.max(2, f.docks.length);
}

const tmp = {
  m: new Matrix4(),
  q: new Quaternion(),
  e: new Euler(),
  p: new Vector3(),
  s: new Vector3(1, 1, 1),
  c: new Color(),
};

function put(
  mesh: InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale?: readonly [number, number, number],
): void {
  tmp.e.set(0, yaw, 0);
  tmp.q.setFromEuler(tmp.e);
  tmp.p.set(x, y, z);
  if (scale) tmp.s.set(...scale);
  else tmp.s.set(1, 1, 1);
  mesh.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s));
}

function finish(mesh: InstancedMesh | undefined, count: number): void {
  if (!mesh) return;
  // Buffers are sized from facility data (see truckCapacity); never draw past them.
  mesh.count = Math.min(count, mesh.instanceMatrix.count);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

interface Moving {
  selection: Selection;
  x: number;
  y: number;
  z: number;
  yaw: number;
  size: [number, number, number];
}

function movingOf(vehicles: readonly VehicleView[], trucks: readonly TruckView[]): Moving[] {
  const out: Moving[] = [];
  for (const v of vehicles) {
    const s = VEHICLE_SIZE[v.kind];
    out.push({
      selection: { kind: "equipment", id: v.id },
      x: v.pose.x,
      y: s.height / 2,
      z: v.pose.z,
      yaw: v.pose.yaw,
      size: [s.width + 0.2, s.height, s.length + 0.2],
    });
  }
  for (const t of trucks) {
    const s = VEHICLE_SIZE.truck;
    out.push({
      selection: { kind: "truck", id: t.id },
      x: t.pose.x,
      y: YARD_LEVEL + s.height / 2,
      z: t.pose.z,
      yaw: t.pose.yaw,
      size: [s.width + 0.2, s.height, s.length + 0.2],
    });
  }
  return out;
}

const same = (a: Selection | null, b: Selection | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

export function OperationsLayer({
  config,
  facility: f,
  materials,
}: {
  config: SimulationConfig;
  facility: FacilityConfig;
  materials: WorldMaterials;
}) {
  const models = useMemo(
    () => ({ counterbalance_forklift: forkliftModel(), reach_truck: reachTruckModel() }),
    [],
  );
  const truck = useMemo(() => truckModel(), []);
  const livery = useMemo(() => {
    const map = liveryTexture();
    return { map, material: decalMaterial(map), geometry: new PlaneGeometry(9.5, 1.78) };
  }, []);
  useEffect(() => () => livery.map.dispose(), [livery]);
  const palletGeo = useMemo(
    () => ({
      pallet: palletGeometry(),
      cargo: Object.fromEntries(CARGO_ARCHETYPES.map((a) => [a, cargoGeometry(a)])) as Record<
        CargoArchetype,
        BufferGeometry
      >,
    }),
    [],
  );
  const pickBox = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(1, 1, 1)), []);

  const fleetSize = useMemo(() => {
    const n: Record<MheKind, number> = { counterbalance_forklift: 0, reach_truck: 0 };
    for (const e of f.equipment) if (e.kind !== "truck") n[e.kind] += 1;
    return n;
  }, [f]);
  const kinds = (Object.keys(fleetSize) as MheKind[]).filter((k) => fleetSize[k] > 0);
  const vehicleCount = kinds.reduce((n, k) => n + fleetSize[k], 0);
  const trucks = truckCapacity(f);

  const meshes = useMemo(() => new Map<string, InstancedMesh>(), []);
  const pick = useRef<InstancedMesh>(null);
  const picked = useRef<Moving[]>([]);
  const hoverRef = useRef<Group>(null);
  const selectRef = useRef<Group>(null);
  const [hover, setHover] = useState<Selection | null>(null);
  const select = useSimulation((s) => s.select);
  const requestCamera = useView((s) => s.requestCamera);
  const palletBase = useMemo(() => new Color(PALLET_COLOR), []);
  const cargoBase = useMemo(
    () =>
      Object.fromEntries(CARGO_ARCHETYPES.map((a) => [a, new Color(CARGO_COLOR[a])])) as Record<
        CargoArchetype,
        Color
      >,
    [],
  );

  useFrame(() => {
    const sim = useSimulation.getState();
    const ops = sim.state.ops;
    if (!ops || sim.config !== config) return;
    const alpha = renderAlpha();
    const vehicles = vehicleViews(config, sim.prevState.ops, ops, alpha);
    const trucksNow = truckViews(config, sim.prevState.ops, ops, alpha);
    const carried = carriedPallets(config, sim.state, vehicles);
    const m = meshes;

    // Vehicles: body parts on the floor, forks at the simulated fork height.
    for (const kind of kinds) {
      const own = vehicles.filter((v) => v.kind === kind);
      for (const part of [...BODY_PARTS, "forks" as const]) {
        const mesh = m.get(`${kind}-${part}`);
        if (!mesh) continue;
        own.forEach((v, i) =>
          put(
            mesh,
            i,
            v.pose.x,
            part === "forks" ? v.pose.fork + FORK_BLADE_OFFSET : 0,
            v.pose.z,
            v.pose.yaw,
          ),
        );
        finish(mesh, own.length);
      }
    }

    // Trucks and their livery decals.
    for (const part of BODY_PARTS) {
      const mesh = m.get(`truck-${part}`);
      if (!mesh) continue;
      trucksNow.forEach((t, i) => put(mesh, i, t.pose.x, YARD_LEVEL, t.pose.z, t.pose.yaw));
      finish(mesh, trucksNow.length);
    }
    const decals = m.get("truck-livery");
    if (decals) {
      let n = 0;
      for (const t of trucksNow) {
        const c = Math.cos(t.pose.yaw);
        const s = Math.sin(t.pose.yaw);
        for (const side of [-1, 1]) {
          const lx = side * 1.255;
          const lz = -1.4;
          put(
            decals,
            n++,
            t.pose.x + lx * c + lz * s,
            YARD_LEVEL + 2.7,
            t.pose.z - lx * s + lz * c,
            t.pose.yaw + (side * Math.PI) / 2,
          );
        }
      }
      finish(decals, n);
    }

    // Pallets on forks.
    writePallets(m, carried, palletBase, cargoBase);

    // Pick volumes and outlines follow the vehicles.
    const moving = movingOf(vehicles, trucksNow);
    picked.current = moving;
    const pm = pick.current;
    if (pm) {
      moving.forEach((v, i) => put(pm, i, v.x, v.y, v.z, v.yaw, v.size));
      finish(pm, moving.length);
      pm.computeBoundingSphere();
    }
    const outline = (g: Group | null, sel: Selection | null) => {
      if (!g) return;
      const v = sel ? moving.find((x) => same(x.selection, sel)) : undefined;
      g.visible = !!v;
      if (!v) return;
      g.position.set(v.x, v.y, v.z);
      g.rotation.set(0, v.yaw, 0);
      g.scale.set(v.size[0] + 0.06, v.size[1] + 0.06, v.size[2] + 0.06);
    };
    outline(hoverRef.current, same(hover, sim.selection) ? null : hover);
    outline(selectRef.current, sim.selection);

    publishSceneDebug({ moving: debugOf(vehicles, trucksNow, carried, moving) });
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const v = e.instanceId === undefined ? undefined : picked.current[e.instanceId];
    if (v && !same(v.selection, hover)) {
      setHover(v.selection);
      document.body.style.cursor = "pointer";
    }
  };
  const onOut = () => {
    setHover(null);
    document.body.style.cursor = "";
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 6 || e.instanceId === undefined) return;
    const v = picked.current[e.instanceId];
    if (!v) return;
    select(same(useSimulation.getState().selection, v.selection) ? null : v.selection);
  };
  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const v = e.instanceId === undefined ? undefined : picked.current[e.instanceId];
    if (!v) return;
    select(v.selection);
    requestCamera("focus");
  };

  const partMaterial = (body: Material, part: VehiclePart): Material =>
    part === "body" ? body : part === "forks" ? materials.vehicle.steel : materials.vehicle[part];

  return (
    <group>
      {kinds.map((kind) =>
        [...BODY_PARTS, "forks" as const].map((part) => {
          const geometry = (models[kind] as Model<VehiclePart>)[part];
          return geometry ? (
            <Dynamic
              key={`${kind}-${part}`}
              id={`${kind}-${part}`}
              registry={meshes}
              geometry={geometry}
              material={partMaterial(materials.vehicle.forkliftBody, part)}
              capacity={fleetSize[kind]}
              name={`${kind}-${part}`}
            />
          ) : null;
        }),
      )}
      {BODY_PARTS.map((part) => {
        const geometry = truck[part];
        return geometry ? (
          <Dynamic
            key={`truck-${part}`}
            id={`truck-${part}`}
            registry={meshes}
            geometry={geometry}
            material={partMaterial(materials.vehicle.truckBody, part)}
            capacity={trucks}
            name={`truck-${part}`}
          />
        ) : null;
      })}
      <Dynamic
        id={"truck-livery"}
        registry={meshes}
        geometry={livery.geometry}
        material={livery.material}
        capacity={trucks * 2}
        castShadow={false}
        name="truck-livery"
      />
      <Dynamic
        id={"carried-pallet"}
        registry={meshes}
        geometry={palletGeo.pallet}
        material={materials.pallet}
        capacity={vehicleCount}
        name="carried-pallets"
      />
      {CARGO_ARCHETYPES.map((a) => (
        <Dynamic
          key={a}
          id={`carried-${a}`}
          registry={meshes}
          geometry={palletGeo.cargo[a]}
          material={materials.cargo[a]}
          capacity={vehicleCount}
          name={`carried-cargo-${a}`}
        />
      ))}
      <instancedMesh
        ref={pick}
        args={[pickBox, PICK_MATERIAL, Math.max(1, vehicleCount + trucks)]}
        name="moving-pick-volumes"
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />
      <group ref={hoverRef} visible={false}>
        <lineSegments geometry={edges} raycast={noRaycast}>
          <lineBasicMaterial color={HOVER_COLOR} transparent opacity={0.55} depthTest={false} />
        </lineSegments>
      </group>
      <group ref={selectRef} visible={false}>
        <lineSegments geometry={edges} raycast={noRaycast}>
          <lineBasicMaterial color={SELECT_COLOR} transparent opacity={1} depthTest={false} />
        </lineSegments>
      </group>
    </group>
  );
}

function writePallets(
  m: Map<string, InstancedMesh>,
  carried: readonly PalletView[],
  palletBase: Color,
  cargoBase: Record<CargoArchetype, Color>,
): void {
  const pallet = m.get("carried-pallet");
  if (pallet) {
    carried.forEach((p, i) => {
      put(pallet, i, p.position[0], p.position[1], p.position[2], p.yaw);
      pallet.setColorAt(i, tmp.c.copy(palletBase).multiplyScalar(0.9 + p.variation * 0.16));
    });
    finish(pallet, carried.length);
  }
  for (const a of CARGO_ARCHETYPES) {
    const mesh = m.get(`carried-${a}`);
    if (!mesh) continue;
    const own = carried.filter((p) => p.archetype === a);
    own.forEach((p, i) => {
      put(mesh, i, p.position[0], p.position[1], p.position[2], p.yaw);
      mesh.setColorAt(i, tmp.c.copy(cargoBase[a]).multiplyScalar(0.94 + p.variation * 0.1));
    });
    finish(mesh, own.length);
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function debugOf(
  vehicles: readonly VehicleView[],
  trucks: readonly TruckView[],
  carried: readonly PalletView[],
  moving: readonly Moving[],
): MovingDebug {
  return {
    vehicles: vehicles.map((v) => ({
      id: v.id,
      x: round(v.pose.x),
      z: round(v.pose.z),
      yaw: round(v.pose.yaw),
      fork: round(v.pose.fork),
    })),
    trucks: trucks.map((t) => ({ id: t.id, x: round(t.pose.x), z: round(t.pose.z) })),
    carried: carried.map((p) => ({
      id: p.id,
      x: round(p.position[0]),
      y: round(p.position[1]),
      z: round(p.position[2]),
    })),
    pickables: moving.map((v) => ({ ...v.selection, center: [v.x, v.y, v.z] })),
  };
}

/** An instanced mesh whose transforms are written every frame by `OperationsLayer`. */
function Dynamic({
  id,
  registry,
  geometry,
  material,
  capacity,
  name,
  castShadow = true,
}: {
  id: string;
  registry: Map<string, InstancedMesh>;
  geometry: BufferGeometry;
  material: Material;
  capacity: number;
  name: string;
  castShadow?: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.count = 0;
    registry.set(id, mesh);
    return () => void registry.delete(id);
  }, [registry, id, capacity]);
  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geometry, material, Math.max(1, capacity)]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled={false}
      raycast={noRaycast}
    />
  );
}
