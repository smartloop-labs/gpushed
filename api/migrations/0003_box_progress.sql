-- What the provisioner is doing right now ("trying us-west1-a", ...), shown
-- by the CLI while a box is being created; cleared when it reports a result.
ALTER TABLE boxes ADD COLUMN progress TEXT;

-- Zones that recently had no capacity for a machine type. New boxes try
-- them last for a while, so one user's stockout saves the next user's wait.
CREATE TABLE zone_stockouts (
  zone         TEXT NOT NULL,
  machine_type TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (zone, machine_type)
);
