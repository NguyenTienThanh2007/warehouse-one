#!/usr/bin/env bash
# End-to-end proof of the Phase 3 data platform (docs/phases/PHASE_3.md §H).
#
# Needs the full stack running and healthy:
#   docker compose --profile data up -d --build --wait
#   scripts/data-platform-smoke.sh
#
# Every step checks real state (API, PostgreSQL via the pipeline CLI, Kafka consumers, Parquet in
# MinIO read through DuckDB, Airflow DAG runs) and the script exits non-zero on the first failure.
# It records new runs and adds reports; it never deletes data except one bronze object it removes
# on purpose (step 10) and restores from PostgreSQL. It stops and restarts Kafka, MinIO and the
# pipeline services of the Compose project it is pointed at.
#
# Environment: API_PORT (8000) or API_URL; COMPOSE_PROJECT_NAME / COMPOSE_FILE / --env-file via
# SMOKE_COMPOSE_ARGS (e.g. "-p w1-p3dev --env-file /path/to/ports.env").
set -euo pipefail

cd "$(dirname "$0")/.."
read -r -a EXTRA <<<"${SMOKE_COMPOSE_ARGS:-}"
COMPOSE=(docker compose "${EXTRA[@]}" --profile data)
API_URL="${API_URL:-http://localhost:${API_PORT:-8000}}"
STARTED=$(date +%s)
CHECKS=0

step() { printf '\n▶ %s\n' "$*"; }
ok() {
  CHECKS=$((CHECKS + 1))
  printf '  ✓ %s\n' "$*"
}
die() {
  printf '  ✗ %s\n' "$*" >&2
  exit 1
}
pipeline() { "${COMPOSE[@]}" exec -T relay warehouse-pipeline "$@" 2>/dev/null; }
airflow() { "${COMPOSE[@]}" exec -T airflow airflow "$@" 2>/dev/null; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }
status() { pipeline status --simulation "$1"; }

# wait_until <description> <timeout_s> <command...>: retry the command until it succeeds.
wait_until() {
  local what=$1 timeout=$2 deadline
  shift 2
  deadline=$(($(date +%s) + timeout))
  until "$@" >/dev/null 2>&1; do
    [[ $(date +%s) -lt $deadline ]] || die "timed out after ${timeout}s waiting for: $what"
    sleep 2
  done
}

healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q "$1")") == healthy ]]; }

record() {
  pnpm --silent sim:record --api "$API_URL" "$@" | tail -1
}

expect_counts() { # <sim> <python condition on d>
  [[ $(status "$1" | field "$2") == True ]]
}

relay_unhealthy() { ! pipeline health relay --max-age 30 >/dev/null; }

# run_dag <dag> <expected state> [conf]: trigger, wait for a terminal state, compare.
run_dag() {
  local dag=$1 want=$2 conf=${3:-'{"settle_s": 0}'} run_id state deadline
  run_id="smoke-$(date +%s)-$RANDOM"
  airflow dags unpause "$dag" >/dev/null
  airflow dags trigger "$dag" --run-id "$run_id" --conf "$conf" >/dev/null || die "could not trigger $dag"
  deadline=$(($(date +%s) + 900))
  while :; do
    state=$(airflow dags list-runs "$dag" -o json |
      python3 -c "import json,sys; print(next((r['state'] for r in json.load(sys.stdin) if r['run_id']=='$run_id'), 'missing'))")
    [[ $state == success || $state == failed ]] && break
    [[ $(date +%s) -lt $deadline ]] || die "$dag run $run_id still $state after 15 min"
    sleep 5
  done
  airflow dags pause "$dag" >/dev/null
  [[ $state == "$want" ]] || die "$dag run $run_id ended $state, expected $want"
  ok "Airflow $dag → $state ($run_id)"
}

step "0. Stack health (each check exercises the service, not just its process)"
for svc in postgres api kafka minio relay consumer-ledger consumer-bronze airflow; do
  healthy "$svc" || die "$svc is not healthy"
