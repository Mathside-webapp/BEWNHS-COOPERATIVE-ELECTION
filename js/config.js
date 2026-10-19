/**
 * Set these public values after deploying Supabase. Never place your service_role key here.
 * Values must be set to enable the live election. There is no demo fallback.
 */
export const CONFIG = {
  SUPABASE_URL: '', // e.g. 'https://your-project.supabase.co'
  SUPABASE_ANON_KEY: '', // publishable / anon key, never service_role
  FUNCTION_NAME: 'election-api',
  SCHOOL: 'Bagumbayan-East Washington National High School',
  COOPERATIVE: 'BEWNHS Cooperative',
  // Runtime config stays editable even after compiling the classic script.
  ...(globalThis.BEWNHSElectionConfig || {}),
};
