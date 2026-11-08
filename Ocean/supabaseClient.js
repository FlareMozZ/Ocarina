// Supabase admin client using service_role key.
// The service_role key bypasses all Row Level Security - keep it server-side only.
// Never expose SUPABASE_SERVICE_ROLE_KEY to the frontend or public API responses.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SECRET_SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

module.exports = supabase;