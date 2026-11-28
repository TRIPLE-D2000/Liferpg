// Public connection settings for Life RPG cloud sync.
// Both values are SAFE to publish: the publishable key only identifies the project, and what each
// signed-in user can see or change is enforced by Row Level Security in the database.
// NEVER put a secret / service_role key in this file or anywhere in this repository.
export const SUPABASE_URL = 'https://gbatqhgcpsaktmqdiuuu.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_AzN2RFr_MXIUaW2THSQ_wg_5Q9mY4Ov';

// Pinned, exact version (never a floating tag). Loaded on demand, so the app still starts and works offline
// if the CDN or the network is unavailable; account features simply report "unavailable".
export const SUPABASE_JS_VERSION = '2.111.0';
export const SUPABASE_JS_URL = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_JS_VERSION}/+esm`;

export async function loadSupabaseClient() {
  const { createClient } = await import(SUPABASE_JS_URL);
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
