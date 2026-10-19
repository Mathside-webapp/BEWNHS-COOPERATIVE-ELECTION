import { CONFIG } from './config.js';
// A live election requires a hosted page and valid public Supabase settings.
export const isConfigured=location.protocol!=='file:' && /^https:\/\/[^\s/]+\.supabase\.co\/?$/i.test(CONFIG.SUPABASE_URL.trim()) && Boolean(CONFIG.SUPABASE_ANON_KEY.trim());
export class LiveAPI {
  constructor(){this.mode='live';this.token=sessionStorage.getItem('bewnhs_admin_token')||'';}
  get root(){return CONFIG.SUPABASE_URL.replace(/\/$/,'');}
  async call(action,payload={}) {
    const response=await fetch(`${this.root}/functions/v1/${CONFIG.FUNCTION_NAME}`,{
      method:'POST',headers:{'Content-Type':'application/json','apikey':CONFIG.SUPABASE_ANON_KEY,'Authorization':'Bearer '+(this.token||CONFIG.SUPABASE_ANON_KEY)},
      body:JSON.stringify({action,...payload})
    });
    let data;try{data=await response.json()}catch(_){throw Error('Could not contact the election server. Check the deployment configuration.');}
    if(!response.ok || data.error) throw Error(data.error||`Election server returned ${response.status}.`);
    return data;
  }
  async snapshot(){return this.call('snapshot');}
  async voterList(pin){return this.call('voter_list',{pin});}
  async verify(pin,member_id,generation){return this.call('verify',{pin,member_id,generation});}
  async publicResults(){return this.call('public_results');}
  async vote(selection){return this.call('vote',selection);}
  async login(email,password){
    const res=await fetch(`${this.root}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'Content-Type':'application/json','apikey':CONFIG.SUPABASE_ANON_KEY},body:JSON.stringify({email,password})});
    const data=await res.json();
    if(!res.ok || !data.access_token) throw Error(data.msg||data.error_description||'Incorrect email or password.');
    this.token=data.access_token;
    try{await this.call('admin.overview');}catch(e){this.token='';throw Error('This account is not authorized to manage elections. '+e.message)}
    sessionStorage.setItem('bewnhs_admin_token',this.token);
    return {ok:true};
  }
  async logout(){this.token='';sessionStorage.removeItem('bewnhs_admin_token');}
  async admin(action,payload={}){return this.call('admin.'+action,payload);}
}
