#!/bin/bash
#
# provision-worker     (the entrypoint of the gpushed-provisioner Cloud Run job)
#
# The API queues each provisioner run in D1 and starts an execution of this
# job with no arguments. Take queued runs from the API one by one, running
# `provision ACTION BOX_ID` for each, until there's nothing left this
# execution may take. A run of a box that already has one going waits for it:
# the execution running that box takes it next, so runs of one box stay in
# order.
#
# GCP credentials come from the job's service account (metadata server);
# GPUSHED_API, PROVISIONER_SECRET, GCP_PROJECT and the R2 settings from the
# job's environment and Secret Manager (infra/bootstrap).

set -uo pipefail

for v in GPUSHED_API PROVISIONER_SECRET; do
  [ -n "${!v:-}" ] || { echo "missing environment variable $v"; exit 2; }
done

api() { # METHOD PATH JSON
  curl -fsS -m 20 -X "$1" "$GPUSHED_API$2" -H "authorization: Bearer $PROVISIONER_SECRET" \
    -H "content-type: application/json" --data "$3"
}

claim() {
  local i out
  for i in 1 2 3; do
    if out=$(api POST /internal/jobs/claim "$(jq -nc --arg e "${CLOUD_RUN_EXECUTION:-}" '{execution:$e}')"); then
      printf '%s' "$out"
      return 0
    fi
    sleep $((i * 2))
  done
  return 1
}

# Tell the API every box VM's actual status, from GCP (POST /internal/reconcile):
# a Spot box Google reclaimed without its shutdown hook reaching the API is
# still "running" there. The time is taken before listing, so the API can
# ignore boxes that changed after it.
reconcile() {
  local listed_at list
  listed_at=$(date +%s)
  list=$(gcloud compute instances list --project "$GCP_PROJECT" --filter="labels.gpushed=box" \
    --format=json 2>/dev/null) || { echo "could not list instances"; return 1; }
  echo "… $(jq length <<<"$list") box VMs"
  api POST /internal/reconcile "$(jq -c --argjson t "$listed_at" \
    '{listed_at: $t, instances: [.[] | {box_id: .labels.box_id, status}]}' <<<"$list")" \
    | jq -r 'if (.reclaimed | length) > 0 then "✔ marked reclaimed: \(.reclaimed | join(", "))" else "✔ all in step" end'
}

runs=0
# A worker never takes more than a handful in a row: the job's 30-minute
# timeout covers the whole execution, and later runs get their own.
while [ $runs -lt 3 ]; do
  JOB=$(claim) || { echo "could not reach the API"; exit 1; }
  [ -n "$JOB" ] || break # nothing to do (204)
  ID=$(jq -r .id <<<"$JOB")
  ACTION=$(jq -r .action <<<"$JOB")
  BOX_ID=$(jq -r .box_id <<<"$JOB")
  runs=$((runs + 1))

  case "$ACTION" in
    up|start)
      api POST "/internal/boxes/$BOX_ID/progress" '{"message":"provisioning worker started"}' >/dev/null 2>&1 || true ;;
  esac
  if [ "$ACTION" = reconcile ]; then
    if reconcile; then ok=true; else ok=false; fi
  elif provision "$ACTION" "$BOX_ID"; then ok=true; else ok=false; fi
  api POST "/internal/jobs/$ID/done" "{\"ok\":$ok}" >/dev/null 2>&1 \
    || echo "could not mark job $ID done (it will expire)"
done
[ $runs -gt 0 ] || echo "nothing to do"
