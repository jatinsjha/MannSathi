-- Apply manually after 008. The admin membership check takes a FOR SHARE lock.
-- PostgREST selects a read/write transaction for a POST RPC marked VOLATILE.
begin;
alter function public.mannsathi_ai_report(uuid, text, jsonb) volatile;
notify pgrst, 'reload schema';
commit;
