import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mentionAliases } from './config.mjs';
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export function authorized(update, config) {
  const m = update?.message;
  return !!m && !!m.from && String(m.from.id) === String(config.userId) &&
    String(m.chat?.id) === String(config.chatId) && m.chat?.type === 'private';
}
export function safeName(value) {
  const base = String(value || 'attachment.bin').replace(/\\/g, '/').split('/').pop();
  return base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/,'').slice(0,100) || 'attachment.bin';
}
export async function boundedBytes(response, max = MAX_FILE_BYTES) {
  if (!response.ok || !response.body) throw new Error('Download failed');
  if (Number(response.headers.get('content-length')) > max) throw new Error('File too large');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new Error('File too large');
      chunks.push(value);
    }
  } catch(e) { await reader.cancel().catch(()=>{}); throw e; }
  return Buffer.concat(chunks,length);
}
export function incomingFile(m) {
  if (m.document) return {id:m.document.file_id,name:safeName(m.document.file_name),size:m.document.file_size??null,kind:'document'};
  for (const kind of ['video','animation','audio','video_note']) if (m[kind]?.file_id)
    return {id:m[kind].file_id,name:safeName(m[kind].file_name||kind+'.mp4'),
      size:m[kind].file_size??null,kind};
  if (m.photo?.length) {const x=m.photo.at(-1);return{id:x.file_id,name:'photo.jpg',size:x.file_size??null,kind:'photo'};}
  return null;
}
export async function saveFile(dataDir,file,bytes,id) {
  const folder=path.join(dataDir,'files');
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const name=id+'-'+randomUUID()+'-'+safeName(file.name);
  await fs.writeFile(path.join(folder,name),bytes,{flag:'wx',mode:0o600});
  return {original_name:file.name,saved_name:name,sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length};
}
export async function processUpdate(update,{config,store,api,fetchFile,github=null,aliases=mentionAliases()}) {
  const id=update?.update_id;
  if (!Number.isSafeInteger(id)||id<0) throw new Error('Invalid update ID');
  if (id<=store.getCursor()) return {status:'duplicate'};
  if (update.callback_query) {
    const cb=update.callback_query;
    const allowed=String(cb.from?.id)===String(config.userId) &&
      String(cb.message?.chat?.id)===String(config.chatId) && cb.message?.chat?.type==='private';
    if (!allowed) {store.advance(id);return {status:'unauthorized'};}
    const handle=cb.data?.startsWith('mention:')?cb.data.slice(8):'';
    if (Object.values(aliases).includes(handle)) store.setPendingMention(handle);
    store.advance(id);
    if (api.answerCallbackQuery) await api.answerCallbackQuery(cb.id,handle?'Selected':'Unknown').catch(()=>{});
    return {status:'command'};
  }
  if (!authorized(update,config)) {store.advance(id);return{status:'unauthorized'};}
  if (store.has(id)) {store.advance(id);return{status:'duplicate'};}
  const m=update.message, input=String(m.text??m.caption??'');
  const match=input.trimStart().match(/^\/([a-z][a-z0-9_]*)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]+))?$/i);
  const key=match?.[1]?.toLowerCase(), target=key&&Object.hasOwn(aliases,key)?aliases[key]:null;
  const inline=target&&match?.[2]?.trim()?match[2].trim():null;
  if (input.trimStart().startsWith('/')&&!inline) {
    let response='';
    try {
      if (key==='start'||key==='help') response='Telegram ↔ GitHub bridge. /threads lists issues; /open NUMBER selects one; then send messages/files. /who, /close, /status, /last, /mentions, /cancel.';
      else if (key==='ping') response='Pong — bridge online.';
      else if (key==='status') response='Stored '+store.stats().count+' messages; selected issue #'+(store.getActiveIssue()||'none')+'.';
      else if (key==='last') response=store.latest().map(r=>r.kind+' #'+r.update_id).join('\n')||'No stored messages.';
      else if (key==='close') {store.clearActiveIssue();store.clearPendingMention();response='Issue selection cleared.';}
      else if (key==='who') response='Selected issue #'+(store.getActiveIssue()||'none')+'; pending mention '+(store.getPendingMention()||'none');
      else if (key==='cancel') {store.clearPendingMention();response='Pending mention cleared.';}
      else if (key==='threads') {
        if(!github) throw Error('GitHub integration is not configured');
        response=(await github.listIssues()).filter(x=>x.state==='open').slice(0,20)
          .map(x=>'#'+x.number+' '+String(x.title).slice(0,90)).join('\n')||'No open issues.';
      } else if (key==='open') {
        if(!github) throw Error('GitHub integration is not configured');
        const n=Number(match?.[2]?.trim());
        if(!Number.isSafeInteger(n)||n<1) throw Error('Use /open NUMBER');
        const issue=await github.getIssue(n);
        store.clearPendingMention();store.setActiveIssue(n);
        response='Selected GitHub #'+issue.number+': '+issue.title+'\n'+issue.url;
      } else if (key==='github') {
        response=github?'GitHub connected. Select an issue with /open NUMBER.':'GitHub integration disabled.';
      } else if (key==='mentions') {
        const entries=Object.values(aliases);
        if (!entries.length) response='No mention aliases configured in MENTION_ALIASES.';
        else {
          response='Pick a handle to add to the next message.';
          store.advance(id);
          await api.sendMessage(m.chat.id,response,{reply_markup:{inline_keyboard:
            Array.from({length:Math.ceil(entries.length/2)},(_,i)=>entries.slice(i*2,i*2+2).map(h=>({text:'@'+h,callback_data:'mention:'+h})))}}).catch(()=>{});
          return {status:'command'};
        }
      } else if (target) {
        store.setPendingMention(target);
        response='The next message will tag @'+target+'. Use /cancel to clear.';
      } else response='Unknown command. Use /help.';
    } catch { response='Command not completed. Check your configuration and destination issue.'; }
    store.advance(id);
    await api.sendMessage(m.chat.id,response).catch(()=>{});
    return{status:'command'};
  }
  const file=incomingFile(m);let kind=file?.kind||'text';
  let content=inline??m.text??m.caption??null,bytes=null,meta={original_name:null,saved_name:null,sha256:null,size_bytes:null},error=null;
  if(file) {
    if(file.size!==null&&file.size>MAX_FILE_BYTES){kind='rejected_file';error='File exceeds 16 MiB limit.';}
    else try {bytes=await fetchFile(file.id,MAX_FILE_BYTES,file.size);meta=await saveFile(store.dataDir,file,bytes,id);}
    catch {kind='rejected_file';error='File could not be downloaded safely.';}
  } else if (!m.text){kind='other';content=null;error='Unsupported message type.';}
  store.record({update_id:id,message_id:m.message_id||0,chat_id:String(m.chat.id),
    user_id:String(m.from.id),kind,content,created_at:new Date().toISOString(),...meta});
  store.advance(id);
  const mention=inline?target:(store.getPendingMention()||null);
  if(mention)store.clearPendingMention();
  let result=error||'Saved locally. Select a GitHub issue with /open NUMBER.';
  if(!error&&github&&store.getActiveIssue()) {
    try {
      const out=await github.publish({issueNumber:store.getActiveIssue(),updateId:id,
        text:content||'',attachment:bytes?{bytes,name:file.name,kind}:null,mention});
      result='GitHub #'+store.getActiveIssue()+' '+(out.status==='posted'?'published':'already published')+': '+out.url;
    } catch {result='Saved locally; GitHub publishing was not confirmed. Inspect the selected issue before resending.';}
  }
  await api.sendMessage(m.chat.id,result).catch(()=>{});
  return{status:'stored',kind};
}
