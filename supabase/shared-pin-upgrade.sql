-- Shared PIN upgrade: safe to apply to an existing installation.
-- Existing anonymous ballots remain counted; their ownership cannot be recovered.
-- New ballots have a restricted participation link for disputed-vote resets.
alter table public.members add column if not exists vote_generation integer not null default 0;
create table if not exists public.election_pin(id smallint primary key check(id=1),pin_hash text not null);
create table if not exists public.voter_participation(
 member_id uuid primary key references public.members(id),
 ballot_id uuid not null unique references public.ballots(id) on delete cascade,
 submitted_at timestamptz not null default now()
);
alter table public.election_pin enable row level security;
alter table public.voter_participation enable row level security;
revoke all on public.election_pin, public.voter_participation from public,anon,authenticated;
grant all on public.election_pin, public.voter_participation to service_role;
-- Disable the legacy entry point after migration.
revoke execute on function public.cast_ballot(text,uuid[],uuid[]) from service_role;

create or replace function public.check_election_pin(p_pin text) returns boolean
language sql security definer set search_path=public,extensions,pg_temp as $$
 select exists(select 1 from public.election_pin where id=1 and pin_hash=extensions.crypt(p_pin,pin_hash))
$$;
create or replace function public.set_election_pin(p_pin text,p_admin uuid) returns void
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
begin
 if not exists(select 1 from public.admin_users where user_id=p_admin) then raise exception 'Admin required'; end if;
 if p_pin !~ '^[0-9]{6,12}$' then raise exception 'Use a 6 to 12 digit PIN'; end if;
 insert into public.election_pin values(1,extensions.crypt(p_pin,extensions.gen_salt('bf')))
 on conflict(id) do update set pin_hash=excluded.pin_hash;
 insert into public.admin_audit_log(admin_id,action) values(p_admin,'change_election_pin');
end $$;
create or replace function public.cast_shared_ballot(
 p_pin text, p_member_id uuid, p_generation integer,
 p_board uuid[],
 p_audit uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
 v_election public.election_settings%rowtype;
 v_member_id uuid;
 v_generation integer;
 v_eligible boolean;
 v_used_at timestamptz;
 v_revoked_at timestamptz;
 v_ballot_id uuid;
 v_board_count int;
 v_audit_count int;
begin
 select * into v_election from public.election_settings where id=1 for share;
 if not found or v_election.status <> 'open'
    or (v_election.starts_at is not null and now() < v_election.starts_at)
    or (v_election.ends_at is not null and now() >= v_election.ends_at)
 then raise exception 'Election is not currently open'; end if;

 perform 1 from public.election_pin where id=1 and pin_hash=extensions.crypt(p_pin,pin_hash);
 if not found then raise exception 'Invalid election PIN'; end if;
 select eligible,vote_generation into v_eligible,v_generation from public.members where id=p_member_id for update;
 if not found or not v_eligible then raise exception 'Member is not eligible'; end if;
 if v_generation <> p_generation then raise exception 'Voting entry expired. Please enter again'; end if;
 if exists(select 1 from public.voter_participation where member_id=p_member_id)
 or exists(select 1 from public.access_codes where member_id=p_member_id and used_at is not null)
 then raise exception 'This member has already voted'; end if;

 p_board := coalesce(p_board,array[]::uuid[]);
 p_audit := coalesce(p_audit,array[]::uuid[]);
 v_board_count := cardinality(p_board);
 v_audit_count := cardinality(p_audit);
 if v_board_count > 5 or v_audit_count > 3
 then raise exception 'Selection limit exceeded'; end if;
 if not v_election.allow_partial and (v_board_count <> 5 or v_audit_count <> 3)
 then raise exception 'Select exactly five directors and three auditors'; end if;
 if (select count(distinct id) from unnest(p_board) as u(id)) <> v_board_count
    or (select count(distinct id) from unnest(p_audit) as u(id)) <> v_audit_count
 then raise exception 'A candidate was selected more than once'; end if;
 if (select count(*) from public.candidates c join public.members m on m.id=c.member_id
      where c.id=any(p_board) and c.active and c.board and m.eligible) <> v_board_count
 then raise exception 'Invalid Board of Directors candidate'; end if;
 if (select count(*) from public.candidates c join public.members m on m.id=c.member_id
      where c.id=any(p_audit) and c.active and c.audit and m.eligible) <> v_audit_count
 then raise exception 'Invalid Audit Committee candidate'; end if;

 insert into public.ballots (election_id) values (1) returning id into v_ballot_id;
 insert into public.vote_selections(ballot_id,committee,candidate_id)
 select v_ballot_id,'board',id from unnest(p_board) as u(id);
 insert into public.vote_selections(ballot_id,committee,candidate_id)
 select v_ballot_id,'audit',id from unnest(p_audit) as u(id);
 insert into public.voter_participation(member_id,ballot_id) values(p_member_id,v_ballot_id);
 return v_ballot_id;
end;
$$;

create or replace function public.reset_member_vote(p_member_id uuid,p_reason text,p_admin uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ballot uuid; v_status text;
begin
 if not exists(select 1 from public.admin_users where user_id=p_admin) then raise exception 'Admin required'; end if;
 if length(trim(p_reason))<5 or length(p_reason)>1000 then raise exception 'Provide a reason (5 to 1000 characters)'; end if;
 select status into v_status from public.election_settings where id=1 for update;
 if v_status='certified' then raise exception 'Certified results cannot be reset'; end if;
 perform 1 from public.members where id=p_member_id for update;
 select ballot_id into v_ballot from public.voter_participation where member_id=p_member_id;
 if v_ballot is null then raise exception 'No resettable ballot for this member. Legacy anonymous ballots cannot be individually removed'; end if;
 delete from public.ballots where id=v_ballot;
 update public.members set vote_generation=vote_generation+1 where id=p_member_id;
 delete from public.tie_breaks;
 -- A closed election is paused for the administrator to reopen after review.
 update public.election_settings set status=case when status='closed' then 'paused' else status end,results_published=false where id=1;
 insert into public.admin_audit_log(admin_id,action,details) values(p_admin,'reset_member_vote',jsonb_build_object('member_id',p_member_id,'reason',trim(p_reason)));
end $$;
revoke all on function public.check_election_pin(text),public.set_election_pin(text,uuid),public.cast_shared_ballot(text,uuid,integer,uuid[],uuid[]),public.reset_member_vote(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.check_election_pin(text),public.set_election_pin(text,uuid),public.cast_shared_ballot(text,uuid,integer,uuid[],uuid[]),public.reset_member_vote(uuid,text,uuid) to service_role;

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
