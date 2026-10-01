-- Feature 07 — review & dispatch, migration A (plan "Migrations" 1; schema lock: 07).
-- Adds the two review values to 03's document_status. Postgres can't use a value added by ALTER TYPE … ADD VALUE
-- in the same transaction, so this runs on its own, before migration B (…_review_and_dispatch), which uses them.
-- Existing documents stay 'received' (= To review). No data change.
alter type public.document_status add value if not exists 'reviewed';
alter type public.document_status add value if not exists 'needs_correction';
