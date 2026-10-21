"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { SimulationConfig } from "@warehouse-one/simulation";
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
  type Mesh,
} from "three";
import { renderAlpha, useSimulation, type Selection } from "@/lib/sim/store";
import { publishSceneDebug } from "@/lib/world/scene-debug";
import { siteLabelElement } from "@/lib/world/site-labels";
import { useView } from "@/lib/world/view-store";
import { CARGO_ARCHETYPES, YARD_LEVEL, hash01, type CargoArchetype } from "@/world/derive";
import { cargoGeometry, palletGeometry, truckModel, type VehiclePart } from "@/world/geometry";
import {
  CARGO_COLOR,
  CONTAINER_COLORS,
  decalMaterial,
  liveryTexture,
  networkMaterials,
  PALLET_COLOR,
  type WorldMaterials,
} from "@/world/materials";
import { buildNetworkStatic, type CutawayWall } from "@/world/network-geometry";
import {
  CONTAINER,
  containerSlots,
  floorPallets,
  floorSlots,
  linehaulViews,
  resolveSites,
  type LinehaulView,
  type SiteView,
} from "@/world/network-view";
import { Instances, type InstanceSpec } from "./instanced";

/**
 * The logistics network around the facility (Phase 5): terrain, roads, the other sites and their
 * buildings, containers and pallets on hand, the line-haul fleet, and site labels. Static layout
 * comes from `config.network`; containers, pallets, door lights and trucks from `state.network`.
 * Nothing here writes simulation state.
 */
export function NetworkWorld({ materials }: { materials: WorldMaterials }) {
  const config = useSimulation((s) => s.config);
  if (!config.network) return null;
  return <Network config={config} materials={materials} />;
}

const noRaycast = () => null;
const PICK_MATERIAL = new MeshBasicMaterial({ visible: false });
const SELECT_COLOR = new Color("#f5b83d");
const HOVER_COLOR = new Color("#e8edf3");

function Network({ config, materials }: { config: SimulationConfig; materials: WorldMaterials }) {
  const net = useMemo(() => networkMaterials(), []);
  const built = useMemo(() => buildNetworkStatic(config), [config]);
  const sites = useMemo(() => resolveSites(config), [config]);
  useEffect(
    () => () => {
      for (const g of Object.values(built.meshes)) g.dispose();
      for (const r of built.roofs) r.geometry.dispose();
      for (const w of built.walls) {
        w.full.dispose();
        w.knee?.dispose();
      }
    },
    [built],
  );

  const materialFor: Record<string, Material> = useMemo(
    () => ({
      terrain: net.terrain,
      water: net.water,
      quay: net.quay,
      road: net.road,
      roadService: net.road,
      marking: net.marking,
      markingYellow: net.markingYellow,
      sign: net.glazing,
      trim: net.trim,
      pad: net.pad,
      padDark: net.padDark,
      fence: net.fence,
      lampHead: net.lampHead,
      wall: materials.wall,
      glazing: net.glazing,
      hazard: materials.hazard,
      seal: materials.dockSeal,
      bumper: materials.bumper,
      plinth: materials.plinth,
      hallFloor: materials.floor,
      craneYellow: net.craneYellow,
      craneBlue: net.craneBlue,
      tyre: materials.vehicle.tyre,
      trunk: net.trunk,
      tree: net.tree,
    }),
    [net, materials],
  );
  const flat = new Set([
    "terrain",
    "water",
    "road",
    "roadService",
    "marking",
    "markingYellow",
    "pad",
    "padDark",
    "hallFloor",
  ]);

  return (
    <group name="network">
      {Object.entries(built.meshes).map(([key, geometry]) => (
        <mesh
          key={key}
          name={`network-${key}`}
          geometry={geometry}
          material={materialFor[key] ?? net.trim}
          castShadow={!flat.has(key)}
          receiveShadow
          raycast={noRaycast}
        />
      ))}
      <Roofs roofs={built.roofs} material={net.roof} />
      <CutawayWalls walls={built.walls} material={materials.wall} />
      <DoorLights lights={built.doorLights} materials={materials} />
      {sites.map((s) =>
        s.containers ? <ContainerStacks key={s.id} site={s} material={net.container} /> : null,
      )}
      {sites
        .filter((s) => s.palletCapacity > 0)
        .map((s) => (
          <FloorStock key={s.id} config={config} site={s} materials={materials} />
        ))}
      <Fleet config={config} materials={materials} />
      <SitePicks sites={sites} />
      <SiteLabelProjector sites={sites} />
      <NetworkDebug config={config} sites={sites} buildings={built.roofs.length} />
    </group>
  );
}

