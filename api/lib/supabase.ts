import { createClient } from '@supabase/supabase-js';

// Service-role client — API is the only service that talks to Supabase
// directly for writes. RLS remains defense-in-depth for any direct client read.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Auth-only client, used to verify user JWTs (getUser), not for data access.
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
