-- Allow authorized administrators to retrieve the current election PIN.
-- The table remains inaccessible to anon/authenticated clients; only the
-- admin-authorized Edge Function returns current_pin. Never return pin_hash.
alter table public.election_pin add column if not exists current_pin text;
create or replace function public.set_election_pin(p_pin text,p_admin uuid) returns void
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
begin
 if not exists(select 1 from public.admin_users where user_id=p_admin) then raise exception 'Admin required'; end if;
 if p_pin is null or p_pin !~ '^[0-9]{6,12}$' then raise exception 'Use a 6 to 12 digit PIN'; end if;
 insert into public.election_pin(id,pin_hash,current_pin)
 values(1,extensions.crypt(p_pin,extensions.gen_salt('bf')),p_pin)
 on conflict(id) do update set pin_hash=excluded.pin_hash,current_pin=excluded.current_pin;
 insert into public.admin_audit_log(admin_id,action) values(p_admin,'change_election_pin');
end $$;
revoke all on function public.set_election_pin(text,uuid) from public,anon,authenticated;
grant execute on function public.set_election_pin(text,uuid) to service_role;