/** Roofs disappear in their own site's facility view (and when the camera is close), like a cutaway. */
function Roofs({
  roofs,
  material,
}: {
  roofs: { site: string; building: string; geometry: BufferGeometry }[];
  material: Material;
}) {
  const refs = useRef<(Mesh | null)[]>([]);
  const centers = useMemo(
    () =>
      roofs.map((r) => {
        r.geometry.computeBoundingSphere();
        return r.geometry.boundingSphere?.center.clone() ?? new Vector3();
      }),
    [roofs],
  );
  useFrame(({ camera }) => {
    roofs.forEach((r, i) => {
      const m = refs.current[i];
      const c = centers[i];
      if (!m || !c) return;
      m.visible = !cutawayActive(r.site, camera.position.distanceTo(c));
    });
  });
  return (
    <>
      {roofs.map((r, i) => (
        <mesh
          key={r.building}
          ref={(m) => void (refs.current[i] = m)}
          name={`roof-${r.building}`}
          geometry={r.geometry}
          material={material}
          castShadow
          receiveShadow
          raycast={noRaycast}
        />
      ))}
    </>
  );
}

/** True while the camera shows this site's facility view, or is close to the building. */
function cutawayActive(site: string, distance: number): boolean {
  const scope = useView.getState().scope;
  return distance < 120 || (scope.kind === "site" && scope.siteId === site);
}

/**
 * Walls of halls and the workshop. In a facility view the walls between the camera and the inside
 * drop to a knee wall (like the DC), so docks, staging lanes and trucks inside stay visible.
 */
function CutawayWalls({ walls, material }: { walls: CutawayWall[]; material: Material }) {
  const full = useRef<(Mesh | null)[]>([]);
  const knee = useRef<(Mesh | null)[]>([]);
  useFrame(({ camera }) => {
    walls.forEach((w, i) => {
      const dx = camera.position.x - w.center[0];
      const dz = camera.position.z - w.center[1];
      const facing = dx * w.normal[0] + dz * w.normal[1] > 0;
      const cut = facing && cutawayActive(w.site, Math.hypot(dx, dz));
      const f = full.current[i];
      const k = knee.current[i];
      if (f) f.visible = !cut;
      if (k) k.visible = cut;
    });
  });
  return (
    <>
      {walls.map((w, i) => (
        <group key={`${w.building}-${i}`}>
          <mesh
            ref={(m) => void (full.current[i] = m)}
            geometry={w.full}
            material={material}
            castShadow
            receiveShadow
            raycast={noRaycast}
          />
          {w.knee && (
            <mesh
              ref={(m) => void (knee.current[i] = m)}
              geometry={w.knee}
              material={material}
              visible={false}
              castShadow
              receiveShadow
              raycast={noRaycast}
            />
          )}
        </group>
      ))}
    </>
  );
}

/** Green when the door is free, amber while a truck stands at it (from `state.network`). */
function DoorLights({
  lights,
  materials,
}: {
  lights: { stand: string; site: string; position: readonly [number, number, number] }[];
  materials: WorldMaterials;
}) {
  const geo = useMemo(() => new BoxGeometry(0.22, 0.22, 0.22), []);
  const sites = useSimulation((s) => s.state.network?.sites);
  const vehicles = useSimulation((s) => s.state.network?.vehicles);
  const { free, busy } = useMemo(() => {
    const free: InstanceSpec[] = [];
    const busy: InstanceSpec[] = [];
    for (const l of lights) {
      const holder = sites?.[l.site]?.stands[l.stand];
      const at = holder ? vehicles?.[holder]?.stand_id === l.stand : false;
      (at ? busy : free).push({ position: l.position });
    }
    return { free, busy };
  }, [lights, sites, vehicles]);
  return (
    <>
      <Instances
        geometry={geo}
        material={materials.dockLight.free}
        instances={free}
        capacity={lights.length}
        castShadow={false}
        name="network-door-lights-free"
      />
      <Instances
        geometry={geo}
        material={materials.dockLight.occupied}
        instances={busy}
        capacity={lights.length}
        castShadow={false}
        name="network-door-lights-busy"
      />
    </>
  );
}

