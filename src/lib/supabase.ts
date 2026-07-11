import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Frontend auth client only — dashboard reads go through the API, not this
// client directly, except for Supabase Auth session management itself.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
