"use client";

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import type { EquipmentConfig, FacilityConfig, SimulationConfig } from "@warehouse-one/simulation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  Group,
  MeshBasicMaterial,
  PlaneGeometry,
  type InstancedMesh,
} from "three";
import { useSimulation, type Selection } from "@/lib/sim/store";
import { publishSceneDebug } from "@/lib/world/scene-debug";
import { useView } from "@/lib/world/view-store";
import {
  CARGO_ARCHETYPES,
  deriveRackParts,
  derivePallets,
  levelsFor,
  resolveFacility,
  sceneCounts,
  VEHICLE_SIZE,
  YARD_LEVEL,
  type CargoArchetype,
} from "@/world/derive";
import {
  beamGeometry,
  braceGeometry,
  cargoGeometry,
  forkliftModel,
  guardGeometry,
  palletGeometry,
  postGeometry,
  reachTruckModel,
  truckModel,
  type Model,
  type VehiclePart,
} from "@/world/geometry";
import {
  CARGO_COLOR,
  decalMaterial,
  floorMarkingsTexture,
  liveryTexture,
  PALLET_COLOR,
  worldMaterials,
  yardMarkingsTexture,
  type WorldMaterials,
} from "@/world/materials";
import { Instances, type InstanceSpec } from "./instanced";

/** The warehouse digital twin: static facility from config, dynamic stock from simulation state. */
export function WarehouseWorld() {
  const config = useSimulation((s) => s.config);
  const facility = useMemo(() => resolveFacility(config), [config]);
  const materials = useMemo(() => worldMaterials(), []);
  const rackHeight = useMemo(
    () =>
      (Math.max(1, ...config.locations.map((l) => levelsFor(l.capacity, facility.rack))) - 1) *
        facility.rack.level_height +
      1.4,
    [config, facility],
  );

  return (
    <group>
      <Site facility={facility} config={config} materials={materials} />
      <Building facility={facility} materials={materials} />
      <Racks config={config} facility={facility} materials={materials} />
      <Pallets config={config} facility={facility} materials={materials} />
      <Fleet equipment={facility.equipment} materials={materials} />
      <Docks facility={facility} materials={materials} />
      <PickLayer config={config} facility={facility} rackHeight={rackHeight} />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------

function Site({
  facility: f,
  config,
  materials,
}: {
  facility: FacilityConfig;
  config: SimulationConfig;
  materials: WorldMaterials;
}) {
  const { min, max } = f.building;
  const width = max.x - min.x;
  const depth = max.z - min.z;
  const floorMarks = useMemo(() => floorMarkingsTexture(config, f), [config, f]);
  const yardDepth = f.site.max.z - max.z;
  const yardMarks = useMemo(
    () => (yardDepth > 1 ? yardMarkingsTexture(f, yardDepth) : null),
    [f, yardDepth],
  );
  const siteW = f.site.max.x - f.site.min.x;
  const siteD = f.site.max.z - f.site.min.z;
  useEffect(() => () => floorMarks.texture.dispose(), [floorMarks]);
  useEffect(() => () => yardMarks?.texture.dispose(), [yardMarks]);

  return (
    <group>
      {/* Surrounding ground, fading into the fog. */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[
          (f.site.min.x + f.site.max.x) / 2,
          YARD_LEVEL - 0.03,
          (f.site.min.z + f.site.max.z) / 2,
        ]}
        receiveShadow
        material={materials.ground}
      >
        <planeGeometry args={[siteW * 8, siteD * 8]} />
      </mesh>
      {/* Yard: paved site at truck level, 1.2 m below the warehouse floor (dock height). */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[
          (f.site.min.x + f.site.max.x) / 2,
          YARD_LEVEL,
          (f.site.min.z + f.site.max.z) / 2,
        ]}
        receiveShadow
        material={materials.yard}
      >
        <planeGeometry args={[siteW, siteD]} />
      </mesh>
      {yardMarks && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[(f.site.min.x + f.site.max.x) / 2, YARD_LEVEL + 0.01, max.z + yardDepth / 2]}
          receiveShadow
        >
          <planeGeometry args={[siteW, yardDepth]} />
          <meshStandardMaterial
            map={yardMarks.texture}
            transparent
            roughness={0.9}
            depthWrite={false}
          />
        </mesh>
      )}
      {/* Raised slab: its exposed edge forms the dock plinth. */}
      <mesh
        position={[(min.x + max.x) / 2, YARD_LEVEL / 2, (min.z + max.z) / 2]}
        receiveShadow
        castShadow
        material={materials.plinth}
      >
        <boxGeometry args={[width + 0.5, -YARD_LEVEL, depth + 0.5]} />
      </mesh>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[(min.x + max.x) / 2, 0.002, (min.z + max.z) / 2]}
        receiveShadow
        material={materials.floor}
      >
        <planeGeometry args={[width, depth]} />
      </mesh>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[(min.x + max.x) / 2, 0.006, (min.z + max.z) / 2]}
        receiveShadow
      >
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial
          map={floorMarks.texture}
          transparent
          roughness={0.7}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------

