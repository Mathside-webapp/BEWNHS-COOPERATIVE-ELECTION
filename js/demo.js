import { MEMBERS } from './content.js';
import { calculateResults } from './results.js';
const STORE_KEY='bewnhs_election_demo_shared_v1';
const DEMO_CODE='202610';
const clone = obj => JSON.parse(JSON.stringify(obj));
function starter() {
  const members=MEMBERS.map((name,i)=>({id:`member-${i+1}`,name,eligible:true,voted:i<18,generation:0,submitted_at:i<18?new Date().toISOString():null,resettable:i<18}));
  const candidates=members.map(m=>({id:`candidate-${m.id}`,member_id:m.id,name:m.name,board:true,audit:true,active:true}));
  const ballots=[];
  for(let i=0;i<18;i++) {
    // Deliberate, non-random sample showing Board priority and Audit promotion.
    const board = i<10?[0,1,2,3,4]:i<14?[0,1,2,3,5]:[0,1,2,4,6];
    const audit = i<7?[0,1,8]:i<11?[0,8,9]:i<14?[1,9,10]:i<16?[8,9,10]:[8,10,11];
    ballots.push({member_id:members[i].id,board:board.map(n=>candidates[n].id),audit:audit.map(n=>candidates[n].id)});
  }
  return {pin:DEMO_CODE,reset_log:[],settings:{status:'open',title:'BEWNHS Cooperative Election',starts_at:null,ends_at:null,allow_partial:false,results_published:false},members,candidates,ballots,tie_breaks:[],demo_voted:false};
}
export class DemoAPI {
  constructor(){this.mode='demo';this.state=this.load();}
  load(){try {const old=JSON.parse(localStorage.getItem(STORE_KEY)); if(old && old.members?.length>0 && old.ballots) return old;}catch(_){}if(this.state)return this.state;const s=starter();this.save(s);return s;}
  save(s=this.state){
    // Some privacy-focused browsers deny localStorage on file:// pages.
    // The demo remains usable in memory, even when persistence is unavailable.
    try { localStorage.setItem(STORE_KEY,JSON.stringify(s)); } catch (_) {}
  }
  reset(){this.state=starter();this.save();}
  async snapshot(){return {settings:clone(this.state.settings),candidates:clone(this.state.candidates.filter(c=>c.active))};}
  refresh(){this.state=this.load();}
  checkPin(pin){if(pin!==this.state.pin)throw Error('Incorrect election PIN');const s=this.state.settings;if(s.status!=='open'||(s.starts_at&&Date.now()<Date.parse(s.starts_at))||(s.ends_at&&Date.now()>=Date.parse(s.ends_at)))throw Error('Voting is not currently open');}
  async voterList(pin){this.refresh();this.checkPin(pin);return {members:clone(this.state.members.filter(m=>m.eligible&&!m.voted).map(m=>({id:m.id,name:m.name,generation:m.generation||0})))};}
  async verify(pin,member_id,generation){this.refresh();this.checkPin(pin);const m=this.state.members.find(m=>m.id===member_id);if(!m||!m.eligible||m.voted)throw Error('This member has already voted or is not eligible');if((m.generation||0)!==generation)throw Error('Entry expired. Refresh the names');return {display_name:m.name,verified:true};}
  async vote({pin,member_id,generation,board,audit}) {
    await this.verify(pin,member_id,generation);
    this.refresh();const member=this.state.members.find(m=>m.id===member_id);if(member.voted)throw Error('This member has already voted');
    const s=this.state.settings;
    if(!s.allow_partial && (board.length!==5 || audit.length!==3)) throw Error('Please choose five Board and three Audit candidates.');
    if(board.length>5 || audit.length>3 || new Set(board).size!==board.length || new Set(audit).size!==audit.length) throw Error('Invalid selection count or duplicate candidates.');
    for(const [ids,body] of [[board,'board'],[audit,'audit']]) if(ids.some(id=>!this.state.candidates.some(c=>c.id===id && c.active && c[body]))) throw Error('One or more candidates are no longer eligible.');
    this.state.ballots.push({member_id,board:clone(board),audit:clone(audit)});
    member.voted=true;member.submitted_at=new Date().toISOString();member.resettable=true;
    this.save();
    return {reference:'DEMO-'+Math.random().toString(36).slice(2,10).toUpperCase()};
  }
  async publicResults(){if(this.state.settings.status!=='certified'||!this.state.settings.results_published)throw Error('Results have not been officially published in this demo.');return {settings:clone(this.state.settings),results:calculateResults(this.state.candidates.filter(c=>c.active&&c.board),this.state.candidates.filter(c=>c.active&&c.audit),this.state.ballots,this.state.tie_breaks)};}
  async login(){return {demo:true};}
  async logout(){}
  async admin(action,payload={}) {
    this.refresh();const s=this.state;
    if(action==='overview') {
      const results=calculateResults(s.candidates.filter(c=>c.active && c.board),s.candidates.filter(c=>c.active && c.audit),s.ballots,s.tie_breaks);
      const resultAllowed=['closed','certified'].includes(s.settings.status);
      return {pin_configured:true,current_pin:s.pin,reset_log:clone(s.reset_log),settings:clone(s.settings),members:clone(s.members),candidates:clone(s.candidates),ballots_count:s.ballots.length,eligible_count:s.members.filter(m=>m.eligible).length,voted_count:s.members.filter(m=>m.voted).length,results:resultAllowed?results:null,tie_breaks:clone(s.tie_breaks)};
    }
    if(action==='set_candidate') {
      if(['closed','certified'].includes(s.settings.status))throw Error('Election is closed');
      let c=s.candidates.find(c=>c.member_id===payload.member_id);if(!c){const m=s.members.find(m=>m.id===payload.member_id);if(!m)throw Error('Person not found.');c={id:'candidate-'+m.id,member_id:m.id,name:m.name,board:false,audit:false,active:true};s.candidates.push(c);}
      if(s.ballots.length&&((c.board&&!payload.board)||(c.audit&&!payload.audit)))throw Error('Existing nominations cannot be removed after voting begins');
      c.board=!!payload.board;c.audit=!!payload.audit;this.save();return {ok:true};
    }
    if(action==='set_member') {
      const m=s.members.find(m=>m.id===payload.member_id);if(!m)throw Error('Member not found.');
      if(m.voted) throw Error('Cannot change eligibility after a ballot has been cast.');
      m.eligible=!!payload.eligible;this.save();return {ok:true};
    }
    if(action==='add_member') {
      if(['closed','certified'].includes(s.settings.status))throw Error('Election is closed');
      const name=String(payload.name||'').trim();if(!name)throw Error('Enter a valid name.');
      const role=payload.role||'voter';const committee=payload.committee||'board';let m=s.members.find(m=>m.name.toLowerCase()===name.toLowerCase());
      if(!m){const id='member-'+crypto.randomUUID();m={id,name,eligible:role==='voter',voted:false,has_code:false};s.members.push(m);}
      else if(role==='voter'&&!m.eligible)m.eligible=true;
      else if(role==='voter')throw Error('Already registered to vote');
      if(role==='candidate'){let c=s.candidates.find(c=>c.member_id===m.id);if(!c){c={id:'candidate-'+m.id,member_id:m.id,name,board:false,audit:false,active:true};s.candidates.push(c);}c.board ||= committee==='board'||committee==='both';c.audit ||= committee==='audit'||committee==='both';}
      this.save();return {ok:true};
    }
    if(action==='set_pin'){if(!/^[0-9]{6,12}$/.test(payload.pin))throw Error('Use a 6 to 12 digit PIN');s.pin=payload.pin;this.save();return {ok:true};}
    if(action==='reset_vote'){const m=s.members.find(m=>m.id===payload.member_id);if(!m?.voted||!m.resettable)throw Error('No resettable ballot');if(s.settings.status==='certified')throw Error('Certified results cannot be reset');if((payload.reason||'').trim().length<5||payload.reason.length>1000)throw Error('Provide a reason (5 to 1000 characters)');s.ballots=s.ballots.filter(b=>b.member_id!==m.id);m.voted=false;m.submitted_at=null;m.resettable=false;m.generation=(m.generation||0)+1;s.tie_breaks=[];s.settings.results_published=false;if(s.settings.status==='closed')s.settings.status='paused';s.reset_log.unshift({admin_id:'Demo administrator',logged_at:new Date().toISOString(),details:{member_id:m.id,reason:payload.reason.trim()}});this.save();return {ok:true};}
    if(action==='update_settings') {
      const next=payload.status || s.settings.status;
      if(!['draft','open','paused','closed','certified'].includes(next))throw Error('Invalid status.');
      if(next==='certified'){
        const results=calculateResults(s.candidates.filter(c=>c.active && c.board),s.candidates.filter(c=>c.active && c.audit),s.ballots,s.tie_breaks);
        if(results.board.pending.length || results.board.shortage || !results.audit || results.audit.pending.length || results.audit.shortage) throw Error('Resolve ties and ensure every seat is filled before certification.');
      }
      s.settings={...s.settings,...payload};this.save();return {ok:true};
    }
    if(action==='set_tie') {
      s.tie_breaks=s.tie_breaks.filter(t=>!(t.committee===payload.committee && t.vote_count===payload.vote_count));
      s.tie_breaks.push({committee:payload.committee,vote_count:Number(payload.vote_count),winner_ids:payload.winner_ids,notes:payload.notes||'Resolved by election committee'});this.save();return {ok:true};
    }
    if(action==='reset_demo'){this.reset();return {ok:true};}
    throw Error('Demo action not available: '+action);
  }
}
export const DEMO_ACCESS_CODE=DEMO_CODE;