done
curl -fsS "$API_URL/health/ready" | grep -q '"ready"' || die "API is not ready"
ok "postgres, api, kafka, minio, relay, consumers and airflow healthy"

step "1. Record a run through the API (operations-demo script, 6,000 ticks)"
A=$(record --scenario empty --script operations-demo --ticks 6000)
SIM_A=$(echo "$A" | field "d['simulation_id']")
EVENTS_A=$(echo "$A" | field "d['events']")
[[ $EVENTS_A -gt 100 ]] || die "recorder sent only $EVENTS_A events"
ok "run $SIM_A recorded: $EVENTS_A events, $(echo "$A" | field "d['commands']") commands"

step "2. Durable, atomic storage and replay verification"
RUN=$(curl -fsS "$API_URL/api/v1/simulations/$SIM_A")
[[ $(echo "$RUN" | field "d['event_count']") == "$EVENTS_A" ]] || die "event_count mismatch"
[[ $(echo "$RUN" | field "d['outbox']['pending'] + d['outbox']['published']") == "$EVENTS_A" ]] ||
  die "one outbox row per event expected"
pnpm --silent sim:verify --api "$API_URL" --simulation "$SIM_A" | tail -1 | grep -q '"ok":true' ||
  die "stored run does not replay to identical events"
ok "events, commands and outbox rows stored; replay in the engine reproduces every event"

step "3. Outbox delivered to Kafka"
wait_until "outbox drained" 120 expect_counts "$SIM_A" "d['outbox_unpublished'] == 0"
ok "no unpublished outbox rows"

step "4. Consumers processed every event once; real Parquet in MinIO"
wait_until "ledger and bronze caught up" 180 expect_counts "$SIM_A" \
  "d['ledger_events'] == $EVENTS_A and d['bronze_distinct_events'] == $EVENTS_A"
S=$(status "$SIM_A")
[[ $(echo "$S" | field "d['dead_letters'] + d['data_quality_issues']") == 0 ]] || die "unexpected DLQ/issues: $S"
[[ $(echo "$S" | field "d['bronze_rows']") == "$EVENTS_A" ]] || die "bronze rows != events"
ok "ledger $EVENTS_A, bronze $EVENTS_A rows in $(echo "$S" | field "d['bronze_objects_total']") Parquet objects (read back with DuckDB)"

step "5. Airflow: dbt silver/gold + reconciliation"
run_dag warehouse_lake_refresh success
S=$(status "$SIM_A")
[[ $(echo "$S" | field "d['gold_events']") == "$EVENTS_A" ]] || die "gold events != source: $S"
[[ $(echo "$S" | field "d['latest_reconciliation']['status']") == passed ]] || die "reconciliation did not pass"
ok "gold has $EVENTS_A events for the run; reconciliation passed"

step "6. Temporary Kafka outage: events stay durable, then flow"
"${COMPOSE[@]}" stop kafka >/dev/null
B=$(record --scenario showcase --ticks 1500)
SIM_B=$(echo "$B" | field "d['simulation_id']")
EVENTS_B=$(echo "$B" | field "d['events']")
expect_counts "$SIM_B" "d['outbox_unpublished'] == $EVENTS_B and d['ledger_events'] == 0" ||
  die "events should be stored and unpublished while Kafka is down"
wait_until "relay reports Kafka unreachable" 90 relay_unhealthy
ok "API accepted $EVENTS_B events with Kafka down; relay reports degraded"
"${COMPOSE[@]}" start kafka >/dev/null
wait_until "kafka healthy" 180 healthy kafka
wait_until "run B delivered and consumed" 240 expect_counts "$SIM_B" \
  "d['outbox_unpublished'] == 0 and d['ledger_events'] == $EVENTS_B and d['bronze_distinct_events'] == $EVENTS_B"
ok "after Kafka returned, all $EVENTS_B events were published and consumed"

