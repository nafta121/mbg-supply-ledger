/**
 * Zero-dependency client interface & stub for the Full Cloudflare (D1 + Workers + Durable Objects) architecture.
 *
 * All production reads and writes are executed through `/api/hyperdrive` (Cloudflare D1)
 * and `/api/ws` (Cloudflare `MbgSyncHub` Durable Object WebSocket Hibernation).
 * The `SupabaseClient` interface is retained solely for backward-compatible unit testing.
 */

export interface SupabaseQueryBuilder {
  select: (columns?: string) => {
    order: (
      col: string,
      opts?: { ascending?: boolean }
    ) => Promise<{ data: unknown[] | null; error: { message: string } | null }> & {
      limit: (n: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      range: (from: number, to: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
    eq: (col: string, val: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  delete: () => {
    eq: (col: string, val: unknown) => Promise<{ error: { message: string } | null }>;
  };
  upsert: (
    row: unknown,
    opts?: { onConflict?: string }
  ) => Promise<{ error: { message: string } | null }>;
}

export interface SupabaseRealtimeChannel {
  on: (
    type: string,
    filter: Record<string, unknown>,
    callback: () => void
  ) => SupabaseRealtimeChannel;
  subscribe: (callback?: (status: string) => void) => SupabaseRealtimeChannel;
}

export interface SupabaseClient {
  rpc: (
    fn: string,
    params?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => SupabaseQueryBuilder;
  channel?: (name: string) => SupabaseRealtimeChannel;
  removeChannel?: (channel: SupabaseRealtimeChannel) => Promise<void>;
}

export const isSupabaseConfigured = true;

const stubError = { message: 'Cloudflare D1 endpoint (/api/hyperdrive) sedang tidak terjangkau.' };

const cloudflareStubClient: SupabaseClient = {
  rpc: async () => ({ data: null, error: stubError }),
  from: () => ({
    select: () => ({
      order: () => {
        const p = Promise.resolve({ data: null, error: stubError });
        return Object.assign(p, {
          limit: () => Promise.resolve({ data: null, error: stubError }),
          range: () => Promise.resolve({ data: null, error: stubError }),
        });
      },
      eq: () => Promise.resolve({ data: null, error: stubError }),
    }),
    delete: () => ({
      eq: () => Promise.resolve({ error: stubError }),
    }),
    upsert: () => Promise.resolve({ error: stubError }),
  }),
};

export const getSupabaseClient = (): SupabaseClient => cloudflareStubClient;
