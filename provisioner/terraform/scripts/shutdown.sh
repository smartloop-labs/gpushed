#!/bin/bash
# GCE runs this as the VM shuts down (the shutdown-script metadata key). When
# Google is reclaiming a Spot box (instance/preempted is TRUE), tell the gpushed
# API, which marks the box stopped and bills only its disk from now on. Any
# other shutdown (gpushed stop, the idle watcher, a reboot) does nothing here.
# Google allows about 30 seconds after a reclaim notice, so keep it short.
md() { curl -fs -m 3 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
[ "$(md preempted)" = TRUE ] || exit 0
API=$(md attributes/gpushed-api) || exit 0
BOX=$(md attributes/gpushed-box-id) || exit 0
TOKEN=$(md attributes/gpushed-idle-token) || exit 0
[ -n "$API" ] && [ -n "$BOX" ] && [ -n "$TOKEN" ] || exit 0
logger -t gpushed "Google is reclaiming this Spot box; telling gpushed"
for _ in 1 2 3; do
  curl -fsS -m 6 -X POST -H "authorization: Bearer $TOKEN" "$API/boxes/$BOX/preempted" >/dev/null && exit 0
  sleep 1
done
logger -t gpushed "could not tell gpushed about the reclaim"
