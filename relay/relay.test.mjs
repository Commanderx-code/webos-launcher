import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';

test('remote sign-in preserves key protection and secure cookies',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-auth-'));
  const key='a'.repeat(64),origin='https://tv.example.test';
  fs.writeFileSync(path.join(dir,'remote.key'),key,{mode:0o600});
  fs.writeFileSync(path.join(dir,'page.html'),'<h1>Cached remote</h1>');
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tv=http.createServer((req,res)=>{res.end('<h1>Live remote</h1>');});
  await new Promise((resolve,reject)=>{tv.once('error',reject);tv.listen(8765,'127.0.0.2',resolve);});
  const child=spawn(process.execPath,[new URL('./relay.mjs',import.meta.url).pathname],{
    env:{...process.env,TV_HOST:'127.0.0.2',TV_MAC:'00:11:22:33:44:55',PORT:String(port),DATA:dir,PUBLIC_ORIGIN:origin},stdio:'ignore',
  });
  t.after(async()=>{child.kill();await new Promise(r=>child.once('exit',r));if(tv.listening)await new Promise(r=>tv.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<80;i++){try{await fetch(base);ready=true;break;}catch{await new Promise(r=>setTimeout(r,25));}}
  assert.ok(ready);
  let r=await fetch(base);const page=await r.text();assert.equal(r.status,200);assert.match(page,/type="password"/);assert.ok(!page.includes(key));
  assert.equal((await fetch(base+'/api/state')).status,403);
  const login=(value,source=origin)=>fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Origin:source,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({key:value})});
  r=await login('wrong');assert.equal(r.status,403);assert.equal(r.headers.get('set-cookie'),null);
  assert.equal((await login(key,'https://other.example.test')).status,403);
  r=await login(key);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/');
  const cookie=r.headers.get('set-cookie');for(const flag of ['HttpOnly','SameSite=Lax','Secure'])assert.ok(cookie.includes(flag));
  r=await fetch(base,{headers:{Cookie:'k='+key}});assert.equal(r.status,200);assert.match(await r.text(),/Live remote/);
  r=await fetch(base+'/?k='+key,{redirect:'manual'});assert.equal(r.status,302);assert.match(r.headers.get('set-cookie'),/Secure/);
  await new Promise(r=>tv.close(r));
  r=await fetch(base,{headers:{Cookie:'k='+key}});assert.equal(r.status,200);assert.match(await r.text(),/Live remote/);
});
