-- BEWNHS Cooperative Election: execute in Supabase SQL Editor on a new project.
-- PRIVACY: shared-PIN ballots have a restricted member link for dispute resets.
-- SECURITY: frontend access to these tables is disabled; the Edge Function uses
-- the service role calls cast_shared_ballot() for an atomic transaction.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.election_settings (
  id smallint primary key default 1 check (id=1),
  title text not null default 'BEWNHS Cooperative Election',
  status text not null default 'draft'
    check (status in ('draft','open','paused','closed','certified')),
  allow_partial boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  results_published boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint valid_election_window check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint results_publication_requires_certification check (not results_published or status='certified')
);
insert into public.election_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.members (
 id uuid primary key default gen_random_uuid(),
 name text not null unique,
 eligible boolean not null default false,
 created_at timestamptz not null default now()
);

create table if not exists public.candidates (
 id uuid primary key default gen_random_uuid(),
 member_id uuid not null unique references public.members(id) on delete restrict,
 board boolean not null default false,
 audit boolean not null default false,
 active boolean not null default true,
 updated_at timestamptz not null default now()
);

create table if not exists public.access_codes (
 id uuid primary key default gen_random_uuid(),
 member_id uuid not null unique references public.members(id) on delete restrict,
 code_hash text not null unique,
 issued_at timestamptz not null default now(),
 used_at timestamptz,
 revoked_at timestamptz
);

create table if not exists public.ballots (
 id uuid primary key default gen_random_uuid(),
 election_id smallint not null references public.election_settings(id)
 -- Intentionally no member_id, access_code_id, or precise submission timestamp.
);

create table if not exists public.vote_selections (
 ballot_id uuid not null references public.ballots(id) on delete cascade,
 committee text not null check (committee in ('board','audit')),
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 primary key (ballot_id, committee, candidate_id)
);
create index if not exists vote_selections_candidate_idx on public.vote_selections(committee,candidate_id);

create table if not exists public.tie_breaks (
 committee text not null check (committee in ('board','audit')),
 vote_count integer not null check (vote_count>=0),
 winner_ids uuid[] not null,
 notes text not null,
 resolved_at timestamptz not null default now(),
 primary key (committee,vote_count)
);

create table if not exists public.admin_users (
 user_id uuid primary key references auth.users(id) on delete cascade,
 added_at timestamptz not null default now()
);

create table if not exists public.admin_audit_log (
 id bigint generated always as identity primary key,
 admin_id uuid references auth.users(id) on delete set null,
 action text not null,
 details jsonb not null default '{}'::jsonb,
 logged_at timestamptz not null default now()
);

-- Zero browser-readable policies: even a signed-in non-admin may not read ballots,
-- voter codes, participation identities or election data through PostgREST.
-- Only the Edge Function uses the service-role key, server-side.
alter table public.election_settings enable row level security;
alter table public.members enable row level security;
alter table public.candidates enable row level security;
alter table public.access_codes enable row level security;
alter table public.ballots enable row level security;
alter table public.vote_selections enable row level security;
alter table public.tie_breaks enable row level security;
alter table public.admin_users enable row level security;
alter table public.admin_audit_log enable row level security;

revoke all on public.election_settings, public.members, public.candidates,
 public.access_codes, public.ballots, public.vote_selections, public.tie_breaks,
 public.admin_users, public.admin_audit_log from anon, authenticated, public;

-- This function must only be called by the Edge Function using service_role.
-- The code is random 120-bit entropy, stored hashed, and locked FOR UPDATE to
-- defeat simultaneous double-submissions and replay attacks.
create or replace function public.cast_ballot(
 p_code text,
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
 v_access_id uuid;
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

 if p_code is null or length(p_code) < 20 or length(p_code)>256
 then raise exception 'Invalid voting code'; end if;

 select a.id, a.member_id, m.eligible, a.used_at, a.revoked_at
 into v_access_id,v_member_id,v_eligible,v_used_at,v_revoked_at
 from public.access_codes a
 join public.members m on m.id=a.member_id
 where a.code_hash=encode(extensions.digest(p_code,'sha256'),'hex')
 for update of a;

 if v_access_id is null or not v_eligible or v_revoked_at is not null
 then raise exception 'Voting code is invalid or ineligible'; end if;
 if v_used_at is not null then raise exception 'This voting code has already been used'; end if;

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
      where c.id=any(p_board) and c.active and c.board) <> v_board_count
 then raise exception 'Invalid Board of Directors candidate'; end if;
 if (select count(*) from public.candidates c join public.members m on m.id=c.member_id
      where c.id=any(p_audit) and c.active and c.audit) <> v_audit_count
 then raise exception 'Invalid Audit Committee candidate'; end if;

 insert into public.ballots (election_id) values (1) returning id into v_ballot_id;
 insert into public.vote_selections(ballot_id,committee,candidate_id)
 select v_ballot_id,'board',id from unnest(p_board) as u(id);
 insert into public.vote_selections(ballot_id,committee,candidate_id)
 select v_ballot_id,'audit',id from unnest(p_audit) as u(id);
 update public.access_codes set used_at=now() where id=v_access_id;
 return v_ballot_id;