/** Containers in the stacks: exactly the terminal's `containers` count, lowest tiers first. */
function ContainerStacks({ site, material }: { site: SiteView; material: Material }) {
  const count = useSimulation((s) => s.state.network?.sites[site.id]?.containers ?? 0);
  const slots = useMemo(() => (site.containers ? containerSlots(site.containers) : []), [site]);
  const geo = useMemo(
    () => new BoxGeometry(CONTAINER.length, CONTAINER.height, CONTAINER.width),
    [],
  );
  const colors = useMemo(
    () =>
      slots.map((s) => {
        const c = new Color(CONTAINER_COLORS[Math.floor(hash01(s.key) * CONTAINER_COLORS.length)]);
        return c.multiplyScalar(0.82 + hash01(`${s.key}-v`) * 0.3);
      }),
    [slots],
  );
  const instances = useMemo<InstanceSpec[]>(
    () =>
      slots.slice(0, count).map((s, i) => ({
        position: [s.x, YARD_LEVEL + s.y + CONTAINER.height / 2, s.z],
        color: colors[i],
      })),
    [slots, count, colors],
  );
  return (
    <Instances
      geometry={geo}
      material={material}
      instances={instances}
      capacity={slots.length}
      name={`containers-${site.id}`}
    />
  );
}

/** Pallets on hand at a site, in staging lanes behind its doors (`state.network` stock). */
function FloorStock({
  config,
  site,
  materials,
}: {
  config: SimulationConfig;
  site: SiteView;
  materials: WorldMaterials;
}) {
  const stock = useSimulation((s) => s.state.network?.sites[site.id]?.stock);
  const capacity = useMemo(() => floorSlots(site).length, [site]);
  const geo = useMemo(
    () => ({
      pallet: palletGeometry(),
      cargo: Object.fromEntries(CARGO_ARCHETYPES.map((a) => [a, cargoGeometry(a)])) as Record<
        CargoArchetype,
        BufferGeometry
      >,
    }),
    [],
  );
  const pallets = useMemo(
    () => (stock ? floorPallets(config, site, stock) : []),
    [config, site, stock],
  );
  const palletBase = useMemo(() => new Color(PALLET_COLOR), []);
  const specs = useMemo(() => {
    const base: InstanceSpec[] = [];
    const cargo = Object.fromEntries(
      CARGO_ARCHETYPES.map((a) => [a, [] as InstanceSpec[]]),
    ) as Record<CargoArchetype, InstanceSpec[]>;
    for (const p of pallets) {
      const v = hash01(p.key + site.id);
      const pos = [p.x, p.y, p.z] as const;
      base.push({
        position: pos,
        rotation: [0, p.yaw, 0],
        color: palletBase.clone().multiplyScalar(0.9 + v * 0.16),
      });
      cargo[p.archetype].push({
        position: pos,
        rotation: [0, p.yaw, 0],
        color: new Color(CARGO_COLOR[p.archetype]).multiplyScalar(0.94 + v * 0.1),
      });
    }
    return { base, cargo };
  }, [pallets, palletBase, site.id]);
  return (
    <group name={`floor-stock-${site.id}`}>
      <Instances
        geometry={geo.pallet}
        material={materials.pallet}
        instances={specs.base}
        capacity={capacity}
      />
      {CARGO_ARCHETYPES.map((a) => (
        <Instances
          key={a}
          geometry={geo.cargo[a]}
          material={materials.cargo[a]}
          instances={specs.cargo[a]}
          capacity={capacity}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Line-haul fleet

const BODY_PARTS: VehiclePart[] = ["body", "dark", "steel", "tyre", "glass"];
const tmp = {
  m: new Matrix4(),
  q: new Quaternion(),
  e: new Euler(),
  p: new Vector3(),
  s: new Vector3(1, 1, 1),
};

function put(
  mesh: InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale?: readonly [number, number, number],
) {
  tmp.e.set(0, yaw, 0);
  tmp.q.setFromEuler(tmp.e);
  tmp.p.set(x, y, z);
  if (scale) tmp.s.set(...scale);
  else tmp.s.set(1, 1, 1);
  mesh.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s));
}

function finish(mesh: InstancedMesh | null | undefined, n: number) {
  if (!mesh) return;
  mesh.count = Math.min(n, mesh.instanceMatrix.count);
  mesh.instanceMatrix.needsUpdate = true;
}

const same = (a: Selection | null, b: Selection | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

/** Line-haul trucks, drawn every frame from `linehaulPose`, interpolated between ticks. */
function Fleet({ config, materials }: { config: SimulationConfig; materials: WorldMaterials }) {
  const model = useMemo(() => truckModel(), []);
  const livery = useMemo(() => {
    const map = liveryTexture();
    return { map, material: decalMaterial(map), geometry: new PlaneGeometry(9.5, 1.78) };
  }, []);
  useEffect(() => () => livery.map.dispose(), [livery]);
  const capacity = Math.max(1, config.network?.vehicles.length ?? 0);
  const meshes = useMemo(() => new Map<string, InstancedMesh>(), []);
  const pick = useRef<InstancedMesh>(null);
  const drawn = useRef<LinehaulView[]>([]);
  const outline = useRef<Group>(null);
  const hoverOutline = useRef<Group>(null);
  const [hover, setHover] = useState<string | null>(null);
  const select = useSimulation((s) => s.select);
  const requestCamera = useView((s) => s.requestCamera);
  const pickBox = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(1, 1, 1)), []);

  useFrame(() => {
    const sim = useSimulation.getState();
    if (sim.config !== config) return;
    const views = linehaulViews(config, sim.prevState, sim.state, renderAlpha());
    drawn.current = views;
    for (const part of BODY_PARTS) {
      const mesh = meshes.get(part);
      if (!mesh) continue;
      views.forEach((v, i) => put(mesh, i, v.pose.x, YARD_LEVEL, v.pose.z, v.pose.yaw));
      finish(mesh, views.length);
    }
    const decals = meshes.get("livery");
    if (decals) {
      let n = 0;
      for (const v of views) {
        const c = Math.cos(v.pose.yaw);
        const s = Math.sin(v.pose.yaw);
        for (const side of [-1, 1]) {
          const lx = side * 1.255;
          const lz = -1.4;
          put(
            decals,
            n++,
            v.pose.x + lx * c + lz * s,
            YARD_LEVEL + 2.7,
            v.pose.z - lx * s + lz * c,
            v.pose.yaw + (side * Math.PI) / 2,
          );
        }
      }
      finish(decals, n);
    }
    const pm = pick.current;
    if (pm) {
      views.forEach((v, i) =>
        put(pm, i, v.pose.x, YARD_LEVEL + 2, v.pose.z, v.pose.yaw, [2.8, 4.2, 16.8]),
      );
      finish(pm, views.length);
      pm.computeBoundingSphere();
    }
    const place = (g: Group | null, id: string | null) => {
      if (!g) return;
      const v = id ? views.find((x) => x.id === id) : undefined;
      g.visible = !!v;
      if (!v) return;
      g.position.set(v.pose.x, YARD_LEVEL + 2.05, v.pose.z);
      g.rotation.set(0, v.pose.yaw, 0);
      g.scale.set(2.9, 4.3, 16.9);
    };
    publishSceneDebug({
      fleet: views.map((v) => ({
        id: v.id,
        x: Math.round(v.pose.x * 1000) / 1000,
        z: Math.round(v.pose.z * 1000) / 1000,
      })),
    });
    const sel = sim.selection?.kind === "linehaul" ? sim.selection.id : null;
    place(outline.current, sel);
    place(hoverOutline.current, hover && hover !== sel ? hover : null);
  });

  const idOf = (e: ThreeEvent<PointerEvent | MouseEvent>) =>
    e.instanceId === undefined ? undefined : drawn.current[e.instanceId]?.id;

  return (
    <group name="linehaul-fleet">
      {BODY_PARTS.map((part) => {
        const geometry = model[part];
        if (!geometry) return null;
        const material =
          part === "body"
            ? materials.vehicle.truckBody
            : materials.vehicle[part as Exclude<VehiclePart, "body" | "forks">];
        return (
          <FleetMesh
            key={part}
            id={part}
            registry={meshes}
            geometry={geometry}
            material={material}
            capacity={capacity}
          />
        );
      })}
      <FleetMesh
        id="livery"
        registry={meshes}
        geometry={livery.geometry}
        material={livery.material}
        capacity={capacity * 2}
        castShadow={false}
      />
      <instancedMesh
        ref={pick}
        args={[pickBox, PICK_MATERIAL, capacity]}
        name="linehaul-pick-volumes"
        frustumCulled={false}
        onPointerMove={(e) => {
          e.stopPropagation();
          const id = idOf(e);
          if (id && id !== hover) {
            setHover(id);
            document.body.style.cursor = "pointer";
          }
        }}
        onPointerOut={() => {
          setHover(null);
          document.body.style.cursor = "";
        }}
        onClick={(e) => {
          e.stopPropagation();
          const id = idOf(e);
          if (e.delta > 6 || !id) return;
          const sel: Selection = { kind: "linehaul", id };
          select(same(useSimulation.getState().selection, sel) ? null : sel);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const id = idOf(e);
          if (!id) return;
          select({ kind: "linehaul", id });
          requestCamera("focus");
        }}
      />
      <group ref={outline} visible={false}>
        <lineSegments geometry={edges} raycast={noRaycast}>
          <lineBasicMaterial color={SELECT_COLOR} transparent opacity={1} depthTest={false} />
        </lineSegments>
      </group>
      <group ref={hoverOutline} visible={false}>
        <lineSegments geometry={edges} raycast={noRaycast}>
          <lineBasicMaterial color={HOVER_COLOR} transparent opacity={0.55} depthTest={false} />
        </lineSegments>
      </group>
    </group>
  );
}

function FleetMesh({
  id,
  registry,
  geometry,
  material,
  capacity,
  castShadow = true,
}: {
  id: string;
  registry: Map<string, InstancedMesh>;
  geometry: BufferGeometry;
  material: Material;
  capacity: number;
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
      name={`linehaul-${id}`}
      args={[geometry, material, Math.max(1, capacity)]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled={false}
      raycast={noRaycast}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Sites: picking, outlines and labels

/** Invisible, ground-level pick volumes per site; clicking selects it, double-click flies there. */
function SitePicks({ sites }: { sites: SiteView[] }) {
  const select = useSimulation((s) => s.select);
  const selection = useSimulation((s) => s.selection);
  const requestSite = useView((s) => s.requestSite);
  const [hover, setHover] = useState<string | null>(null);
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const pickable = sites;
  const outlineFor = (id: string | null) => pickable.find((s) => s.id === id);
  const selected = selection?.kind === "site" ? outlineFor(selection.id) : undefined;
  const hovered = hover && hover !== selected?.id ? outlineFor(hover) : undefined;
  return (
    <group name="site-picks">
      {pickable.map((s) => (
        <mesh
          key={s.id}
          geometry={unit}
          material={PICK_MATERIAL}
          position={[
            (s.bounds.min.x + s.bounds.max.x) / 2,
            YARD_LEVEL + 0.05,
            (s.bounds.min.z + s.bounds.max.z) / 2,
          ]}
          scale={[s.bounds.max.x - s.bounds.min.x, 0.1, s.bounds.max.z - s.bounds.min.z]}
          onPointerMove={(e) => {
            e.stopPropagation();
            if (hover !== s.id) setHover(s.id);
          }}
          onPointerOut={() => setHover(null)}
          onClick={(e) => {
            e.stopPropagation();
            if (e.delta > 6) return;
            const same = selection?.kind === "site" && selection.id === s.id;
            select(same ? null : { kind: "site", id: s.id });
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            select({ kind: "site", id: s.id });
            requestSite(s.id);
          }}
        />
      ))}
      {selected && <SiteOutline site={selected} color={SELECT_COLOR} opacity={1} />}
      {hovered && <SiteOutline site={hovered} color={HOVER_COLOR} opacity={0.5} />}
    </group>
  );
}

function SiteOutline({ site, color, opacity }: { site: SiteView; color: Color; opacity: number }) {
  const geo = useMemo(() => {
    const g = new EdgesGeometry(new BoxGeometry(1, 1, 1));
    return g;
  }, []);
  const w = site.bounds.max.x - site.bounds.min.x;
  const d = site.bounds.max.z - site.bounds.min.z;
  return (
    <group
      position={[
        (site.bounds.min.x + site.bounds.max.x) / 2,
        YARD_LEVEL + 0.6,
        (site.bounds.min.z + site.bounds.max.z) / 2,
      ]}
    >
      <lineSegments geometry={geo} scale={[w, 1.2, d]} raycast={noRaycast}>
        <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={false} />
      </lineSegments>
    </group>
  );
}

/**
 * Moves the HUD's site labels (DOM, see SiteLabelsOverlay) to each site's projected anchor every
 * frame. Labels behind the camera, off screen or of the site in focus are hidden.
 */
function SiteLabelProjector({ sites }: { sites: SiteView[] }) {
  const anchors = useMemo(
    () =>
      sites.map((s) => ({
        id: s.id,
        v: new Vector3(
          (s.bounds.min.x + s.bounds.max.x) / 2,
          YARD_LEVEL + Math.max(8, ...s.buildings.map((b) => b.height)) + (s.containers ? 12 : 7),
          (s.bounds.min.z + s.bounds.max.z) / 2,
        ),
      })),
    [sites],
  );
  const p = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    const scope = useView.getState().scope;
    for (const a of anchors) {
      const el = siteLabelElement(a.id);
      if (!el) continue;
      p.copy(a.v).project(camera);
      const hidden =
        p.z > 1 ||
        Math.abs(p.x) > 1.05 ||
        Math.abs(p.y) > 1.05 ||
        (scope.kind === "site" && scope.siteId === a.id);
      el.style.visibility = hidden ? "hidden" : "visible";
      if (hidden) continue;
      const x = ((p.x + 1) / 2) * size.width;
      const y = ((1 - p.y) / 2) * size.height;
      el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  });
  return null;
}

/** Publish what the network layer draws, for tests (read-only). */
function NetworkDebug({
  config,
  sites,
  buildings,
}: {
  config: SimulationConfig;
  sites: SiteView[];
  buildings: number;
}) {
  const state = useSimulation((s) => s.state);
  useEffect(() => {
    const net = state.network;
    const containers: Record<string, number> = {};
    const floor: Record<string, number> = {};
    for (const s of sites) {
      const st = net?.sites[s.id];
      if (s.containers)
        containers[s.id] = Math.min(st?.containers ?? 0, containerSlots(s.containers).length);
      if (s.palletCapacity > 0 && st) floor[s.id] = floorPallets(config, s, st.stock).length;
    }
    publishSceneDebug({
      network: {
        sites: sites.map((s) => ({
          id: s.id,
          kind: s.kind,
          center: [
            (s.bounds.min.x + s.bounds.max.x) / 2,
            YARD_LEVEL,
            (s.bounds.min.z + s.bounds.max.z) / 2,
          ],
          bounds: s.bounds,
        })),
        buildings,
        roads: config.network?.roads.length ?? 0,
        containers,
        floorPallets: floor,
        linehaulDrawn: linehaulViews(config, undefined, state, 1).map((v) => v.id),
      },
    });
  }, [config, sites, buildings, state]);
  return null;
}
