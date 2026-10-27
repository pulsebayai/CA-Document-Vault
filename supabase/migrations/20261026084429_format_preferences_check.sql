-- 11-file-type-rules · migration A2: the preferred-formats check written with built-in functions only.
-- Migration A's check called private.formats_valid. A check constraint runs with the writer's privileges, and the
-- service role has no usage on schema private, so after A any service-role write to doc_type (even a rename) failed
-- with "permission denied for schema private". Same rules: null, or 1–8 distinct format choices, approved types only.
alter table public.doc_type drop constraint doc_type_preferred_formats_check;
alter table public.doc_type add constraint doc_type_preferred_formats_check check (
  preferred_formats is null or (
    status = 'approved'
    and cardinality(preferred_formats) >= 1
    and preferred_formats <@ array['pdf', 'jpg', 'png', 'heic', 'xlsx', 'xls', 'csv', 'docx']::text[]
    and cardinality(array_positions(preferred_formats, 'pdf')) <= 1
    and cardinality(array_positions(preferred_formats, 'jpg')) <= 1
    and cardinality(array_positions(preferred_formats, 'png')) <= 1
    and cardinality(array_positions(preferred_formats, 'heic')) <= 1
    and cardinality(array_positions(preferred_formats, 'xlsx')) <= 1
    and cardinality(array_positions(preferred_formats, 'xls')) <= 1
    and cardinality(array_positions(preferred_formats, 'csv')) <= 1
    and cardinality(array_positions(preferred_formats, 'docx')) <= 1
  )
);
drop function private.formats_valid(text[]);
