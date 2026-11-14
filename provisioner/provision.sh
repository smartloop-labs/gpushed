#!/bin/bash
#
# provision ACTION BOX_ID     (ACTION: up | start | stop | down)
#
# Runs inside the provisioner image on GitHub Actions. Fetches the box's spec
# from the gpushed API, runs Terraform with state in R2, and reports the result
# back. Everything secret arrives through the environment:
#
#   GPUSHED_API, PROVISIONER_SECRET            the API and its shared secret
#   GOOGLE_APPLICATION_CREDENTIALS, GCP_PROJECT  GCP (Workload Identity or SA key)
#   GCP_SUBNETWORK                             subnet created by infra/bootstrap
#   R2_ENDPOINT, R2_STATE_BUCKET               Terraform state location
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   R2 API token
#
# Output is kept terse on purpose: workflow logs may be visible to others, so
# Terraform's own output (which includes IPs and keys) only goes to a file and
# is shown, filtered, on failure.

set -euo pipefail

ACTION="${1:-}"
BOX_ID="${2:-}"
case "$ACTION" in up|start|stop|down) ;; *) echo "usage: provision up|start|stop|down BOX_ID"; exit 2 ;; esac
[[ $BOX_ID =~ ^b[a-z0-9]{11}$ ]] || { echo "invalid box id"; exit 2; }
for v in GPUSHED_API PROVISIONER_SECRET GOOGLE_APPLICATION_CREDENTIALS GCP_PROJECT GCP_SUBNETWORK R2_ENDPOINT R2_STATE_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || { echo "missing environment variable $v"; exit 2; }
done

TF_DIR=/opt/gpushed/terraform
LOG=$(mktemp)
REPORTED=0

api() { # METHOD PATH [JSON]
  curl -fsS -X "$1" "$GPUSHED_API$2" -H "authorization: Bearer $PROVISIONER_SECRET" \
    -H "content-type: application/json" ${3:+--data "$3"}
}

report() { # ok(true|false) [ip] [zone] [error]
  local body
  body=$(jq -nc --arg a "$ACTION" --argjson ok "$1" --arg ip "${2:-}" --arg zone "${3:-}" --arg err "${4:-}" \
    '{action:$a, ok:$ok} + (if $ip != "" then {ip:$ip} else {} end) + (if $zone != "" then {zone:$zone} else {} end) + (if $err != "" then {error:$err} else {} end)')
  for i in 1 2 3 4 5; do
    api POST "/internal/boxes/$BOX_ID/report" "$body" >/dev/null && { REPORTED=1; return 0; }
    sleep $((i * 3))
  done
  echo "could not report result to the API"
  return 1
}

# Show the end of Terraform's log with addresses and keys blanked out.
show_log() {
  sed -E -e 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/x.x.x.x/g' -e 's/(ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+) [A-Za-z0-9+\/=]+/\1 <key>/g' "$LOG" | tail -40
}

on_exit() {
  local status=$?
  if [ $status -ne 0 ] && [ $REPORTED -eq 0 ]; then
    show_log || true
    report false "" "" "${FAIL_REASON:-$ACTION failed; the team has been notified}" || true
  fi
  rm -f "$LOG"
}
trap on_exit EXIT

echo "▶ $ACTION $BOX_ID"
SPEC=$(api GET "/internal/boxes/$BOX_ID")
REGION=$(jq -r .region <<<"$SPEC")
ZONE=$(jq -r '.zone // empty' <<<"$SPEC")
MACHINE=$(jq -r .machine_type <<<"$SPEC")
GPU_TYPE=$(jq -r .gpu_type <<<"$SPEC")
GPU_COUNT=$(jq -r .gpu_count <<<"$SPEC")

gcloud auth login --cred-file="$GOOGLE_APPLICATION_CREDENTIALS" --quiet >/dev/null 2>&1
gcloud config set project "$GCP_PROJECT" --quiet >/dev/null 2>&1

cd "$TF_DIR"
jq -n --argjson s "$SPEC" --arg project "$GCP_PROJECT" --arg subnet "$GCP_SUBNETWORK" '{
  project_id: $project, region: $s.region, zone: ($s.zone // ($s.region + "-a")),
  subnetwork: $subnet, box_id: $s.id, machine_type: $s.machine_type,
  gpu_type: $s.gpu_type, gpu_count: $s.gpu_count,
  ssh_user: $s.ssh_user, ssh_public_key: $s.ssh_public_key
}' > box.auto.tfvars.json

terraform init -input=false -reconfigure \
  -backend-config="bucket=$R2_STATE_BUCKET" \
  -backend-config="key=boxes/$BOX_ID.tfstate" \
  -backend-config="endpoints={s3=\"$R2_ENDPOINT\"}" >"$LOG" 2>&1

# Zones to try for a new box: every zone in the region offering the machine
# type (and GPU, when one is attached), in a shuffled order to spread load.
candidate_zones() {
  local zones gpu_zones
  zones=$(gcloud compute machine-types list --filter="name=$MACHINE AND zone~^$REGION-" \
    --format="value(zone.basename())" 2>/dev/null | sort -u)
  if [ "$GPU_COUNT" != "0" ]; then
    gpu_zones=$(gcloud compute accelerator-types list --filter="name=$GPU_TYPE AND zone~^$REGION-" \
      --format="value(zone.basename())" 2>/dev/null | sort -u)
    zones=$(comm -12 <(echo "$zones") <(echo "$gpu_zones"))
  fi
  echo "$zones" | grep -v '^$' | shuf || true
}

apply() { # ZONE STATUS
  terraform apply -input=false -auto-approve -var="zone=$1" -var="desired_status=$2" >>"$LOG" 2>&1
}

outputs_and_report() {
  local ip zone
  ip=$(terraform output -raw ip 2>/dev/null || true)
  zone=$(terraform output -raw zone 2>/dev/null || true)
  echo "::add-mask::$ip" 2>/dev/null || true
  report true "$ip" "$zone"
  echo "✔ $ACTION done${zone:+ in $zone}"
}

case "$ACTION" in
  up)
    ZONES=$(candidate_zones)
    [ -n "$ZONES" ] || { FAIL_REASON="no zone in $REGION offers $MACHINE"; exit 1; }
    for z in $ZONES; do
      echo "… trying $z"
      : >"$LOG"
      if apply "$z" RUNNING; then
        outputs_and_report
        exit 0
      fi
      if ! grep -qE 'STOCKOUT|ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources available|QUOTA_EXCEEDED|Quota .* exceeded' "$LOG"; then
        FAIL_REASON="could not create the box"
        exit 1
      fi
      echo "  no capacity in $z"
      # Remove whatever was half-created there before moving on.
      terraform destroy -input=false -auto-approve -var="zone=$z" >>"$LOG" 2>&1 || true
    done
    FAIL_REASON="no GPU capacity in $REGION right now; try again later or another plan"
    exit 1
    ;;
  start)
    FAIL_REASON="could not start the box (the zone may be out of GPU capacity; try again shortly)"
    apply "$ZONE" RUNNING
    outputs_and_report
    ;;
  stop)
    FAIL_REASON="could not stop the box"
    apply "$ZONE" TERMINATED
    report true "" "$ZONE"
    echo "✔ stop done"
    ;;
  down)
    FAIL_REASON="could not delete the box"
    terraform destroy -input=false -auto-approve -var="zone=${ZONE:-$REGION-a}" >>"$LOG" 2>&1
    report true
    echo "✔ down done"
    ;;
esac
