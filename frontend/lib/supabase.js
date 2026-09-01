import { createClient } from "@supabase/supabase-js";

// NEXT_PUBLIC_* vars are safe to expose — use the anon key here, never the
// service role key (that stays backend-only, see backend/.env.example).
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
