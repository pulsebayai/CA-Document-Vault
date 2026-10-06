-- Feature 05 — migration A (plan step 2). Two new doc_type statuses for decided proposals.
-- ALTER TYPE … ADD VALUE can't be used in the transaction that adds it (07's precedent), so this migration holds
-- only the enum values and is applied, alone, before migration B (type governance).
alter type public.doc_type_status add value if not exists 'mapped';
alter type public.doc_type_status add value if not exists 'rejected';
