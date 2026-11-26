/* Execute the real callback and bootstrap against controlled Supabase responses. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const recovery = fs.readFileSync('js/recovery.js','utf8');
const bootstrap = fs.readFileSync('js/supabase.js','utf8');
const page = fs.readFileSync('recover.html','utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const user = {id:'account'};
const exp = Math.floor(Date.now()/1000)+3600;
function jwt(method='otp', session='recovery-session', expiry=exp) {
  const claims={sub:user.id,exp:expiry,session_id:session,amr:[{method}]};
  return 'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
}
const access=jwt();
const callback=(token=access)=>'#type=recovery&access_token='+token+'&refresh_token=refresh';

async function setup(suffix='', options={}) {
  const location=new URL('https://example.test/recover.html'+suffix);
  const calls=[], elements={};
  for (const [,id] of page.matchAll(/\bid="([^"]+)"/g)) {
    elements[id]={value:'',textContent:'',hidden:false,disabled:false,handlers:{},attributes:{},
      addEventListener(name,listener){this.handlers[name]=listener;},
      async fire(name){await this.handlers[name]({preventDefault(){},currentTarget:this});await tick();},
      setAttribute(k,v){this.attributes[k]=v;},classList:{toggle(){}},checkValidity(){return true;},replaceChildren(){},append(){},
      focus(){},reset(){elements['new-password'].value=elements['confirm-new-password'].value='';}};
  }
  for (const id of ['new-password-form','request-recovery-form','verify-recovery','completed-login','recovery-mfa-form','recovery-factor-help']) elements[id].hidden=true;
  elements['new-password'].type='password';
  const session={user,access_token:jwt('otp',options.otherSession?'different':'recovery-session'),expires_at:exp};
  const auth={
    async verifyOtp(args){calls.push(['otp',args]);return options.used?{error:{code:'otp_expired'}}:{data:{session}};},
    async getUser(token){calls.push(['identity',token]);return {data:{user:options.switched&&!token?{id:'other'}:user}};},
    async refreshSession(args){calls.push(['refresh',args]);return options.revoked?{error:{}}:{data:{session}};},
    async updateUser(args){calls.push(['update',args]);return options.writeError&&!options.aal2?{error:options.writeError}:{data:{user}};},
    mfa:{
      async listFactors(){calls.push(['factors']);return {data:{totp:options.factors || []}};},
      async challengeAndVerify(args){
        calls.push(['challenge',args]);
        if(args.code!=='123456')return {error:{status:400}};
        options.aal2=true;return {data:{access_token:access}};
      }
    },
    async signOut(args){calls.push(['logout',args]);return {error:null};},
    async resetPasswordForEmail(email,args){calls.push(['email',email,args]);return {error:null};},
    async getSession(){throw new Error('Recovery must never trust a stored login.');}
  };
  let ready;
  const ctx={URLSearchParams,atob,Date,location,history:{replaceState:(_,__,to)=>{location.href=new URL(to,location.origin).href;}},
    window:{supabaseReady:Promise.resolve({auth}),addEventListener(){}},
    document:{getElementById:id=>elements[id],createElement:()=>({}),addEventListener:(name,fn)=>{if(name==='DOMContentLoaded')ready=fn;}}};
  vm.runInNewContext(recovery,ctx);
  assert.equal(location.hash,''); assert(!location.search.includes('token')); ready(); await tick();
  const count=key=>calls.filter(([keyName])=>keyName===key).length;
  async function update(password='a test password',confirmation=password) {
    elements['new-password'].value=password;elements['confirm-new-password'].value=confirmation;
    await elements['new-password-form'].fire('submit');
  }
  return {elements,calls,count,update};
}
async function checkBootstrap(path,suffix) {
  const address=new URL('https://example.test/'+path+suffix);
  const location={pathname:address.pathname,hash:address.hash,search:address.search,origin:address.origin,replace(url){this.redirect=url;}};
  let clientOptions, fetches=0;
  const ctx={URL,URLSearchParams,console:{log(){},error(){}},window:{location,supabase:{createClient(...args){clientOptions=args[2];return {};}}},
    fetch:async()=>{fetches++;return {ok:true,json:async()=>({supabaseUrl:'https://example.supabase.co',supabaseKey:'public'})};}};
  vm.runInNewContext(bootstrap,ctx);await tick();
  return {location,clientOptions,fetches};
}
(async()=>{
  for(const suffix of ['', '#type=signup&token_hash=unused','#type=recovery&access_token=unpaired',
    '#error=access_denied&error_code=otp_expired','#type=recovery&type=recovery&token_hash=ambiguous']) {
    const f=await setup(suffix);
    assert(f.elements['new-password-form'].hidden); assert(!f.elements['request-recovery-form'].hidden);
    await f.update(); assert.equal(f.count('update'),0); assert.equal(f.count('otp'),0);
  }
  for(const [token,options] of [[jwt('password'),{}],[jwt('otp','recovery-session',1),{}],
    [access,{revoked:true}],[access,{otherSession:true}]]) {
    const f=await setup(callback(token),options);
    assert(f.elements['new-password-form'].hidden);assert(!f.elements['request-recovery-form'].hidden);
  }
  const valid=await setup('?role=teacher'+callback());
  assert(!valid.elements['new-password-form'].hidden);
  assert.equal(valid.count('refresh'),1);
  await valid.update('short');await valid.update('new-password','mismatch');assert.equal(valid.count('update'),0);
  await valid.elements['reveal-password'].fire('click');assert.equal(valid.elements['new-password'].type,'text');
  await valid.update();assert.equal(valid.count('update'),1);assert.equal(valid.count('logout'),1);
  assert.equal(valid.elements['completed-login'].href,'teacher-login.html?recovered=1');
  assert.equal(valid.elements['new-password'].value,'');assert(valid.elements['new-password-form'].hidden);
  await valid.update();assert.equal(valid.count('update'),1);
  const hash=await setup('#type=recovery&token_hash=valid');
  assert.equal(hash.count('otp'),0);assert(!hash.elements['verify-recovery'].hidden);
  await hash.elements['verify-recovery'].fire('click');assert(!hash.elements['new-password-form'].hidden);
  assert.equal(hash.calls[0][1].type,'recovery');assert.equal(hash.calls[0][1].token_hash,'valid');
  const used=await setup('?role=teacher&type=recovery&token_hash=spent',{used:true});
  await used.elements['verify-recovery'].fire('click');assert(!used.elements['request-recovery-form'].hidden);
  used.elements['recovery-email'].value='teacher@example.test';await used.elements['request-recovery-form'].fire('submit');
  assert.equal(used.calls.at(-1)[2].redirectTo,'https://example.test/recover.html?role=teacher');
  const denied=await setup(callback(),{switched:true});await denied.update();assert.equal(denied.count('update'),0);
  const mfa=await setup(callback(),{writeError:{status:403,code:'insufficient_aal'}});await mfa.update();
  assert.match(mfa.elements['recovery-message'].textContent,/second factor/);assert.equal(mfa.count('logout'),0);
  assert(!mfa.elements['recovery-factor-help'].hidden);
  const protectedAccount=await setup(callback(),{writeError:{status:403,code:'insufficient_aal'},factors:[
    {id:'primary',status:'verified'},{id:'second',status:'verified',friendly_name:'Backup'},{id:'unused',status:'unverified'}]});
  await protectedAccount.update();
  const e=protectedAccount.elements;
  assert(e['new-password-form'].hidden);assert(!e['recovery-mfa-form'].hidden);assert(!e['recovery-factor-choice'].hidden);
  e['recovery-factor'].value='unused';e['recovery-code'].value='123456';await e['recovery-mfa-form'].fire('submit');
  assert.equal(protectedAccount.count('challenge'),0);
  e['recovery-factor'].value='second';e['recovery-code'].value='000000';await e['recovery-mfa-form'].fire('submit');
  assert.equal(protectedAccount.count('challenge'),1);assert(e['new-password-form'].hidden);assert.equal(e['recovery-code'].value,'');
  e['recovery-code'].value='123456';await e['recovery-mfa-form'].fire('submit');
  assert.equal(protectedAccount.calls.at(-1)[1].factorId,'second');assert(e['recovery-mfa-form'].hidden);assert(!e['new-password-form'].hidden);
  await protectedAccount.update(); assert.equal(protectedAccount.count('update'),2);assert.equal(protectedAccount.count('logout'),1);
  assert(!e['completed-login'].hidden);
  const normal=await checkBootstrap('index.html','');assert.equal(normal.clientOptions,undefined);assert.equal(normal.fetches,1);
  const recoveryOnly=await checkBootstrap('recover.html','');assert.equal(recoveryOnly.clientOptions.auth.persistSession,false);
  assert.equal(recoveryOnly.clientOptions.auth.detectSessionInUrl,false);assert.equal(recoveryOnly.clientOptions.auth.autoRefreshToken,false);
  const legacy=await checkBootstrap('teacher-login.html',callback());assert.equal(legacy.fetches,0);
  assert(new URL(legacy.location.redirect).href.startsWith('https://example.test/recover.html?role=teacher#'));
  console.log('PASS recovery sessions, legacy redirects, URL cleanup, form validation, stale/used links, MFA response, password update and role-aware return.');
})().catch(error=>{console.error(error);process.exitCode=1;});
