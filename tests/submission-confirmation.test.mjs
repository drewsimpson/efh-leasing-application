import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const submit=html.slice(html.indexOf('  var submitting=false;'),html.indexOf('  /* ---------- nav buttons'));
async function check(fetch){
 const messages=[],done=[],next={disabled:false,textContent:'Submit application'};
 const ctx={fetch,FormData,window:{},collectPayload:()=>({}),document:{getElementById:()=>next,querySelectorAll:()=>[]},alert:m=>messages.push(m),showDone:(...args)=>done.push(args)};
 vm.createContext(ctx);vm.runInContext(submit,ctx);await ctx.submitApplication();return {messages,done,next};
}
for(const [name,fetch] of [
 ['network failure',async()=>{throw new Error('offline')}],
 ['invalid JSON',async()=>new Response('<html>error</html>')],
 ['HTTP error with misleading success',async()=>Response.json({ok:true,applicationNumber:'APP-ERROR'},{status:502})],
 ['missing reference',async()=>Response.json({ok:true})],
 ['API rejection',async()=>Response.json({ok:false,message:'Not saved'},{status:502})],
]) test(name+' preserves form and does not show success',async()=>{const r=await check(fetch);assert.equal(r.done.length,0);assert.equal(r.next.disabled,false);assert.equal(r.messages.length,1);});
test('confirmed response shows real server reference',async()=>{const r=await check(async()=>Response.json({ok:true,applicationNumber:'APP-REAL'}));assert.equal(r.done.length,1);assert.equal(r.done[0][0],'APP-REAL');assert.equal(r.messages.length,0);});
test('partial document failure includes saved reference and duplicate guidance',async()=>{const r=await check(async()=>Response.json({ok:false,captured:true,applicationNumber:'APP-PARTIAL',message:'Documents failed'},{status:502}));assert.equal(r.done.length,0);assert.match(r.messages[0],/APP-PARTIAL/);assert.match(r.messages[0],/duplicate/);});
