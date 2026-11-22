#!/bin/bash
#
# provision ACTION BOX_ID     (ACTION: up | start | stop | down)
#
# Runs inside the provisioner image: on Cloud Run (started by provision-worker,
# worker.sh) or on GitHub Actions (provision.yml). Fetches the box's spec
# from the gpushed API, runs Terraform with state in R2, and reports the result
# back. Everything secret arrives through the environment:
#
#   GPUSHED_API, PROVISIONER_SECRET            the API and its shared secret
#   GCP_PROJECT                                our GCP project
#   GOOGLE_APPLICATION_CREDENTIALS             optional: a credentials file (Workload
#                                              Identity or SA key); on Cloud Run the
#                                              job's service account is used instead
#   R2_ENDPOINT, R2_STATE_BUCKET               Terraform state location
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   R2 API token
#
# Output is kept terse on purpose: logs may be visible to others (GitHub
# Actions logs of a public repo), so
# Terraform's own output (which includes IPs and keys) only goes to a file and
# is shown, filtered, on failure.

set -euo pipefail

ACTION="${1:-}"
BOX_ID="${2:-}"
case "$ACTION" in up|start|stop|down) ;; *) echo "usage: provision up|start|stop|down BOX_ID"; exit 2 ;; esac
[[ $BOX_ID =~ ^b[a-z0-9]{11}$ ]] || { echo "invalid box id"; exit 2; }
for v in GPUSHED_API PROVISIONER_SECRET GCP_PROJECT R2_ENDPOINT R2_STATE_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || { echo "missing environment variable $v"; exit 2; }
done

TF_DIR=/opt/gpushed/terraform
LOG=$(mktemp)
REPORTED=0

