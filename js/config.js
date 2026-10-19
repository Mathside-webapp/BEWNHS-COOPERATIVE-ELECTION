/**
 * Set these public values after deploying Supabase. Never place your service_role key here.
 * With both values empty, the website offers the fully interactive OFFLINE DEMO only.
 */
export const CONFIG = {
  SUPABASE_URL: 'https://tzyibiwitxkbxpnoctky.supabase.co/', // e.g. 'https://your-project.supabase.co'
  SUPABASE_ANON_KEY: 'sb_publishable_P7_M-BoJ_KgS5faLjgELyA_IrmtnKV9', // publishable / anon key, never service_role
  FUNCTION_NAME: 'election-api',
  SCHOOL: 'Bagumbayan-East Washington National High School',
  COOPERATIVE: 'BEWNHS Cooperative',
  // Runtime config stays editable even after compiling the classic script.
  ...(globalThis.BEWNHSElectionConfig || {}),
};
