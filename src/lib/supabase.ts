import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Fallback URL & Publishable Anon Key for project `nrdepkayabbbshnmyrvc`
 * (obtained via Supabase MCP `get_project_url` & `get_publishable_keys`),
 * guaranteeing Vercel production deployments always connect to the live
 * Supabase PostgreSQL cloud backend without falling back to offline/local mode.
 */
export const SUPABASE_FALLBACK_URL = 'https://nrdepkayabbbshnmyrvc.supabase.co';
export const SUPABASE_FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5yZGVwa2F5YWJiYnNobm15cnZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyMjQ5ODAsImV4cCI6MjEwNzgwMDk4MH0.Rllaa2VW8Aq_YJIqfMJRv20s4a1aUpdh8pb7pSoBKiQ';

export const SUPABASE_PROJECT_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  SUPABASE_FALLBACK_URL;

export const SUPABASE_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  SUPABASE_FALLBACK_ANON_KEY;

export const isSupabaseConfigured = Boolean(SUPABASE_PROJECT_URL && SUPABASE_PUBLIC_KEY);

let browserClient: SupabaseClient | null = null;

export const getSupabaseClient = (): SupabaseClient => {
  if (!browserClient) {
    browserClient = createBrowserClient(SUPABASE_PROJECT_URL, SUPABASE_PUBLIC_KEY);
  }
  return browserClient;
};
