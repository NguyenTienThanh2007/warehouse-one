import type { NetworkConfig, SiteConfig } from "./model";

/**
 * Fleet standby (Phase 6): an idle line-haul truck can wait on a staging stall at a site instead of
 * driving back to its home stall at the depot. Pure rules shared by the command handler, the
 * invariants and the optimiser (`@warehouse-one/twin`).
 */

const stagingStalls = (site: SiteConfig) => site.stands.filter((s) => s.kind === "staging").length;

/**
 * Trucks that may stand by at a site: its staging stalls minus one, which always stays free for
 * trucks arriving with work (they reserve a stall when no door is free).
 */
export function standbyCapacity(net: NetworkConfig, siteId: string): number {
  const site = net.sites.find((s) => s.id === siteId);
  if (!site || site.kind === "gateway" || site.kind === "fleet_depot") return 0;
  return Math.max(0, stagingStalls(site) - 1);
}

/** Why trucks cannot stand by at a site, or null when they can. */
export function standbyProblem(net: NetworkConfig, siteId: string): string | null {
  const site = net.sites.find((s) => s.id === siteId);
  if (!site) return `unknown site '${siteId}'`;
  if (site.kind === "fleet_depot")
    return `trucks wait at '${site.name}' on their home stall: clear the standby site instead`;
  if (site.kind === "gateway") return `'${site.name}' has no stalls to wait on`;
  if (standbyCapacity(net, siteId) === 0)
    return `'${site.name}' needs at least two staging stalls (one always stays free)`;
  return null;
}

/** Sites where trucks can stand by, in config order. */
export function standbySites(net: NetworkConfig): SiteConfig[] {
  return net.sites.filter((s) => standbyProblem(net, s.id) === null);
}