end;
$$;
revoke all on function public.cast_ballot(text,uuid[],uuid[]) from public, anon, authenticated;
grant execute on function public.cast_ballot(text,uuid[],uuid[]) to service_role;

-- Database-side totals avoid PostgREST's default 1,000-row response ceiling.
-- No voter identity is returned; only committee / candidate / aggregate count.
create or replace function public.tally_vote_totals()
returns table(committee text, candidate_id uuid, votes bigint)
language sql stable security definer
set search_path = public, pg_temp
as $$
 select vs.committee, vs.candidate_id, count(*)::bigint as votes
 from public.vote_selections vs
 group by vs.committee, vs.candidate_id
$$;
revoke all on function public.tally_vote_totals() from public, anon, authenticated;
grant execute on function public.tally_vote_totals() to service_role;

-- Source: supplied 'List of Coop.xlsx'. Nomination assignments are intentionally
-- not prefilled. Approve voter eligibility and nominees in the Admin Dashboard.
insert into public.members(name) values ('Abellano, July') on conflict(name) do nothing;
insert into public.members(name) values ('Acosta, Dave') on conflict(name) do nothing;
insert into public.members(name) values ('Ajero, Laila') on conflict(name) do nothing;
insert into public.members(name) values ('Alejo, Alexander Jr. L.') on conflict(name) do nothing;
insert into public.members(name) values ('Aranaz, Jonard D.') on conflict(name) do nothing;
insert into public.members(name) values ('Atibo, Jerry') on conflict(name) do nothing;
insert into public.members(name) values ('Balmedina, Christine May') on conflict(name) do nothing;
insert into public.members(name) values ('Baltazar, Sheryl') on conflict(name) do nothing;
insert into public.members(name) values ('Bergonio, Gerard') on conflict(name) do nothing;
insert into public.members(name) values ('Benipayo, Judith') on conflict(name) do nothing;
insert into public.members(name) values ('Bilolo, Mariel A.') on conflict(name) do nothing;
insert into public.members(name) values ('Brutas, Marrianne') on conflict(name) do nothing;
insert into public.members(name) values ('Cajayon, Kristian Albert') on conflict(name) do nothing;
insert into public.members(name) values ('Cervantes, Dianne') on conflict(name) do nothing;
insert into public.members(name) values ('Espares, Rachel') on conflict(name) do nothing;
insert into public.members(name) values ('Gaveria, John Isaiah') on conflict(name) do nothing;
insert into public.members(name) values ('Jacob, Anicia O.') on conflict(name) do nothing;
insert into public.members(name) values ('Jacob, Shyrine P.') on conflict(name) do nothing;
insert into public.members(name) values ('Lezondra, Elsa') on conflict(name) do nothing;
insert into public.members(name) values ('Lustre, Cindy L.') on conflict(name) do nothing;
insert into public.members(name) values ('Ryan C. Osea') on conflict(name) do nothing;
insert into public.members(name) values ('Tacurda, Jessa May') on conflict(name) do nothing;
insert into public.members(name) values ('Toledo, Maricel L.') on conflict(name) do nothing;

-- IMPORTANT: Create your administrator in Supabase Auth > Users, then run:
-- insert into public.admin_users(user_id) select id from auth.users where email='your-admin@example.com';

-- Optional abuse control: database-backed rate quotas (per hashed network key).
-- The client never sees this table or the quota function.
create table if not exists public.request_quota (
 bucket_key text primary key,
 window_start timestamptz not null default now(),
 attempt_count int not null default 0
);
alter table public.request_quota enable row level security;
revoke all on public.request_quota from public, anon, authenticated;

create or replace function public.bump_request_quota(p_key text, p_limit int, p_window_seconds int)
returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count int;
begin
 if length(p_key)<>64 or p_limit <1 or p_limit>1000 or p_window_seconds < 60
 then return false; end if;
 insert into public.request_quota(bucket_key,window_start,attempt_count)
 values(p_key,now(),1)
 on conflict(bucket_key) do update set
   attempt_count = case
       when public.request_quota.window_start < now()-make_interval(secs=>p_window_seconds) then 1
       else public.request_quota.attempt_count+1 end,
   window_start = case
       when public.request_quota.window_start < now()-make_interval(secs=>p_window_seconds) then now()
       else public.request_quota.window_start end
 returning attempt_count into v_count;
 return v_count <= p_limit;
end;
$$;
revoke all on function public.bump_request_quota(text,int,int) from public,anon,authenticated;
grant execute on function public.bump_request_quota(text,int,int) to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

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
      where c.id=any(p_board) and c.active and c.board) <> v_board_count
 then raise exception 'Invalid Board of Directors candidate'; end if;
 if (select count(*) from public.candidates c join public.members m on m.id=c.member_id
      where c.id=any(p_audit) and c.active and c.audit) <> v_audit_count
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
