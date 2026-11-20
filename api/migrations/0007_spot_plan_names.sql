-- Spot is the default: a GPU's plain plan name ("l4") is now its Spot plan,
-- and on-demand plans are "<gpu>-ondemand". Rename existing boxes to match,
-- on-demand first so the Spot boxes' new names don't collide with them.
UPDATE boxes SET plan = plan || '-ondemand' WHERE plan IN ('t4', 'l4', 'a100');
UPDATE boxes SET plan = substr(plan, 1, length(plan) - 5) WHERE plan IN ('t4-spot', 'l4-spot', 'a100-spot');
