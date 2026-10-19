-- Run in Supabase SQL Editor on existing installations.
-- Candidate nomination no longer depends on voter eligibility.

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
