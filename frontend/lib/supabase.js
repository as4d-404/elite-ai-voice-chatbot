import { createClient } from "@supabase/supabase-js";

// Only the public anon key belongs here. Service-role credentials stay server-side.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
