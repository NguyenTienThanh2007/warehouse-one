"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import type { Color } from "three";
import {
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
} from "three";

export interface InstanceSpec {
  position: readonly [number, number, number];
  /** Euler rotation (XYZ order unless `order` is given). */
  rotation?: readonly [number, number, number];
  order?: "XYZ" | "YXZ";
  scale?: readonly [number, number, number];
  color?: Color;
}

const noRaycast = () => null;

/**
 * An instanced mesh whose transforms are rebuilt whenever `instances` changes. `capacity` lets the
 * buffer be allocated once for the maximum count so inventory changes never reallocate GPU memory.
 */
export function Instances({
  geometry,
  material,
  instances,
  capacity,
  castShadow = true,
  receiveShadow = true,
  name,
}: {
  geometry: BufferGeometry;
  material: Material;
  instances: readonly InstanceSpec[];
  capacity?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  name?: string;
}) {
  const ref = useRef<InstancedMesh>(null);
  const max = Math.max(1, capacity ?? instances.length);
  const scratch = useMemo(
    () => ({
      m: new Matrix4(),
      q: new Quaternion(),
      e: new Euler(),
      p: new Vector3(),
      s: new Vector3(),
    }),
    [],
  );

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const { m, q, e, p, s } = scratch;
    const n = Math.min(instances.length, max);
    for (let i = 0; i < n; i++) {
      const inst = instances[i] as InstanceSpec;
      p.set(...inst.position);
      e.set(...(inst.rotation ?? [0, 0, 0]), inst.order ?? "XYZ");
      q.setFromEuler(e);
      s.set(...(inst.scale ?? [1, 1, 1]));
      mesh.setMatrixAt(i, m.compose(p, q, s));
      if (inst.color) mesh.setColorAt(i, inst.color);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [instances, max, scratch]);

  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geometry, material, max]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      // Picking uses dedicated pick volumes; skip per-instance raycasts on detailed meshes.
      raycast={noRaycast}
      frustumCulled={false}
    />
  );
}
