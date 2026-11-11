-- Lock down `public.rls_auto_enable()`. It was created outside the versioned migrations (the
-- Supabase helper behind the `ensure_rls` event trigger, which turns RLS on for new public tables) as
-- SECURITY DEFINER in the exposed `public` schema, and default privileges granted EXECUTE to `anon`
-- and `authenticated` — flagged by the security advisor (lints 0028/0029) as reachable at
-- `/rest/v1/rpc/rls_auto_enable`. Nothing should call it over the API, so revoke EXECUTE from the
-- API-facing roles. Postgres does not check EXECUTE when firing a trigger function, so the
-- `ensure_rls` event trigger keeps working.
--
-- Guarded so it is a no-op on a database where the function doesn't exist (a fresh/rebuilt project),
-- and idempotent (REVOKE of an absent privilege is harmless), matching the other migrations.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