interface WallSpec {
  key: string;
  /** Outward normal in XZ. */
  normal: [number, number];
  center: [number, number];
  /** Segments along the wall: [centre along wall, length, bottom, top]. */
  segments: [number, number, number, number][];
  /** Wall runs along x (true) or z (false). */
  alongX: boolean;
  /** Sign of the interior side along the wall's local z axis. */
  inner: 1 | -1;
  /** Structural column positions along the wall (local x), hidden together with the wall. */
  columns: number[];
}

const WALL_T = 0.25;
const KNEE = 1.1;
const DOOR = { width: 3.0, height: 3.2 };

function wallSpecs(f: FacilityConfig): WallSpec[] {
  const { min, max, height } = f.building;
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const w = max.x - min.x + WALL_T * 2;
  const d = max.z - min.z;
  const full = (len: number): [number, number, number, number][] => [[0, len, 0, height]];
  // Dock wall (+z) is split around the door openings, with lintels above each door.
  const doors = [...f.docks]
    .sort((a, b) => a.position.x - b.position.x)
    .map((dk) => dk.position.x - cx);
  const dockSegs: [number, number, number, number][] = [];
  let cursor = -w / 2;
  for (const x of doors) {
    const a = x - DOOR.width / 2;
    if (a > cursor) dockSegs.push([(cursor + a) / 2, a - cursor, 0, height]);
    dockSegs.push([x, DOOR.width, DOOR.height, height]);
    cursor = x + DOOR.width / 2;
  }
  if (cursor < w / 2) dockSegs.push([(cursor + w / 2) / 2, w / 2 - cursor, 0, height]);
  const cols = (len: number, avoid: number[] = []) => {
    const out: number[] = [];
    for (
      let x = -len / 2 + 0.3;
      x <= len / 2 - 0.3 + 1e-6;
      x += len / Math.max(1, Math.round(len / 7.5))
    ) {
      if (avoid.every((a) => Math.abs(a - x) > DOOR.width / 2 + 0.6))
        out.push(Math.round(x * 100) / 100);
    }
    return out;
  };
  return [
    {
      key: "north",
      normal: [0, -1],
      center: [cx, min.z - WALL_T / 2],
      segments: full(w),
      alongX: true,
      inner: 1,
      columns: cols(w - 1),
    },
    {
      key: "south",
      normal: [0, 1],
      center: [cx, max.z + WALL_T / 2],
      segments: dockSegs,
      alongX: true,
      inner: -1,
      columns: cols(w - 1, doors),
    },
    {
      key: "west",
      normal: [-1, 0],
      center: [min.x - WALL_T / 2, cz],
      segments: full(d),
      alongX: false,
      inner: 1,
      columns: cols(d - 1),
    },
    {
      key: "east",
      normal: [1, 0],
      center: [max.x + WALL_T / 2, cz],
      segments: full(d),
      alongX: false,
      inner: -1,
      columns: cols(d - 1),
    },
  ];
}

/**
 * Building envelope with an automatic cutaway: walls between the camera and the interior drop to
 * a knee wall so the operation inside is always visible, like a dollhouse view.
 */
