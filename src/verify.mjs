import {openStore} from './store.mjs';
import path from 'node:path';
process.umask(0o077);
const store=openStore(path.resolve(process.env.DATA_DIR || './data'));
const integrity=store.integrity();
console.log(JSON.stringify({integrity,...store.stats(),latest:store.latest()},null,2));
store.close();
if(integrity!=='ok')process.exitCode=1;
