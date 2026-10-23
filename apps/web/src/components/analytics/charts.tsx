"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Small SVG charts for the analytics dashboard, following the data-viz rules: thin marks with
 * rounded data-ends on a single baseline, hairline recessive grid, at most three series in the
 * validated categorical order, a legend for two or more series, labels in text colours (never the
 * series colour), a hover tooltip on every mark, and a table view of the same numbers.
 */

/** Categorical slots validated against the panel surface #11151b (dark): blue, orange, aqua. */
export const SERIES = ["#3987e5", "#d95926", "#199e70"] as const;
const GRID = "#252d38";
const AXIS = "#343e4b";
const MUTED = "#8d98a6";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A clean upper bound and ticks for a count axis. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

const fmt = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K` : String(v);

export interface Series {
  name: string;
  values: readonly number[];
}

interface ChartProps {
  title: string;
  subtitle?: string;
  /** X labels (simulated clock), one per point. */
  labels: readonly string[];
  series: readonly Series[];
  kind: "columns" | "lines";
  unit: string;
  testid: string;
}

/**
 * A time chart over the window's buckets. One series → columns or a line, no legend (the title
 * names it); two or three → lines with a legend.
 */
export function TimeChart({ title, subtitle, labels, series, kind, unit, testid }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const height = 168;
  const pad = { l: 36, r: 8, t: 8, b: 22 };
  const n = labels.length;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 1;
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const band = n ? iw / n : 0;
  const x = (i: number) => pad.l + band * (i + 0.5);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const bar = Math.max(1, Math.min(24, band - 2));
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 64))));
  const only = series.length === 1 ? series[0] : undefined;

  return (
    <figure className="panel p-4" data-testid={testid}>
      <figcaption className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fog-50">{title}</p>
          {subtitle && <p className="mt-0.5 text-[11px] text-fog-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={() => setTable(!table)}
          className="shrink-0 rounded-md px-2 py-0.5 text-[11px] text-fog-400 hover:bg-white/5 hover:text-fog-200"
          aria-pressed={table}
          data-testid={`${testid}-table-toggle`}
        >
          {table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {series.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-3 text-[11px] text-fog-200" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span
                className="h-0.5 w-3 rounded-full"
                style={{ background: SERIES[i] }}
                aria-hidden
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {table ? (
        <div className="mt-2 max-h-56 overflow-auto">
          <table
            className="w-full text-left text-[11px] tabular-nums"
            data-testid={`${testid}-table`}
          >
            <thead className="text-fog-400">
              <tr>
                <th className="py-1 font-medium">Simulated time</th>
                {series.map((s) => (
                  <th key={s.name} className="py-1 text-right font-medium">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-fog-200">
              {labels.map((l, i) => (
                <tr key={l} className="border-t border-white/5">
                  <td className="py-0.5">{l}</td>
                  {series.map((s) => (
                    <td key={s.name} className="py-0.5 text-right">
                      {s.values[i]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative mt-2" style={{ height }}>
          {width > 0 && (
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={`${title}, ${unit} per bucket`}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line
                    x1={pad.l}
                    x2={width - pad.r}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={t === 0 ? AXIS : GRID}
                    strokeWidth={1}
                  />
                  <text
                    x={pad.l - 6}
                    y={y(t)}
                    dy="0.32em"
                    textAnchor="end"
                    fontSize={10}
                    fill={MUTED}
                    className="tabular-nums"
                  >
                    {fmt(t)}
                  </text>
                </g>
              ))}
              {labels.map((l, i) =>
                i % labelEvery === 0 ? (
                  <text
                    key={l}
                    x={x(i)}
                    y={height - 6}
                    textAnchor="middle"
                    fontSize={10}
                    fill={MUTED}
                  >
                    {l}
                  </text>
                ) : null,
              )}
              {hover !== null && (
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={pad.t}
                  y2={pad.t + ih}
                  stroke={AXIS}
                  strokeWidth={1}
                />
              )}
              {kind === "columns" && only
                ? only.values.map((v, i) => {
                    const h = Math.max(v > 0 ? 1 : 0, (v / top) * ih);
                    const r = Math.min(4, bar / 2, h);
                    const x0 = x(i) - bar / 2;
                    const y0 = pad.t + ih - h;
                    // Rounded data-end, square at the baseline.
                    const d = `M${x0},${pad.t + ih} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bar - r} Q${x0 + bar},${y0} ${x0 + bar},${y0 + r} V${pad.t + ih} Z`;
                    return h > 0 ? (
                      <path
                        key={labels[i]}
                        d={d}
                        fill={SERIES[0]}
                        opacity={hover === null || hover === i ? 1 : 0.55}
                      />
                    ) : null;
                  })
                : series.map((s, si) => (
                    <g key={s.name}>
                      <polyline
                        points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
                        fill="none"
                        stroke={SERIES[si]}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                      {hover !== null && (
                        <circle
                          cx={x(hover)}
                          cy={y(s.values[hover] ?? 0)}
                          r={4}
                          fill={SERIES[si]}
                          stroke="#11151b"
                          strokeWidth={2}
                        />
                      )}
                    </g>
                  ))}
              {/* Hit targets: one full-height band per bucket (larger than any mark). */}
              {labels.map((l, i) => (
                <rect
                  key={l}
                  x={pad.l + band * i}
                  y={pad.t}
                  width={band}
                  height={ih}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  data-testid={`${testid}-bucket`}
                />
              ))}
            </svg>
          )}
          {hover !== null && width > 0 && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-0 z-10 rounded-md border border-white/10 bg-ink-800 px-2 py-1 text-[11px] shadow-lg"
              style={{ left: Math.min(Math.max(0, x(hover) - 60), width - 130) }}
              data-testid={`${testid}-tooltip`}
            >
              <p className="text-fog-400">{labels[hover]} (simulated)</p>
              {series.map((s, i) => (
                <p key={s.name} className="flex items-center gap-1.5 text-fog-50 tabular-nums">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: SERIES[i] }}
                    aria-hidden
                  />
                  {s.name}: {s.values[hover]}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars of one measure (single series: no legend), value at the tip, table toggle. */
export function BarList({
  title,
  subtitle,
  rows,
  unit,
  testid,
  format = (v: number) => v.toLocaleString("en-US"),
}: {
  title: string;
  subtitle?: string;
  rows: readonly { key: string; label?: string; value: number; note?: string }[];
  unit: string;
  testid: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="panel p-4" data-testid={testid}>
      <figcaption>
        <p className="text-sm font-semibold text-fog-50">{title}</p>
        {subtitle && <p className="mt-0.5 text-[11px] text-fog-400">{subtitle}</p>}
      </figcaption>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-fog-500">Nothing in this window.</p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label={`${title} (${unit})`}>
          {rows.map((r) => (
            <li
              key={r.key}
              className="group text-[11px]"
              data-testid={`${testid}-row`}
              data-key={r.key}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-fog-200" title={r.label ?? r.key}>
                  {r.label ?? r.key}
                </span>
                <span className="shrink-0 text-fog-50 tabular-nums" data-testid={`${testid}-value`}>
                  {format(r.value)}
                  {r.note && <span className="ml-1 text-fog-400">{r.note}</span>}
                </span>
              </div>
              <div
                className="mt-1 h-2 rounded-full bg-ink-800"
                title={`${r.label ?? r.key}: ${format(r.value)} ${unit}`}
              >
                <div
                  className="h-2 rounded-r-full transition-[width]"
                  style={{ width: `${(r.value / max) * 100}%`, background: SERIES[0] }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
