import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'NEXT_PUBLIC_');
  // Explicit allowlist. Never serialize process.env or the server environment.
  return {
    define: { __SENARIO_PUBLIC_CONFIG__: JSON.stringify({
      apiBaseUrl: env.NEXT_PUBLIC_SCENARIO_API_BASE_URL ?? '',
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      supabaseKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    }) },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
