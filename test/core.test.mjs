import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.GITHUB_REPO = 'example/repository';
process.env.GITHUB_BRANCH = 'main';
const {mentionAliases,githubConfig} = await import('../src/config.mjs');
const {authorized,processUpdate,safeName,boundedBytes,MAX_FILE_BYTES} = await import('../src/transport.mjs');
const {openStore} = await import('../src/store.mjs');
const {createGithubPublisher} = await import('../src/github-publisher.mjs');
const {createGithubInbox,extractAttachments} = await import('../src/github-inbox.mjs');
const {createTelegram} = await import('../src/telegram.mjs');

const config={userId:'123',chatId:'123'};
const update=(id,text)=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text}});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-gh-template-'));
  const store=openStore(dir),sent=[];
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,sent,api:{sendMessage:async(_id,text)=>sent.push(text)}};
}
test('generic GitHub repo config validates owner and branch',()=>{
  assert.equal(githubConfig().repo,'example/repository');
  assert.throws(()=>githubConfig({GITHUB_REPO:'../secret',GITHUB_BRANCH:'main'}));
});
test('mention aliases are optional and never hard-coded',()=>{
  assert.deepEqual(Object.entries(mentionAliases('reviewer:octocat')), [['reviewer','octocat']]);
  assert.throws(()=>mentionAliases('open:octocat'));
  assert.throws(()=>mentionAliases('admin:https://evil.test'));
});
test('only matching numeric Telegram user and private chat is authorized',()=>{
  assert.equal(authorized(update(1,'hello'),config),true);
  assert.equal(authorized({...update(1,'hello'),message:{...update(1,'hello').message,from:{id:999}}},config),false);
  assert.equal(authorized({...update(1,'hello'),message:{...update(1,'hello').message,chat:{id:123,type:'group'}}},config),false);
});
test('stores update once, advances cursor and restarts cleanly',async t=>{
  const f=fixture(t);
  await processUpdate(update(10,'hello'),{config,store:f.store,api:f.api});
  assert.equal(f.store.stats().count,1);
  assert.equal(f.store.getCursor(),10);
  assert.equal((await processUpdate(update(10,'hello'),{config,store:f.store,api:f.api})).status,'duplicate');
  const second=openStore(f.dir);
  assert.equal(second.integrity(),'ok');assert.equal(second.stats().count,1);second.close();
});
test('unsafe filenames are sanitized and download cap is bounded',async()=>{
  assert.equal(safeName('../../secret.js'),'secret.js');
  assert.equal(MAX_FILE_BYTES,16*1024*1024);
  await assert.rejects(boundedBytes(new Response(Buffer.alloc(6)),5),/File too large/);
});
function mockPublisher(){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const method=options.method;calls.push({url,method,body:options.body});
    if(method==='GET'&&/\/issues\/1$/.test(url))
      return new Response(JSON.stringify({number:1,title:'Sample issue',state:'open'}),{status:200});
    if(method==='GET'&&/\/issues\/1\/comments\?/.test(url))
      return new Response('[]',{status:200});
    if(method==='POST'&&/\/issues\/1\/comments$/.test(url))
      return new Response(JSON.stringify({html_url:'https://github.com/example/repository/issues/1#issuecomment-1'}),{status:201});
    return new Response('{}',{status:404});
  };
  return {github:createGithubPublisher('FAKE_TEST_TOKEN',{fetchImpl}),calls};
}
test('select open issue, post message with generic attribution and no fixed identities',async t=>{
  const f=fixture(t),m=mockPublisher();
  await processUpdate(update(1,'/open 1'),{config,...f,github:m.github});
  assert.equal(f.store.getActiveIssue(),1);
  await processUpdate(update(2,'Hello, world!'),{config,...f,github:m.github});
  const post=m.calls.find(c=>c.method==='POST');
  assert.ok(post);
  const body=JSON.parse(post.body).body;
  assert.match(body,/\*\*Message from Telegram\*\*/);
  assert.match(body,/Hello, world!/);
  assert.match(body,/telegram-github-bridge:update-id=2/);
  assert.ok(!body.includes('FAKE_TEST_TOKEN'));
});
test('configured inline mention appends only selected GitHub handle',async t=>{
  process.env.MENTION_ALIASES='reviewer:octocat';
  t.after(()=>{delete process.env.MENTION_ALIASES;});
  const f=fixture(t),m=mockPublisher();f.store.setActiveIssue(1);
  await processUpdate(update(2,'/reviewer Please review this'),{
    config,...f,github:m.github,aliases:mentionAliases()});
  const body=JSON.parse(m.calls.find(c=>c.method==='POST').body).body;
  assert.match(body,/Please review this\n\n@octocat/);
  assert.ok(!body.includes('/reviewer'));
});
test('slash command alone does not publish or persist content',async t=>{
  const f=fixture(t),m=mockPublisher();
  await processUpdate(update(4,'/ping'),{config,...f,github:m.github});
  assert.equal(f.store.stats().count,0);
  assert.equal(m.calls.filter(c=>c.method==='POST').length,0);
});
test('incoming markdown attachments include only configured repository paths',()=>{
  const content='![photo](https://github.com/example/repository/blob/main/files/1/photo.png?raw=1)';
  assert.equal(extractAttachments(content,1)[0].path,'files/1/photo.png');
  assert.equal(extractAttachments(content,2).length,0);
  assert.equal(extractAttachments('[bad](https://evil.example/a.png)',1).length,0);
});
test('new GitHub issue comments arrive with author and thread and dedupe',async t=>{
  const f=fixture(t);let time=Date.parse('2026-01-01T00:00:00Z');
  const inbox=createGithubInbox({store:f.store,api:f.api,chatId:'123',clock:()=>new Date(time),
    github:{
      listIssues:async()=>[{number:1,title:'Sample',state:'open',created_at:'2025-01-01T00:00:00Z'}],
      listCommentsSince:async()=>[{id:42,issue_url:'https://api.github.com/repos/example/repository/issues/1',
        created_at:'2026-01-01T00:00:02Z',body:'A public test comment',
        html_url:'https://github.com/example/repository/issues/1#issuecomment-42',user:{login:'example-user'}}]
    }});
  assert.equal((await inbox.poll()).initialized,true);
  time=Date.parse('2026-01-01T00:00:07Z');
  assert.equal((await inbox.poll()).delivered,1);
  assert.match(f.sent[0],/GitHub #1/);
  assert.match(f.sent[0],/example-user/);
  assert.equal((await inbox.poll()).delivered,0);
});
test('native Telegram photo uploads actual bytes using multipart form',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1]);
  const api=createTelegram('FAKE_TOKEN',{fetchImpl:async(url,options)=>{
    assert.match(url,/sendPhoto$/);
    assert.equal(options.body.get('chat_id'),'123');
    assert.equal(options.body.get('photo').name,'test.png');
    return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});
  }});
  assert.equal((await api.sendPhoto('123',bytes,'test.png')).message_id,1);
});
test('rejects arbitrary host GitHub attachments without fetching them',async()=>{
  let calls=0;
  const gh=createGithubPublisher('FAKE_TOKEN',{fetchImpl:async()=>{calls++;return new Response('file',{status:200})}});
  await assert.rejects(gh.getUserAttachment('https://evil.example/private.png'));
  assert.equal(calls,0);
});