api() { # METHOD PATH [JSON]
  curl -fsS -m 20 -X "$1" "$GPUSHED_API$2" -H "authorization: Bearer $PROVISIONER_SECRET" \
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

# Tell the API what we're doing (the CLI shows it), and optionally that a
# zone just ran out of capacity. Best effort: never fails the run.
progress() { # MESSAGE [STOCKOUT_ZONE]
  echo "… $1"
  api POST "/internal/boxes/$BOX_ID/progress" \
    "$(jq -nc --arg m "$1" --arg z "${2:-}" '{message:$m} + (if $z != "" then {stockout_zone:$z} else {} end)')" \
    >/dev/null 2>&1 || true
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
REGIONS=$(jq -r '(.regions // [.region])[]' <<<"$SPEC") # nearest first
ZONE=$(jq -r '.zone // empty' <<<"$SPEC")
MACHINE=$(jq -r .machine_type <<<"$SPEC")
GPU_TYPE=$(jq -r .gpu_type <<<"$SPEC")
GPU_COUNT=$(jq -r .gpu_count <<<"$SPEC")
GPU_NAME=$(jq -r '.plan // "gpu"' <<<"$SPEC" | tr '[:lower:]' '[:upper:]') # l4 -> L4
AVOID=" $(jq -r '(.avoid_zones // []) | join(" ")' <<<"$SPEC") "
KNOWN_ZONES=$(jq -r '(.zones // [])[]' <<<"$SPEC") # from the API's zone table

if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  gcloud auth login --cred-file="$GOOGLE_APPLICATION_CREDENTIALS" --quiet >/dev/null 2>&1
fi # else: the metadata server's service account (Cloud Run), for gcloud and Terraform alike
gcloud config set project "$GCP_PROJECT" --quiet >/dev/null 2>&1

case "$ACTION" in up|start) progress "getting ready to talk to Google Cloud" ;; esac

cd "$TF_DIR"
# One Cloud Run execution may run several jobs in turn: start clean.
rm -f box.auto.tfvars.json image.auto.tfvars.json
# Each region has a subnet named gpushed-<region> (infra/bootstrap); region,
# zone and subnetwork are passed per apply since a new box may try several.
jq -n --argjson s "$SPEC" --arg project "$GCP_PROJECT" --arg api "$GPUSHED_API" '{
  project_id: $project, box_id: $s.id, machine_type: $s.machine_type,
  gpu_type: $s.gpu_type, gpu_count: $s.gpu_count, spot: ($s.spot // false),
  ssh_user: $s.ssh_user, ssh_public_key: $s.ssh_public_key,
  api_url: $api, idle_token: ($s.idle_token // ""), idle_minutes: ($s.idle_minutes // 5)
}' > box.auto.tfvars.json

terraform init -input=false -reconfigure \
  -backend-config="bucket=$R2_STATE_BUCKET" \
  -backend-config="key=boxes/$BOX_ID.tfstate" \
  -backend-config="endpoints={s3=\"$R2_ENDPOINT\"}" >"$LOG" 2>&1

# Every zone offering the machine type (and GPU, when one is attached), in
# one pair of lookups for all regions. Slow (~30 s each); only used when the
# API's spec has no zone table for the plan.
offering_zones() {
  local zones gpu_zones
  zones=$(gcloud compute machine-types list --filter="name=$MACHINE" \
    --format="value(zone.basename())" 2>/dev/null | sort -u)
  if [ "$GPU_COUNT" != "0" ]; then
    gpu_zones=$(gcloud compute accelerator-types list --filter="name=$GPU_TYPE" \
      --format="value(zone.basename())" 2>/dev/null | sort -u)
    zones=$(comm -12 <(echo "$zones") <(echo "$gpu_zones"))
  fi
  echo "$zones" | grep -v '^$' || true
}

# Zones Google's capacity advisor rates likely to have a Spot VM of this
# machine type now (obtainability >= CAPACITY_MIN_SCORE), asking every region
# at once. It calls the Compute beta REST API directly (the alpha one, behind
# `gcloud alpha compute advice capacity`, needs an allowlist grant; beta
# doesn't, and curl doesn't depend on the image's gcloud version). Prints
# nothing if the advisor can't be asked (the reason goes to stderr) or for
# on-demand plans, which it doesn't rate: callers then keep the usual order.
CAPACITY_MIN_SCORE=${CAPACITY_MIN_SCORE:-0.5}
capacity_advice() {
  [ "$(jq -r '.spot // false' <<<"$SPEC")" = true ] || return 0
  local dir region token body
  token=$(gcloud auth print-access-token 2>/dev/null) || { echo "… capacity advisor unavailable: no access token" >&2; return 0; }
  body=$(jq -nc --arg m "$MACHINE" '{size: 1, distributionPolicy: {targetShape: "ANY_SINGLE_ZONE"},
    instanceProperties: {scheduling: {provisioningModel: "SPOT"}},
    instanceFlexibilityPolicy: {instanceSelections: {box: {machineTypes: [$m]}}}}')
  dir=$(mktemp -d)
  for region in $REGIONS; do
    curl -sS -m 20 -X POST \
      "https://compute.googleapis.com/compute/beta/projects/$GCP_PROJECT/regions/$region/advice/capacity" \
      -H "authorization: Bearer $token" -H "content-type: application/json" --data "$body" \
      >"$dir/$region.json" 2>/dev/null &
  done
  wait
  # Per region, for the log: its best obtainability score, or why it has none
  # (e.g. a 403, or a 400 where the region doesn't offer the machine type).
  for region in $REGIONS; do
    jq -r --arg r "$region" 'if .error then "… advisor: \($r) error \(.error.code) \(.error.message)"[:160]
      else ((.recommendations // [])[0].scores.obtainability // empty | "… advisor: \($r) \(.)") end' \
      "$dir/$region.json" >&2 2>/dev/null || true
  done
  cat "$dir"/*.json 2>/dev/null | jq -r --argjson min "$CAPACITY_MIN_SCORE" '
    (if type == "array" then .[] else . end) | (.recommendations // [])[]
    | select((.scores.obtainability // 0) >= $min) | (.shards // [])[].zone // empty
    | split("/") | last' 2>/dev/null | sort -u || true
  rm -rf "$dir"
}

region_of() { sed -E 's/-[a-z]$//' <<<"$1"; } # us-central1-b -> us-central1

tf_vars() { # ZONE -> TF_VARS
  local r; r=$(region_of "$1")
  TF_VARS=(-var="zone=$1" -var="region=$r" -var="subnetwork=gpushed-$r")
}

apply() { # ZONE STATUS
  tf_vars "$1"
  if [ "$2" != RUNNING ]; then
    terraform apply -input=false -auto-approve "${TF_VARS[@]}" -var="desired_status=$2" >>"$LOG" 2>&1
    return
  fi
  # Bringing a VM up takes minutes; show what GCP is doing meanwhile.
  terraform apply -input=false -auto-approve "${TF_VARS[@]}" -var="desired_status=$2" >>"$LOG" 2>&1 &
  local pid=$! last="" now msg
  while kill -0 "$pid" 2>/dev/null; do
    now=$(gcloud compute instances describe "gp-$BOX_ID" --zone "$1" --format="value(status)" 2>/dev/null || true)
    if [ "$now" != "$last" ]; then
      case "$now" in
        PROVISIONING) msg="Google is reserving your $GPU_NAME in $1" ;;
        STAGING) msg="attaching the $GPU_NAME, disk and network in $1" ;;
        RUNNING) msg="booting your VM in $1" ;;
        *) msg="" ;;
      esac
      [ -z "$msg" ] || progress "$msg"
      last=$now
    fi
    sleep 8
  done
  wait "$pid"
}

outputs_and_report() {
  local ip zone
  ip=$(terraform output -raw ip 2>/dev/null || true)
  zone=$(terraform output -raw zone 2>/dev/null || true)
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$ip" # hide it in public workflow logs
  report true "$ip" "$zone"
  echo "✔ $ACTION done${zone:+ in $zone}"
}

case "$ACTION" in
  up)
    # Boot from the newest prebuilt image (image/build.sh) when there is one:
    # the box is ready in a minute or two instead of installing for 10-15.
    if IMAGE=$(gcloud compute images describe-from-family gpushed-cuda --project "$GCP_PROJECT" \
         --format="value(selfLink)" 2>/dev/null) && [ -n "$IMAGE" ]; then
      echo "… image ${IMAGE##*/}"
      echo "{\"image\": \"$IMAGE\"}" > image.auto.tfvars.json
    else
      echo "… no prebuilt image; installing on first boot"
      rm -f image.auto.tfvars.json
    fi
    # Zones to try: nearest region first, zones within a region shuffled to
    # spread load. Zones that ran out of this GPU in the last few minutes
    # (avoid_zones, from earlier runs) go to the very end.
    progress "finding a zone with a free $GPU_NAME"
    if [ -n "$KNOWN_ZONES" ]; then OFFERING=$KNOWN_ZONES; else OFFERING=$(offering_zones); fi
    LIKELY=$(capacity_advice)
    [ -z "$LIKELY" ] || echo "… Google rates these zones likely to have the $GPU_NAME free: $(echo $LIKELY)"
    FRESH=() STALE=() REST=()
    for region in $REGIONS; do
      for z in $(grep "^$region-[a-z]$" <<<"$OFFERING" | shuf); do
        if [[ $AVOID == *" $z "* ]]; then STALE+=("$z")
        elif [ -z "$LIKELY" ] || grep -qx "$z" <<<"$LIKELY"; then FRESH+=("$z")
        else REST+=("$z"); fi
      done
    done
    # Zones Google rates likely come first (nearest first), then the others.
    FRESH+=(${REST[@]+"${REST[@]}"})
    [ ${#STALE[@]} -eq 0 ] || echo "… trying last (out of $GPU_NAME recently): ${STALE[*]}"
    total=$((${#FRESH[@]} + ${#STALE[@]}))
    [ "$total" -gt 0 ] || { FAIL_REASON="no region offers this plan right now"; exit 1; }
    n=0
    for z in "${FRESH[@]}" "${STALE[@]}"; do
      n=$((n + 1))
      progress "creating your VM in $z (zone $n of $total)"
      : >"$LOG"
      if apply "$z" RUNNING; then
        outputs_and_report
        exit 0
      fi
      if grep -qE "(machineTypes|acceleratorTypes)/[^ ]* (was not found|does not exist)|is not available in zone|not supported in zone" "$LOG"; then
        # The zone table is stale: this zone no longer offers the plan.
        progress "$z doesn't offer $GPU_NAME any more, moving on"
        continue
      fi
      if ! grep -qE 'STOCKOUT|ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources available|QUOTA_EXCEEDED|Quota .* exceeded' "$LOG"; then
        FAIL_REASON="could not create the box"
        exit 1
      fi
      progress "no $GPU_NAME free in $z, moving on" "$z"
      # Remove whatever was half-created there, if anything: a stockout
      # usually leaves nothing, and a destroy would only cost time.
      if terraform state list 2>/dev/null | grep -q .; then
        tf_vars "$z"
        terraform destroy -input=false -auto-approve "${TF_VARS[@]}" >>"$LOG" 2>&1 || true
      fi
    done
    FAIL_REASON="no $GPU_NAME capacity anywhere right now; try again in a few minutes or another plan"
    exit 1
    ;;
  start)
    FAIL_REASON="could not start the box (the zone may be out of GPU capacity; try again shortly)"
    progress "starting your VM in $ZONE"
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
    tf_vars "${ZONE:-$REGION-a}"
    terraform destroy -input=false -auto-approve "${TF_VARS[@]}" >>"$LOG" 2>&1
    report true
    echo "✔ down done"
    ;;
esac
