"""Canonical JSON: the byte representation used for hashing, duplicate detection and Kafka values.

Sorted keys, no insignificant whitespace, UTF-8. Two JSON values are equal exactly when their
canonical bytes are equal, so a retried event with identical content hashes identically and a
conflicting one (same identity, different content) does not.
"""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def simulated_timestamp(epoch: datetime, simulation_time_ms: int) -> str:
    """`occurred_at` exactly as the simulation formats it: UTC, millisecond precision, `Z`."""
    moment = epoch.astimezone(UTC) + timedelta(milliseconds=simulation_time_ms)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"