function Building({
  facility: f,
  materials,
}: {
  facility: FacilityConfig;
  materials: WorldMaterials;
}) {
  const walls = useMemo(() => wallSpecs(f), [f]);
  const fullRefs = useRef<(Group | null)[]>([]);
  const kneeRefs = useRef<(Group | null)[]>([]);
  const columnGeo = useMemo(() => new BoxGeometry(0.3, 1, 0.3), []);

  useFrame(({ camera }) => {
    walls.forEach((wall, i) => {
      const facing =
        (camera.position.x - wall.center[0]) * wall.normal[0] +
          (camera.position.z - wall.center[1]) * wall.normal[1] >
        0;
      const full = fullRefs.current[i];
      const knee = kneeRefs.current[i];
      if (full) full.visible = !facing;
      if (knee) knee.visible = facing;
    });
  });

  return (
    <group>
      {walls.map((wall, i) => (
        <group
          key={wall.key}
          position={[wall.center[0], 0, wall.center[1]]}
          rotation-y={wall.alongX ? 0 : Math.PI / 2}
        >
          <group ref={(g) => void (fullRefs.current[i] = g)}>
            {wall.segments.map(([c, len, y0, y1], j) => (
              <mesh
                key={j}
                position={[c, (y0 + y1) / 2, 0]}
                castShadow
                receiveShadow
                material={materials.wall}
              >
                <boxGeometry args={[len, y1 - y0, WALL_T]} />
              </mesh>
            ))}
            {wall.columns.map((x) => (
              <mesh
                key={x}
                position={[x, f.building.height / 2, wall.inner * (WALL_T / 2 + 0.16)]}
                geometry={columnGeo}
                scale={[1, f.building.height, 1]}
                material={materials.column}
                castShadow
              />
            ))}
            <mesh
              position={[0, f.building.height + 0.15, 0]}
              material={materials.column}
              castShadow
            >
              <boxGeometry args={[wallLength(wall), 0.3, WALL_T + 0.1]} />
            </mesh>
          </group>
          <group ref={(g) => void (kneeRefs.current[i] = g)} visible={false}>
            {wall.segments
              .filter(([, , y0]) => y0 === 0)
              .map(([c, len], j) => (
                <mesh
                  key={j}
                  position={[c, KNEE / 2, 0]}
                  castShadow
                  receiveShadow
                  material={materials.wall}
                >
                  <boxGeometry args={[len, KNEE, WALL_T]} />
                </mesh>
              ))}
          </group>
        </group>
      ))}
    </group>
  );
}

function wallLength(w: WallSpec) {
  return w.segments.reduce((max, [c, len]) => Math.max(max, Math.abs(c) + len / 2), 0) * 2;
}

// ---------------------------------------------------------------------------------------------

