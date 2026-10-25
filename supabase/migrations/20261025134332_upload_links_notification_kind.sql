-- Feature 10 — migration D (plan step 4 fix): 05's notification table accepted only doc_type entities. A
-- link_upload notification points at its upload_request (D6). Each kind keeps exactly one entity type.
alter table public.notification drop constraint notification_entity_type_check;
alter table public.notification add constraint notification_entity_type_check check (
     (kind = 'type_decision' and entity_type = 'doc_type')
  or (kind = 'link_upload' and entity_type = 'upload_request'));
