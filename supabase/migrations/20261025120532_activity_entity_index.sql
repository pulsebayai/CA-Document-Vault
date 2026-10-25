-- Chore activity-entity-index (Raja approved 2026-10-25): index activity by its entity.
-- Why: `activity` had no index on entity_id, so every "activity for this document / client / item" lookup scanned
-- the whole table. On dev (379k rows, 156 MB, all test data, growing ~4k rows/day) one such lookup took 5.5 s
-- (EXPLAIN ANALYZE, parallel seq scan, 2026-10-25). Run in parallel by the RLS suite, these scans starved the Nano
-- instance, and unrelated statements hit the 8 s statement timeout: nightly Regression red on 2026-10-19, 24 and 25
-- (client-edit › create_client, 57014). The same scan is known issue K4 (09 volume test: document page Activity
-- card 14 s at 200k rows), which 08's activity_feed hits through `entity_type = 'document' and entity_id = …`.
-- (entity_id, id): entity_id leads because lookups filter on it alone (tests) or with entity_type (activity_feed,
-- where entity_type is checked on the few matching rows); id serves `order by id`. Entity IDs are UUIDs, so they
-- are unique across entity types. Additive only: no function, policy or data change.
create index if not exists activity_entity_idx on public.activity (entity_id, id);
analyze public.activity;
