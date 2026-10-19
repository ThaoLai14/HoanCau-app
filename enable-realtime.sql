-- Bật Supabase Realtime cho các bảng app tự đồng bộ. Idempotent.
-- RLS vẫn áp dụng: user chỉ nhận event của dòng họ có quyền SELECT.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bills','bill_payment_details','expenses','clients','client_phones','branch_sessions']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
