"""Deterministic event identity, ported from packages/simulation/src/hash.ts.

The simulation derives every `event_id` from `(simulation_id, sequence)` with cyrb128 and formats
it as an RFC 9562 version-8 UUID. Recomputing it here lets the API reject events whose ID does not
belong to their position in the run (forged, corrupted or re-sequenced events). The port mirrors
JavaScript semantics exactly: `charCodeAt` (UTF-16 code units), `Math.imul` (32-bit wrapping
multiply) and `>>>` (unsigned shift). tests/test_identity.py checks it against the TypeScript
fixtures.
"""

_MASK = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """JavaScript Math.imul: 32-bit two's-complement product, returned as an unsigned value."""
    return (a * b) & _MASK


def _utf16_units(text: str) -> list[int]:
    data = text.encode("utf-16-le")
    return [int.from_bytes(data[i : i + 2], "little") for i in range(0, len(data), 2)]


def cyrb128(text: str) -> tuple[int, int, int, int]:
    h1, h2, h3, h4 = 1779033703, 3144134277, 1013904242, 2773480762
    for k in _utf16_units(text):
        h1 = h2 ^ _imul(h1 ^ k, 597399067)
        h2 = h3 ^ _imul(h2 ^ k, 2869860233)
        h3 = h4 ^ _imul(h3 ^ k, 951274213)
        h4 = h1 ^ _imul(h4 ^ k, 2716044179)
    h1 = _imul(h3 ^ (h1 >> 18), 597399067)
    h2 = _imul(h4 ^ (h2 >> 22), 2869860233)
    h3 = _imul(h1 ^ (h3 >> 17), 951274213)
    h4 = _imul(h2 ^ (h4 >> 19), 2716044179)
    h1 ^= h2 ^ h3 ^ h4
    h2 ^= h1
    h3 ^= h1
    h4 ^= h1
    return h1 & _MASK, h2 & _MASK, h3 & _MASK, h4 & _MASK


def deterministic_uuid(namespace: str, sequence: int) -> str:
    """The event_id the simulation assigns to `sequence` in run `namespace` (its simulation_id)."""
    h = "".join(f"{part:08x}" for part in cyrb128(f"{namespace}:{sequence}"))
    variant = format((int(h[16], 16) & 0x3) | 0x8, "x")
    return f"{h[0:8]}-{h[8:12]}-8{h[13:16]}-{variant}{h[17:20]}-{h[20:32]}"
