import {openStore} from './store.mjs';
import {processUpdate} from './transport.mjs';
import {createTelegram} from './telegram.mjs';
import {createGithubPublisher} from './github-publisher.mjs';
import {createGithubInbox,INBOX_POLL_MS} from './github-inbox.mjs';
import {mentionAliases,githubConfig} from './config.mjs';

process.umask(0o077);
const env=process.env;
const userId=env.TELEGRAM_USER_ID, chatId=env.TELEGRAM_CHAT_ID, token=env.TELEGRAM_BOT_TOKEN;
if(!token||token==='PUT_YOUR_BOT_TOKEN_HERE'||!/^\d+$/.test(userId||'')||!/^\d+$/.test(chatId||'')){
  console.error('Set a real bot token and numeric TELEGRAM_USER_ID and TELEGRAM_CHAT_ID');
  process.exit(1);
}
let github=null,aliases;
try{
  aliases=mentionAliases();
  if(env.GITHUB_TOKEN&&env.GITHUB_TOKEN!=='PUT_YOUR_GITHUB_TOKEN_HERE'){
    githubConfig();
    github=createGithubPublisher(env.GITHUB_TOKEN);
  }
}catch{console.error('Invalid GitHub repository or mention configuration');process.exit(1);}
const store=openStore(env.DATA_DIR? (await import('node:path')).resolve(env.DATA_DIR): (await import('node:path')).resolve('./data'));
const api=createTelegram(token);
let stopping=false, nextInbox=0, delay=1000;
const inbox=github?createGithubInbox({github,api,store,chatId}):null;
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{stopping=true;});
const commands=[
  {command:'start',description:'How to use this bridge'},
  {command:'ping',description:'Check connection'},
  {command:'status',description:'Show storage status'},
  {command:'last',description:'Recent messages'},
  {command:'threads',description:'List GitHub issues'},
  {command:'open',description:'Select GitHub issue'},
  {command:'close',description:'Clear issue selection'},
  {command:'who',description:'Selected issue and pending mention'},
  {command:'cancel',description:'Clear pending mention'},
  {command:'mentions',description:'Pick a configured mention'},
  ...Object.keys(aliases).map(command=>({command,description:'Message and tag @'+aliases[command]}))
];
try{await api.setMyCommands(chatId,commands);}catch{console.error('Bot command menu registration failed');}
console.log('GitHub Telegram bridge started; GitHub '+(github?'enabled':'disabled'));
while(!stopping){
  try{
    if(inbox && Date.now()>=nextInbox){
      nextInbox=Date.now()+INBOX_POLL_MS;
      try{await inbox.poll();}catch{console.error('GitHub inbox temporarily unavailable');}
    }
    const updates=await api.getUpdates(store.getCursor()+1);
    for(const update of updates){if(stopping)break;await processUpdate(update,{
      config:{userId,chatId},store,api,github,aliases,fetchFile:api.fetchFile
    });}
    delay=1000;
  }catch{
    console.error('Bridge polling/persistence error');
    await new Promise(resolve=>setTimeout(resolve,delay));
    delay=Math.min(delay*2,30000);
  }
}
store.close();
console.log('Bridge stopped.');
