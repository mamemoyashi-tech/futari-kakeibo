const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
let source=fs.readFileSync(require('node:path').join(__dirname,'..','app.js'),'utf8').replace(/import[\s\S]*?from "https:[^"]+";/g,'');source=source.slice(0,source.lastIndexOf('\nwireUI();'));
const nodes=new Map();function node(){return {value:'',textContent:'',hidden:false,disabled:false,children:[],listeners:{},clientWidth:390,scrollWidth:390,append(...v){this.children.push(...v)},appendChild(v){this.children.push(v)},replaceChildren(){this.children=[]},addEventListener(k,f){(this.listeners[k]??=[]).push(f)},setAttribute(){},focus(){}}}function el(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)}
const docEvents=node();const c=vm.createContext({console,getComputedStyle:n=>({overflowX:n.overflowX||'visible'}),document:{getElementById:el,createElement:node,body:node(),addEventListener:docEvents.addEventListener.bind(docEvents)},window:{innerWidth:390,addEventListener(){}},requestAnimationFrame:f=>f(),confirm:()=>true});vm.runInContext(source,c);
vm.runInContext(`
let server=new Map(),nextId=0,writes=0,subscription,errorCallback;
collection=(...args)=>args;doc=(...args)=>args.length===1?{id:'note-'+(++nextId)}:args.at(-1);Timestamp={now:()=>({toMillis:()=>Date.now()})};serverTimestamp=()=>1;
onSnapshot=(ref,opts,cb,err)=>{subscription=cb;errorCallback=err;return ()=>{};};
runTransaction=async(db,fn)=>fn({get:async ref=>({exists:()=>server.has(ref),data:()=>server.get(ref)}),set:(ref,data)=>{server.set(ref,data);writes++;}});
wireNotes();db={};uid='test';householdId='test';displayName='test';isConnected=true;
function sync(){subscription({metadata:{fromCache:false,hasPendingWrites:false},docs:[...server.entries()].map(([id,data])=>({id,data:()=>data}))});}
startNotes();sync();
`,c);
const run=s=>vm.runInContext(s,c);const type=(id,value)=>{el(id).value=value;el(id).listeners.input[0]();};
(async()=>{
run('openNote()');type('noteTitle','買い物');type('sharedNote','牛乳');await run('saveNote()');assert.equal(run('server.size'),1);assert.equal(el('notesList').children.length,1);assert.equal(run('noteRevision'),1);
run('backToNotes();openNote()');type('noteTitle','旅行');type('sharedNote','スペイン');await run('saveNote()');assert.equal(run('server.size'),2);assert.equal(el('notesList').children.length,2);
run("backToNotes();openNote('note-1')");assert.equal(el('noteTitle').value,'買い物');assert.equal(el('sharedNote').value,'牛乳');type('sharedNote','牛乳と卵');await run('saveNote()');assert.equal(run("server.get('note-1').text"),'牛乳と卵');assert.equal(run("server.get('note-2').text"),'スペイン');
type('sharedNote','競合した下書き');run("server.set('note-1',{title:'相手の更新',text:'相手',revision:9});sync()");const before=run('writes');await run('saveNote()');assert.equal(run('writes'),before);assert.equal(el('sharedNote').value,'競合した下書き');assert.equal(el('btnReloadNote').hidden,false);
el('btnReloadNote').listeners.click[0]();assert.equal(el('sharedNote').value,'相手');await run('deleteNote()');assert.equal(run("server.get('note-1').deleted"),true);assert.equal(el('notesList').children.length,1);
run("server.set('shared',{text:'旧版のメモ',revision:1});sync();openNote('shared')");assert.equal(el('sharedNote').value,'旧版のメモ');
type('sharedNote','削除後も残す下書き');run("server.set('shared',{deleted:true,revision:2});sync()");const b=run('writes');await run('saveNote()');assert.equal(run('writes'),b);assert.equal(el('sharedNote').value,'削除後も残す下書き');
run('stopNotes()');assert.equal(el('notesList').children.length,0);assert.equal(el('noteTitle').value,'');assert.equal(el('btnNewNote').disabled,true);
// Swipes work on the heading and memo-card buttons; vertical scrolling and forms remain native.
function touch(type,x,y,target){const e={target,touches:[{clientX:x,clientY:y}],changedTouches:[{clientX:x,clientY:y}],cancelable:true,preventDefault(){this.prevented=true}};docEvents.listeners[type][0](e);return e;}
const heading={closest:()=>null,clientWidth:350,scrollWidth:350,parentElement:null};
touch('touchstart',260,120,heading);assert.equal(touch('touchmove',160,155,heading).prevented,true);touch('touchend',130,155,heading);assert.equal(el('notesPanel').hidden,false);
const memoCard={...heading};touch('touchstart',100,180,memoCard);touch('touchmove',170,190,memoCard);touch('touchend',190,190,memoCard);assert.equal(el('budgetPanel').hidden,false);
touch('touchstart',250,100,heading);touch('touchmove',240,170,heading);touch('touchend',150,230,heading);assert.equal(el('budgetPanel').hidden,false);
const form={...heading,closest:()=>({})};touch('touchstart',250,100,form);touch('touchend',100,100,form);assert.equal(el('budgetPanel').hidden,false);
const scroll={...heading,scrollWidth:700,overflowX:'auto'};touch('touchstart',250,100,scroll);touch('touchend',100,100,scroll);assert.equal(el('budgetPanel').hidden,false);
console.log('PASS: heading and memo-card swipes, diagonal tolerance, vertical scroll, form controls and horizontal tables');
console.log('PASS: multiple notes, separate updates, list, revision conflicts, deletion, legacy note, stale-delete protection, disconnect cleanup');
})();