step "7. Temporary object-store outage: bronze waits, nothing is dead-lettered"
"${COMPOSE[@]}" stop minio >/dev/null
C=$(record --scenario empty --script operations-demo --ticks 1500)
SIM_C=$(echo "$C" | field "d['simulation_id']")
EVENTS_C=$(echo "$C" | field "d['events']")
wait_until "ledger processed run C while MinIO is down" 120 expect_counts "$SIM_C" \
  "d['ledger_events'] == $EVENTS_C and d['lake_error'] is not None"
"${COMPOSE[@]}" start minio >/dev/null
wait_until "minio healthy" 120 healthy minio
wait_until "bronze caught up after the outage" 240 expect_counts "$SIM_C" \
  "d['bronze_distinct_events'] == $EVENTS_C and d['dead_letters'] == 0"
ok "ledger kept going; bronze retried and caught up ($EVENTS_C events) with no dead letters"

step "8. Duplicate delivery (explicit replay of run A): no double counting"
pipeline replay --simulation "$SIM_A" >/dev/null
wait_until "replayed copies consumed" 180 expect_counts "$SIM_A" \
  "d['ledger_deliveries'] == 2 * $EVENTS_A and d['bronze_rows'] == 2 * $EVENTS_A"
expect_counts "$SIM_A" "d['ledger_events'] == $EVENTS_A and d['bronze_distinct_events'] == $EVENTS_A" ||
  die "duplicates changed distinct counts"
run_dag warehouse_lake_refresh success
expect_counts "$SIM_A" "d['gold_events'] == $EVENTS_A" || die "gold double-counted the replay"
ok "every event delivered twice: ledger and gold still count $EVENTS_A; bronze kept both copies"

step "9. Restart the relay and consumers: processing resumes"
"${COMPOSE[@]}" restart relay consumer-ledger consumer-bronze >/dev/null
for svc in relay consumer-ledger consumer-bronze; do wait_until "$svc healthy" 120 healthy "$svc"; done
D=$(record --scenario empty --script operations-demo --ticks 800)
SIM_D=$(echo "$D" | field "d['simulation_id']")
EVENTS_D=$(echo "$D" | field "d['events']")
wait_until "run D consumed after restart" 180 expect_counts "$SIM_D" \
  "d['ledger_events'] == $EVENTS_D and d['bronze_distinct_events'] == $EVENTS_D"
expect_counts "$SIM_A" "d['ledger_events'] == $EVENTS_A" || die "restart re-counted run A"
ok "after restarts, new run D ($EVENTS_D events) processed and run A unchanged"

step "10. Injected discrepancy is reported, then repaired by the backfill DAG"
KEY=$("${COMPOSE[@]}" exec -T relay python -c "
from warehouse_pipeline.lake import list_objects, delete_object
from warehouse_pipeline.settings import get_pipeline_settings as g
s = g(); key = sorted(k for k in list_objects(s) if 'part-' in k)[0]; delete_object(s, key); print(key)" 2>/dev/null)
ok "deleted bronze object $KEY"
run_dag warehouse_reconciliation failed
S=$(status "$SIM_A")
[[ $(echo "$S" | field "d['latest_reconciliation']['status']") == failed ]] || die "discrepancy not reported"
echo "$S" | field "[v['check'] for v in d['latest_reconciliation']['violations']]" | grep -q missing_in_bronze ||
  die "missing_in_bronze not among the violations"
ok "reconciliation failed with missing_in_bronze, as it must"
DAY=$(curl -fsS "$API_URL/api/v1/simulations/$SIM_A/events?limit=1" | field "d['events'][0]['occurred_at'][:10]")
run_dag warehouse_lake_backfill success "{\"start_date\": \"$DAY\", \"end_date\": \"$DAY\", \"settle_s\": 0}"
[[ $(status "$SIM_A" | field "d['latest_reconciliation']['status']") == passed ]] || die "backfill did not repair"
ok "backfill rebuilt bronze for $DAY from PostgreSQL; reconciliation passed again"

printf '\n✅ Data-platform smoke test passed: %s checks in %ss\n' "$CHECKS" "$(($(date +%s) - STARTED))"
