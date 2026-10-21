import type { TickDraft } from "../draft";
import { Cow } from "../ops/ops-draft";
import type { SimulationConfig } from "../types";
import {
  formatTransferId,
  type LinehaulState,
  type NetworkConfig,
  type NetworkState,
  type SiteConfig,
  type SiteState,
  type StandConfig,
  type TransferState,
} from "./model";
import { roadGraph, type RoadGraph } from "./roads";

/** Lookup tables derived once per network config. */
export interface NetworkIndex {
  readonly sites: ReadonlyMap<string, SiteConfig>;
  readonly stands: ReadonlyMap<string, { readonly site: SiteConfig; readonly stand: StandConfig }>;
  readonly primary: SiteConfig;
  readonly graph: RoadGraph;
}

const indexCache = new WeakMap<NetworkConfig, NetworkIndex>();

export function networkIndex(config: SimulationConfig): NetworkIndex {
  const net = config.network;
  if (!net) throw new Error("invariant violated: network index of a config without a network");
  let idx = indexCache.get(net);
  if (!idx) {
    const sites = new Map(net.sites.map((s) => [s.id, s]));
    const stands = new Map<string, { site: SiteConfig; stand: StandConfig }>();
    for (const site of net.sites)
      for (const stand of site.stands) stands.set(stand.id, { site, stand });
    const primary = sites.get(net.primary_site);
    if (!primary) throw new Error(`invariant violated: unknown primary site ${net.primary_site}`);
    idx = { sites, stands, primary, graph: roadGraph(config) };
    indexCache.set(net, idx);
  }
  return idx;
}

/** Working copy of the network state for one tick (copy-on-write, like `OpsDraft`). */
export class NetworkDraft {
  readonly sites: Cow<SiteState>;
  readonly vehicles: Cow<LinehaulState>;
  readonly transfers: Cow<TransferState>;
  readonly config: NetworkConfig;
  readonly index: NetworkIndex;
  private nextTransfer: number;

  constructor(
    readonly draft: TickDraft,
    base: NetworkState,
  ) {
    this.config = draft.config.network as NetworkConfig;
    this.index = networkIndex(draft.config);
    this.sites = new Cow(base.sites);
    this.vehicles = new Cow(base.vehicles);
    this.transfers = new Cow(base.transfers);
    this.nextTransfer = base.next_transfer;
  }

  get tick(): number {
    return this.draft.tick;
  }

  get graph(): RoadGraph {
    return this.index.graph;
  }

  newTransferId(): string {
    this.nextTransfer += 1;
    return formatTransferId(this.nextTransfer);
  }

  site(id: string): SiteState {
    const s = this.sites.get(id);
    if (!s) throw new Error(`invariant violated: unknown site ${id}`);
    return s;
  }

  vehicle(id: string): LinehaulState {
    const v = this.vehicles.get(id);
    if (!v) throw new Error(`invariant violated: unknown line-haul truck ${id}`);
    return v;
  }

  commit(): NetworkState {
    return {
      sites: this.sites.snapshot(),
      vehicles: this.vehicles.snapshot(),
      transfers: this.transfers.snapshot(),
      next_transfer: this.nextTransfer,
    };
  }
}
