// Uses your already-local .env; prints only numeric IDs, never bot token or text.
const token=process.env.TELEGRAM_BOT_TOKEN;
if(!token||token==='PUT_YOUR_BOT_TOKEN_HERE')throw Error('Set TELEGRAM_BOT_TOKEN in .env');
const res=await fetch('https://api.telegram.org/bot'+token+'/getUpdates');
if(!res.ok)throw Error('Telegram request failed');
const data=await res.json();
if(!data.ok)throw Error('Telegram rejected request');
const items=data.result.filter(x=>x.message?.chat?.type==='private').slice(-5);
if(!items.length)console.log('Send your bot a private message, then rerun this command.');
for(const x of items)console.log('User ID:',x.message.from?.id,'Private chat ID:',x.message.chat.id);
