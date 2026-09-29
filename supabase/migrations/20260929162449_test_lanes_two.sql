-- Two test lanes, not three (Raja 2026-09-29 21:54): e2e timed out in 1 of 2 overlapping CI runs
-- (run 36592728337) with no DB errors or slow queries — load on the shared dev project is the suspect.
-- Lane 3 was never used (no lane-3 fixtures exist). Re-add a row to raise the cap again.
delete from public.test_lane where lane = 3;