function Racks({
  config,
  facility,
  materials,
}: {
  config: SimulationConfig;
  facility: FacilityConfig;
  materials: WorldMaterials;
}) {
  const geo = useMemo(
    () => ({
      post: postGeometry(),
      beam: beamGeometry(),
      brace: braceGeometry(),
      guard: guardGeometry(),
    }),
    [],
  );
  const parts = useMemo(() => deriveRackParts(config, facility.rack), [config, facility]);
  const posts = useMemo<InstanceSpec[]>(
    () =>
      parts.posts.map((p) => ({
        position: p.position,
        rotation: [0, p.yaw, 0],
        scale: [1, p.height, 1],
      })),
    [parts],
  );
  const beams = useMemo<InstanceSpec[]>(
    () =>
      parts.beams.map((b) => ({
        position: b.position,
        rotation: [0, b.yaw, 0],
        scale: [b.length, 1, 1],
      })),
    [parts],
  );
  const braces = useMemo<InstanceSpec[]>(
    () =>
      parts.braces.map((b) => ({
        position: b.position,
        rotation: [b.tilt, b.yaw, 0],
        order: "YXZ",
        scale: [1, 1, b.length],
      })),
    [parts],
  );
  const guards = useMemo<InstanceSpec[]>(
    () => parts.guards.map((g) => ({ position: g.position, rotation: [0, g.yaw, 0] })),
    [parts],
  );
  return (
    <group>
      <Instances
        geometry={geo.post}
        material={materials.rackPost}
        instances={posts}
        name="rack-posts"
      />
      <Instances
        geometry={geo.brace}
        material={materials.rackPost}
        instances={braces}
        name="rack-braces"
        castShadow={false}
      />
      <Instances
        geometry={geo.beam}
        material={materials.rackBeam}
        instances={beams}
        name="rack-beams"
      />
      <Instances
        geometry={geo.guard}
        material={materials.guard}
        instances={guards}
        name="rack-guards"
      />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------

function Pallets({
  config,
  facility,
  materials,
}: {
  config: SimulationConfig;
  facility: FacilityConfig;
  materials: WorldMaterials;
}) {
  const inventory = useSimulation((s) => s.inventory);
  const geo = useMemo(
    () => ({
      pallet: palletGeometry(),
      cargo: Object.fromEntries(CARGO_ARCHETYPES.map((a) => [a, cargoGeometry(a)])) as Record<
        CargoArchetype,
        ReturnType<typeof cargoGeometry>
      >,
    }),
    [],
  );
  const capacity = useMemo(() => config.locations.reduce((n, l) => n + l.capacity, 0), [config]);
  const pallets = useMemo(
    () => derivePallets(config, inventory, facility.rack),
    [config, inventory, facility],
  );

  const specs = useMemo(() => {
    const base = new Color(PALLET_COLOR);
    const palletSpecs: InstanceSpec[] = [];
    const cargo = Object.fromEntries(
      CARGO_ARCHETYPES.map((a) => [a, [] as InstanceSpec[]]),
    ) as Record<CargoArchetype, InstanceSpec[]>;
    const cargoBase = Object.fromEntries(
      CARGO_ARCHETYPES.map((a) => [a, new Color(CARGO_COLOR[a])]),
    ) as Record<CargoArchetype, Color>;
    for (const p of pallets) {
      const jitter = 0.9 + p.variation * 0.16;
      palletSpecs.push({
        position: p.position,
        rotation: [0, p.yaw, 0],
        color: base.clone().multiplyScalar(jitter),
      });
      cargo[p.archetype].push({
        position: p.position,
        rotation: [0, p.yaw, 0],
        color: cargoBase[p.archetype].clone().multiplyScalar(0.94 + p.variation * 0.1),
      });
    }
    return { palletSpecs, cargo };
  }, [pallets]);

  useEffect(() => {
    publishSceneDebug({ counts: sceneCounts(config, pallets) });
  }, [config, pallets]);

  return (
    <group>
      <Instances
        geometry={geo.pallet}
        material={materials.pallet}
        instances={specs.palletSpecs}
        capacity={capacity}
        name="pallets"
      />
      {CARGO_ARCHETYPES.map((a) => (
        <Instances
          key={a}
          geometry={geo.cargo[a]}
          material={materials.cargo[a]}
          instances={specs.cargo[a]}
          capacity={capacity}
          name={`cargo-${a}`}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------

const VEHICLE_PARTS: VehiclePart[] = ["body", "dark", "steel", "tyre", "glass"];

function Fleet({
  equipment,
  materials,
}: {
  equipment: readonly EquipmentConfig[];
  materials: WorldMaterials;
}) {
  const models = useMemo(
    () => ({
      counterbalance_forklift: forkliftModel(),
      reach_truck: reachTruckModel(),
      truck: truckModel(),
    }),
    [],
  );
  const livery = useMemo(() => {
    const map = liveryTexture();
    return { map, material: decalMaterial(map), geometry: new PlaneGeometry(9.5, 1.78) };
  }, []);
  useEffect(() => () => livery.map.dispose(), [livery]);

  const partMaterial = (kind: EquipmentConfig["kind"], part: VehiclePart) =>
    part === "body"
      ? kind === "truck"
        ? materials.vehicle.truckBody
        : materials.vehicle.forkliftBody
      : materials.vehicle[part];

  const byKind = useMemo(() => {
    const groups = new Map<EquipmentConfig["kind"], InstanceSpec[]>();
    for (const e of equipment) {
      const y = e.kind === "truck" ? YARD_LEVEL : 0;
      groups.set(e.kind, [
        ...(groups.get(e.kind) ?? []),
        { position: [e.position.x, y, e.position.z], rotation: [0, e.yaw, 0] },
      ]);
    }
    return groups;
  }, [equipment]);

  const decals = useMemo<InstanceSpec[]>(() => {
    const out: InstanceSpec[] = [];
    for (const e of equipment.filter((v) => v.kind === "truck")) {
      for (const side of [-1, 1]) {
        const c = Math.cos(e.yaw);
        const s = Math.sin(e.yaw);
        const lx = side * 1.255;
        const lz = -1.4;
        out.push({
          position: [
            e.position.x + lx * c + lz * s,
            YARD_LEVEL + 2.7,
            e.position.z - lx * s + lz * c,
          ],
          rotation: [0, e.yaw + (side * Math.PI) / 2, 0],
        });
      }
    }
    return out;
  }, [equipment]);

  return (
    <group>
      {[...byKind.entries()].map(([kind, instances]) =>
        VEHICLE_PARTS.map((part) => {
          const geometry = (models[kind] as Model<VehiclePart>)[part];
          return geometry ? (
            <Instances
              key={`${kind}-${part}`}
              geometry={geometry}
              material={partMaterial(kind, part)}
              instances={instances}
              name={`${kind}-${part}`}
            />
          ) : null;
        }),
      )}
      {decals.length > 0 && (
        <Instances
          geometry={livery.geometry}
          material={livery.material}
          instances={decals}
          castShadow={false}
          name="truck-livery"
        />
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------

function Docks({
  facility: f,
  materials,
}: {
  facility: FacilityConfig;
  materials: WorldMaterials;
}) {
  const geo = useMemo(() => ({ unit: new BoxGeometry(1, 1, 1) }), []);
  const parts = useMemo(() => {
    const seals: InstanceSpec[] = [];
    const bumpers: InstanceSpec[] = [];
    const levellers: InstanceSpec[] = [];
    const posts: InstanceSpec[] = [];
    for (const d of f.docks) {
      const { x, z } = d.position;
      // Foam dock shelter around the opening (outside), bumpers on the plinth, steel leveller inside.
      seals.push({
        position: [x - DOOR.width / 2 - 0.2, DOOR.height / 2, z + 0.45],
        scale: [0.4, DOOR.height + 0.4, 0.6],
      });
      seals.push({
        position: [x + DOOR.width / 2 + 0.2, DOOR.height / 2, z + 0.45],
        scale: [0.4, DOOR.height + 0.4, 0.6],
      });
      seals.push({
        position: [x, DOOR.height + 0.3, z + 0.45],
        scale: [DOOR.width + 0.8, 0.6, 0.6],
      });
      for (const s of [-1, 1])
        bumpers.push({ position: [x + s * 1.1, -0.35, z + 0.42], scale: [0.25, 0.45, 0.18] });
      levellers.push({ position: [x, 0.02, z - 1.25], scale: [2.0, 0.04, 2.5] });
      for (const s of [-1, 1])
        posts.push({
          position: [x + s * (DOOR.width / 2 + 0.25), 0.6, z - 0.45],
          scale: [0.16, 1.2, 0.16],
        });
    }
    return { seals, bumpers, levellers, posts };
  }, [f]);
  return (
    <group>
      <Instances
        geometry={geo.unit}
        material={materials.dockSeal}
        instances={parts.seals}
        name="dock-seals"
      />
      <Instances
        geometry={geo.unit}
        material={materials.bumper}
        instances={parts.bumpers}
        name="dock-bumpers"
      />
      <Instances
        geometry={geo.unit}
        material={materials.vehicle.steel}
        instances={parts.levellers}
        name="dock-levellers"
        castShadow={false}
      />
      <Instances
        geometry={geo.unit}
        material={materials.hazard}
        instances={parts.posts}
        name="dock-bollards"
      />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------

interface Pickable {
  selection: Selection;
  center: [number, number, number];
  size: [number, number, number];
  yaw: number;
}

const PICK_MATERIAL = new MeshBasicMaterial({ visible: false });
const HOVER_COLOR = new Color("#e8edf3");
const SELECT_COLOR = new Color("#f5b83d");

/** Invisible, cheap-to-raycast volumes for every selectable entity, plus hover/selection outlines. */
function PickLayer({
  config,
  facility: f,
  rackHeight,
}: {
  config: SimulationConfig;
  facility: FacilityConfig;
  rackHeight: number;
}) {
  const selection = useSimulation((s) => s.selection);
  const select = useSimulation((s) => s.select);
  const requestCamera = useView((s) => s.requestCamera);
  const [hover, setHover] = useState<number | null>(null);
  const unitBox = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(1, 1, 1)), []);
  const ref = useRef<InstancedMesh>(null);

  const pickables = useMemo<Pickable[]>(() => {
    const out: Pickable[] = [];
    for (const l of config.locations) {
      out.push({
        selection: { kind: "location", id: l.id },
        center: [l.position.x, rackHeight / 2, l.position.z],
        size: [f.rack.bay_width - 0.04, rackHeight, f.rack.depth + 0.2],
        yaw: l.yaw ?? 0,
      });
    }
    for (const e of f.equipment) {
      const s = VEHICLE_SIZE[e.kind];
      const y0 = e.kind === "truck" ? YARD_LEVEL : 0;
      out.push({
        selection: { kind: "equipment", id: e.id },
        center: [e.position.x, y0 + s.height / 2, e.position.z],
        size: [s.width + 0.2, s.height, s.length + 0.2],
        yaw: e.yaw,
      });
    }
    for (const d of f.docks) {
      out.push({
        selection: { kind: "dock", id: d.id },
        center: [d.position.x, DOOR.height / 2 + 0.2, d.position.z - 1.25],
        size: [DOOR.width + 0.6, DOOR.height + 0.4, 2.7],
        yaw: d.yaw,
      });
    }
    return out;
  }, [config, f, rackHeight]);

  const instances = useMemo<InstanceSpec[]>(
    () => pickables.map((p) => ({ position: p.center, rotation: [0, p.yaw, 0], scale: p.size })),
    [pickables],
  );
  const selectedIndex = selection
    ? pickables.findIndex(
        (p) => p.selection.kind === selection.kind && p.selection.id === selection.id,
      )
    : -1;

  useEffect(() => {
    publishSceneDebug({
      pickables: pickables.map((p) => ({ ...p.selection, center: p.center })),
    });
  }, [pickables]);

  useEffect(() => () => void (document.body.style.cursor = ""), []);

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId !== undefined && e.instanceId !== hover) {
      setHover(e.instanceId);
      document.body.style.cursor = "pointer";
    }
  };
  const onOut = () => {
    setHover(null);
    document.body.style.cursor = "";
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // A drag that orbits the camera is not a click.
    if (e.delta > 6 || e.instanceId === undefined) return;
    const p = pickables[e.instanceId];
    if (!p) return;
    const same =
      selection && selection.kind === p.selection.kind && selection.id === p.selection.id;
    select(same ? null : p.selection);
  };
  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const p = e.instanceId === undefined ? undefined : pickables[e.instanceId];
    if (!p) return;
    select(p.selection);
    requestCamera("focus");
  };

  return (
    <group>
      <Pick
        instances={instances}
        geometry={unitBox}
        meshRef={ref}
        onMove={onMove}
        onOut={onOut}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />
      {hover !== null && hover !== selectedIndex && pickables[hover] && (
        <Outline p={pickables[hover]} edges={edges} color={HOVER_COLOR} opacity={0.55} />
      )}
      {selectedIndex >= 0 && pickables[selectedIndex] && (
        <Outline
          p={pickables[selectedIndex]}
          edges={edges}
          color={SELECT_COLOR}
          opacity={1}
          footprint
        />
      )}
    </group>
  );
}

function Pick({
  instances,
  geometry,
  meshRef,
  onMove,
  onOut,
  onClick,
  onDoubleClick,
}: {
  instances: InstanceSpec[];
  geometry: BoxGeometry;
  meshRef: React.RefObject<InstancedMesh | null>;
  onMove: (e: ThreeEvent<PointerEvent>) => void;
  onOut: () => void;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  onDoubleClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const local = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = local.current;
    if (!mesh) return;
    meshRef.current = mesh;
    const m = new Group();
    instances.forEach((inst, i) => {
      m.position.set(...inst.position);
      m.rotation.set(...(inst.rotation ?? [0, 0, 0]));
      m.scale.set(...(inst.scale ?? [1, 1, 1]));
      m.updateMatrix();
      mesh.setMatrixAt(i, m.matrix);
    });
    mesh.count = instances.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [instances, meshRef]);
  return (
    <instancedMesh
      ref={local}
      key={instances.length}
      args={[geometry, PICK_MATERIAL, Math.max(1, instances.length)]}
      name="pick-volumes"
      onPointerMove={onMove}
      onPointerOut={onOut}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    />
  );
}

function Outline({
  p,
  edges,
  color,
  opacity,
  footprint,
}: {
  p: Pickable;
  edges: EdgesGeometry;
  color: Color;
  opacity: number;
  footprint?: boolean;
}) {
  return (
    <group position={p.center} rotation-y={p.yaw}>
      <lineSegments
        geometry={edges}
        scale={[p.size[0] + 0.06, p.size[1] + 0.06, p.size[2] + 0.06]}
        raycast={() => null}
      >
        <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={false} />
      </lineSegments>
      {footprint && (
        <mesh position-y={-p.size[1] / 2 + 0.015} rotation-x={-Math.PI / 2} raycast={() => null}>
          <planeGeometry args={[p.size[0] + 0.5, p.size[2] + 0.5]} />
          <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

/** Tracks the renderer's first frames and reports readiness (drives the loading overlay). */
export function ReadySignal() {
  const setStatus = useView((s) => s.setStatus);
  const frames = useRef(0);
  const { gl } = useThree();
  useFrame(() => {
    frames.current += 1;
    if (frames.current === 3) setStatus({ kind: "ready" });
  });
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault();
      setStatus({
        kind: "error",
        reason: "The graphics context was lost (GPU reset or too many WebGL pages open).",
      });
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }, [gl, setStatus]);
  return null;
}
