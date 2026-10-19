// @ts-nocheck
/**
 * BEWNHS Cooperative Election — Supabase Edge Function
 * Deploy: supabase functions deploy election-api --no-verify-jwt
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase),
 *          RATE_LIMIT_SALT (your own long random string).
 *
 * RLS denies all direct client table access. This function is the API boundary.
 * Voters present a shared PIN and eligible member identity; admins must
 * present a Supabase Auth JWT plus membership in public.admin_users.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const RATE_SALT = Deno.env.get('RATE_LIMIT_SALT') || '';
if (!URL || !SERVICE_ROLE) throw new Error('Missing required Supabase environment secrets');
const db = createClient(URL, SERVICE_ROLE, {auth:{autoRefreshToken:false,persistSession:false}});
const HEADERS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const ok = (payload, status=200) => new Response(JSON.stringify(payload),{status,headers:{...HEADERS,'Content-Type':'application/json'}});
const fail = (message,status=400) => ok({error:String(message)},status);
const assert = (condition,msg,status=400) => {if (!condition) {const e=new Error(msg);e.status=status;throw e;}};
const safeError = (error) => {console.error('Election API error:',error?.message||error);const msg=error?.status ? error.message : (error?.message || 'Request failed');return fail(msg,error?.status||400);};
const validId = id => typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const sortedName = (a,b) => a.name.localeCompare(b.name);
const toCandidate = row => ({id:row.id,member_id:row.member_id,name:row.members?.name||'',board:row.board,audit:row.audit,active:row.active,eligible:true});
async function digest(value){const bytes=new TextEncoder().encode(value);const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');}
function newCode(){const buf=crypto.getRandomValues(new Uint8Array(24));const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from(buf,b=>alphabet[b%alphabet.length]).join('');}
function nowAllowed(settings){const t=Date.now();return settings?.status==='open' && (!settings.starts_at || t>=Date.parse(settings.starts_at)) && (!settings.ends_at || t<Date.parse(settings.ends_at));}
async function readSettings(){const {data,error}=await db.from('election_settings').select('*').eq('id',1).single();if(error)throw error;return data;}
async function readMembers(){const {data,error}=await db.from('members').select('id,name,eligible,vote_generation').order('name');if(error)throw error;return data;}
async function readCandidates(){const {data,error}=await db.from('candidates').select('id,member_id,board,audit,active,members!inner(name,eligible)');if(error)throw error;return data.map(toCandidate).sort(sortedName);}
async function readAdminUser(req){
 const header=req.headers.get('Authorization')||'';
 const jwt=header.startsWith('Bearer ')?header.slice(7):'';
 assert(jwt.length>50,'Administrator authentication required',401);
 const {data,error}=await db.auth.getUser(jwt);
 assert(!error && !!data?.user,'Administrator session invalid or expired',401);
 const {data:admin,error:permError}=await db.from('admin_users').select('user_id').eq('user_id',data.user.id).maybeSingle();
 assert(!permError && !!admin,'This user does not have administrator access',403);
 return data.user;
}
async function audit(user,action,details={}){
 const {error}=await db.from('admin_audit_log').insert({admin_id:user.id,action,details});
 if(error)throw error;
}
async function limitRequest(req, action){
 assert(RATE_SALT.length>=24,'Server configuration missing RATE_LIMIT_SALT',503);
 // Supabase's reverse proxy forwards the actual client IP. The stored key is salted & hashed.
 const ip=(req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')||'unknown').split(',')[0].trim();
 const key=await digest(`${RATE_SALT}:${action}:${ip}`);
 const {data,error}=await db.rpc('bump_request_quota',{p_key:key,p_limit:action==='verify'?120:70,p_window_seconds:900});
 if(error)throw error;
 assert(data,'Too many requests. Please contact the Election Committee.',429);
}
function rank(candidates, totals, seats, excludedIds=[],resolutions=[]){
 const excluded=new Set(excludedIds);
 const rows=candidates.map(c=>({...c,votes:Number(totals[c.id]||0),status:excluded.has(c.id)?'board_winner':'not_elected'}))
  .sort((a,b)=>b.votes-a.votes||a.name.localeCompare(b.name));
 const eligible=rows.filter(c=>!excluded.has(c.id)&&c.votes>0);
 const winnerIds=[], pending=[];
 let remaining=seats;
 for(let i=0;i<eligible.length&&remaining>0;){
  const votes=eligible[i].votes;const group=eligible.filter(x=>x.votes===votes);i+=group.length;
  if(group.length<=remaining){winnerIds.push(...group.map(x=>x.id));remaining-=group.length;continue;}
  const res=resolutions.find(t=>t.vote_count===votes);
  const chosen=res?.winner_ids||[];
  if(chosen.length===remaining && new Set(chosen).size===chosen.length && chosen.every(id=>group.some(x=>x.id===id))){winnerIds.push(...chosen);remaining=0;}
  else {pending.push({votes,available:remaining,candidates:group.map(({id,name})=>({id,name}))});break;}
 }
 const won=new Set(winnerIds);
 rows.forEach(r=>{if(won.has(r.id))r.status='elected';else if(pending.some(g=>g.candidates.some(c=>c.id===r.id)))r.status='tie_pending';});
 return {rows,winner_ids:winnerIds,pending,shortage:!pending.length&&winnerIds.length<seats,seats};
}
async function tallyResults(candidates){
 const [{data:aggregates,error:e1},{data:resolutions,error:e2}]=await Promise.all([
  db.rpc('tally_vote_totals'),db.from('tie_breaks').select('*')
 ]);
 if(e1)throw e1;if(e2)throw e2;
 const totals={board:{},audit:{}};
 for(const v of aggregates)totals[v.committee][v.candidate_id]=Number(v.votes);
 const board=rank(candidates.filter(c=>c.active&&c.board),totals.board,5,[],resolutions.filter(x=>x.committee==='board'));
 // Always include Audit vote counts, even if a Board tie makes the final Audit seat allocation provisional.
 const audit=rank(candidates.filter(c=>c.active&&c.audit),totals.audit,3,board.winner_ids,resolutions.filter(x=>x.committee==='audit'));
 return {board,audit,board_pending:board.pending.length>0};
}
async function readOverview(){
 const [settings,members,candidates,{data:codes,error:eCodes},{count:countBallots,error:eBallots},{data:ties,error:eTies}]=await Promise.all([
  readSettings(),readMembers(),readCandidates(),db.from('access_codes').select('member_id,used_at,revoked_at'),
  db.from('ballots').select('*',{count:'exact',head:true}),db.from('tie_breaks').select('*')
 ]);
 if(eCodes)throw eCodes;if(eBallots)throw eBallots;if(eTies)throw eTies;
 const coded=new Map(codes.map(c=>[c.member_id,c]));
 const {data:participation,error:ep}=await db.from('voter_participation').select('member_id,submitted_at');if(ep)throw ep;
 const links=new Map(participation.map(p=>[p.member_id,p]));
 const {data:resets,error:er}=await db.from('admin_audit_log').select('admin_id,action,details,logged_at').eq('action','reset_member_vote').order('logged_at',{ascending:false}).limit(50);if(er)throw er;
 const {data:pinRecord,error:pinReadError}=await db.from('election_pin').select('current_pin').eq('id',1).maybeSingle();if(pinReadError)throw pinReadError;
 const memberStates=members.map(m=>({...m,voted:links.has(m.id)||!!coded.get(m.id)?.used_at,submitted_at:links.get(m.id)?.submitted_at||coded.get(m.id)?.used_at,resettable:links.has(m.id)}));
 // This endpoint is restricted to authenticated administrators. Live counts must not be returned by public snapshot.
 return {settings,pin_configured:!!pinRecord,current_pin:pinRecord?.current_pin||null,reset_log:resets,members:memberStates,candidates,eligible_count:memberStates.filter(m=>m.eligible).length,
  voted_count:memberStates.filter(m=>m.voted).length,ballots_count:countBallots||0,
  results:await tallyResults(candidates),tie_breaks:ties};
}
async function applySettings(payload,user){
 const old=await readSettings();
 const nextStatus=String(payload.status||old.status);
 assert(['draft','open','paused','closed','certified'].includes(nextStatus),'Invalid election status');
 assert(old.status!=='certified' || nextStatus==='certified','Certified elections cannot be reopened');
 assert(old.status!=='closed' || ['closed','certified'].includes(nextStatus),'A closed election cannot be reopened');
 assert(!(['draft','paused'].includes(nextStatus)&&old.status==='closed'),'Cannot revert a closed election');
 assert(!(nextStatus==='certified' && old.status!=='closed' && old.status!=='certified'),'Close the election before certification');
 assert(!(nextStatus==='open' && ['closed','certified'].includes(old.status)),'This election has been closed');
 const partial=typeof payload.allow_partial==='boolean'?payload.allow_partial:old.allow_partial;
 const published=!!payload.results_published;
 assert(!published||nextStatus==='certified','Only certified results may be published');
 const start=payload.starts_at===null?null:payload.starts_at||old.starts_at;
 const end=payload.ends_at===null?null:payload.ends_at||old.ends_at;
 assert(!start||!end||Date.parse(start)<Date.parse(end),'Voting closing time must be later than opening time');
 const [{count:ballotCount,error:errCount},candidates] = await Promise.all([db.from('ballots').select('id',{count:'exact',head:true}),readCandidates()]);
 if(errCount)throw errCount;
 if(ballotCount && (partial!==old.allow_partial || start!==old.starts_at || end!==old.ends_at)){
   throw new Error('Selection rules and voting dates are locked after ballot submission');
 }
 if(nextStatus==='open'){
  const {count:pinCount,error:pinError}=await db.from('election_pin').select('id',{count:'exact',head:true});if(pinError)throw pinError;assert(pinCount,'Set the shared election PIN under Voters & access first');
  const boards=candidates.filter(c=>c.board&&c.active).length;
  const audits=candidates.filter(c=>c.audit&&c.active).length;
  const distinct=new Set(candidates.filter(c=>c.active&&(c.board||c.audit)).map(c=>c.id)).size;
  assert(boards>=5 && audits>=3 && distinct>=8,'Assign at least 5 Board nominees, 3 Audit nominees and 8 distinct people before opening');
  
 }
 if(nextStatus==='certified'){
  const results=await tallyResults(candidates);
  assert(!results.board.pending.length&&!results.board.shortage && !!results.audit && !results.audit.pending.length && !results.audit.shortage,
    'Resolve ties and fill 5 Board seats and 3 Audit seats before certifying');
 }
 const update={status:nextStatus,allow_partial:partial,starts_at:start,ends_at:end,results_published:published,updated_at:new Date().toISOString()};
 const {error}=await db.from('election_settings').update(update).eq('id',1);
 if(error)throw error;
 await audit(user,'update_election_settings',{status:nextStatus,published});
 return {ok:true};
}
async function handleAdmin(req,action,data){
 const user=await readAdminUser(req);
 if(action==='admin.overview')return await readOverview();
 if(action==='admin.set_pin'){const {error}=await db.rpc('set_election_pin',{p_pin:String(data.pin||''),p_admin:user.id});if(error)throw error;return {ok:true};}
 if(action==='admin.reset_vote'){assert(validId(data.member_id),'Invalid member');const {error}=await db.rpc('reset_member_vote',{p_member_id:data.member_id,p_reason:String(data.reason||''),p_admin:user.id});if(error)throw error;return {ok:true};}
 if(action==='admin.set_member'){
  assert(validId(data.member_id),'Invalid member');
  const [{data:used},{count:ballotsCount},{data:existingCandidate}] = await Promise.all([
    db.from('access_codes').select('used_at').eq('member_id',data.member_id).maybeSingle(),
    db.from('ballots').select('id',{head:true,count:'exact'}),
    db.from('candidates').select('board,audit').eq('member_id',data.member_id).maybeSingle()
  ]);
  const {data:participated}=await db.from('voter_participation').select('member_id').eq('member_id',data.member_id).maybeSingle();assert(!participated&&!used?.used_at,'Cannot change eligibility after this member has voted');
  
  const {error}=await db.from('members').update({eligible:!!data.eligible}).eq('id',data.member_id);if(error)throw error;
  await audit(user,'set_member_eligibility',{member_id:data.member_id,eligible:!!data.eligible});return {ok:true};
 }
 if(action==='admin.add_member'){
  const name=String(data.name||'').trim();assert(name.length>=3&&name.length<=160,'Please enter a valid member name');
  const {count}=await db.from('ballots').select('id',{head:true,count:'exact'});
  assert(!['closed','certified'].includes((await readSettings()).status),'Election is closed');
  const role=String(data.role||'voter');assert(['voter','candidate'].includes(role),'Invalid role');
  const committee=String(data.committee||'board');assert(role!=='candidate'||['board','audit','both'].includes(committee),'Invalid committee');
  const {data:existing,error:lookupError}=await db.from('members').select('id,eligible').ilike('name',name).maybeSingle();if(lookupError)throw lookupError;
  let memberId=existing?.id;
  if(!existing){const {data:created,error}=await db.from('members').insert({name,eligible:role==='voter'}).select('id').single();if(error)throw error;memberId=created.id;}
  else if(role==='voter'&&!existing.eligible){const {error}=await db.from('members').update({eligible:true}).eq('id',memberId);if(error)throw error;}
  else if(role==='voter'&&existing.eligible)throw Error('This person is already registered as a voter');
  if(role==='candidate'){
   const {data:prior,error:priorError}=await db.from('candidates').select('board,audit').eq('member_id',memberId).maybeSingle();if(priorError)throw priorError;
   const board=!!prior?.board||committee==='board'||committee==='both';const auditRole=!!prior?.audit||committee==='audit'||committee==='both';
   const {error}=await db.from('candidates').upsert({member_id:memberId,board,audit:auditRole,active:true,updated_at:new Date().toISOString()},{onConflict:'member_id'});if(error)throw error;
  }
  await audit(user,'add_member',{name,role,committee:role==='candidate'?committee:null});return {ok:true};
 }
 if(action==='admin.set_candidate'){
  assert(validId(data.member_id),'Invalid member ID');
  const {count}=await db.from('ballots').select('id',{head:true,count:'exact'});
  assert(!['closed','certified'].includes((await readSettings()).status),'Election is closed');
  const {data:prior,error:priorError}=await db.from('candidates').select('board,audit').eq('member_id',data.member_id).maybeSingle();if(priorError)throw priorError;
  assert(!(count&&((prior?.board&&!data.board)||(prior?.audit&&!data.audit))),'Existing nominations cannot be removed after voting begins');
  const {data:member,error:eMember}=await db.from('members').select('eligible').eq('id',data.member_id).single();
  assert(!eMember&&!!member,'Member not found');
  
  const {error}=await db.from('candidates').upsert({member_id:data.member_id,board:!!data.board,audit:!!data.audit,active:true,updated_at:new Date().toISOString()},{onConflict:'member_id'});
  if(error)throw error;await audit(user,'set_candidate',{member_id:data.member_id,board:!!data.board,audit:!!data.audit});return {ok:true};
 }
 if(action==='admin.update_settings')return await applySettings(data,user);
 if(action==='admin.set_tie'){
  const body=String(data.committee||'');const votes=Number(data.vote_count);
  assert(['board','audit'].includes(body)&&Number.isSafeInteger(votes)&&votes>0,'Invalid tie group');
  const candidates=await readCandidates();const results=await tallyResults(candidates);
  assert(body!=='audit'||!results.board.pending.length,'Resolve Board ties before finalizing Audit seats');
  const pending=results?.[body]?.pending?.find(t=>t.votes===votes);
  assert(!!pending,'This tie group is not unresolved');
  const ids=data.winner_ids;
  assert(Array.isArray(ids)&&ids.length===pending.available&&new Set(ids).size===ids.length,'Select the correct number of tied winners');
  assert(ids.every(id=>pending.candidates.some(c=>c.id===id)),'Tie resolution includes an ineligible candidate');
  const notes=String(data.notes||'').trim();assert(notes.length>=10&&notes.length<1500,'Provide a documented Election Committee decision (at least 10 characters)');
  const settings=await readSettings();assert(settings.status==='closed','Ties can be resolved only after the election closes');
  const {error}=await db.from('tie_breaks').upsert({committee:body,vote_count:votes,winner_ids:ids,notes,resolved_at:new Date().toISOString()},{onConflict:'committee,vote_count'});
  if(error)throw error;
  await audit(user,'resolve_tie',{committee:body,votes,winner_ids:ids,notes});return {ok:true};
 }
 throw Object.assign(new Error('Unknown administrator action'),{status:404});
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:HEADERS});
 if(req.method!=='POST')return fail('Use POST requests only',405);
 try{
  const size=Number(req.headers.get('content-length')||0);
  assert(size<20000,'Request is too large',413);
  const data=await req.json();const action=String(data.action||'');
  if(action.startsWith('admin.'))return ok(await handleAdmin(req,action,data));
  if(action==='snapshot'){
   const [settings,candidates]=await Promise.all([readSettings(),readCandidates()]);
   return ok({settings,candidates:candidates.filter(c=>c.active&&(c.board||c.audit))});
  }
  if(action==='public_results'){
   const settings=await readSettings();
   assert(settings.status==='certified'&&settings.results_published,'Results are not published yet',403);
   return ok({settings,results:await tallyResults(await readCandidates())});
  }
  if(['voter_list','verify','vote'].includes(action)){
   await limitRequest(req,action==='vote'?'vote':'verify');
   const pin=String(data.pin||'');assert(/^[0-9]{6,12}$/.test(pin),'Enter the election PIN');
   const {data:valid,error:pinError}=await db.rpc('check_election_pin',{p_pin:pin});if(pinError)throw pinError;assert(valid,'Incorrect election PIN',401);
   const settings=await readSettings();assert(nowAllowed(settings),'Voting is not currently open');
   if(action==='voter_list'){
    const [members,{data:used,error:e1},{data:legacy,error:e2}]=await Promise.all([readMembers(),db.from('voter_participation').select('member_id'),db.from('access_codes').select('member_id').not('used_at','is',null)]);
    if(e1)throw e1;if(e2)throw e2;const voted=new Set([...used,...legacy].map(x=>x.member_id));
    return ok({members:members.filter(m=>m.eligible&&!voted.has(m.id)).map(({id,name,vote_generation})=>({id,name,generation:vote_generation}))});
   }
   assert(validId(data.member_id),'Select your name');
   assert(Number.isInteger(data.generation),'Please enter the election again');
   if(action==='verify'){
    const {data:m,error}=await db.from('members').select('name,eligible,vote_generation').eq('id',data.member_id).single();if(error)throw error;
    const [{data:used,error:e1},{data:legacy,error:e2}]=await Promise.all([db.from('voter_participation').select('member_id').eq('member_id',data.member_id).maybeSingle(),db.from('access_codes').select('used_at').eq('member_id',data.member_id).maybeSingle()]);if(e1)throw e1;if(e2)throw e2;
    assert(m.eligible&&!used&&!legacy?.used_at,'This member has already voted or is not eligible');assert(m.vote_generation===data.generation,'Entry expired. Refresh the names');
    return ok({display_name:m.name,verified:true});
   }
   const board=data.board,audit=data.audit;
   assert(Array.isArray(board)&&Array.isArray(audit)&&board.length<=5&&audit.length<=3&&board.every(validId)&&audit.every(validId),'Invalid selections');
   const {error}=await db.rpc('cast_shared_ballot',{p_pin:pin,p_member_id:data.member_id,p_generation:data.generation,p_board:board,p_audit:audit});if(error)throw error;
   return ok({reference:'BEW-'+crypto.randomUUID().slice(0,8).toUpperCase()});
  }
  return fail('Unknown request',404);
 }catch(error){return safeError(error)}
});
