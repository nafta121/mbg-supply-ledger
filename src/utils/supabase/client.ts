import { getSupabaseClient, isSupabaseConfigured, SUPABASE_PROJECT_URL, SUPABASE_PUBLIC_KEY } from '../../lib/supabase';

export { isSupabaseConfigured, SUPABASE_PROJECT_URL, SUPABASE_PUBLIC_KEY };

export const createClient = () => getSupabaseClient();
