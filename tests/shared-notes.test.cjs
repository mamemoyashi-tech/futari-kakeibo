const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
let source=fs.readFileSync(require('node:path').join(__dirname,'..','app.js'),'utf8').replace(/import[\s\S]*?from "https:[^"]+";/g,'');source=source.slice(0,source.lastIndexOf('\nwireUI();'));
const nodes=new Map();function node(){return {value:'',textContent:'',hidden:false,disabled:false,children:[],listeners:{},clientWidth:390,scrollWidth:390,append(...v){this.children.push(...v)},appendChild(v){this.children.push(v)},replaceChildren(){this.children=[]},addEventListener(k,f){(this.listeners[k]??=[]).push(f)},setAttribute(){},focus(){}}}function el(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)}
const storage=new Map();const docEvents=node();const c=vm.createContext({console,URL,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))},getComputedStyle:n=>({overflowX:n.overflowX||'visible'}),document:{getElementById:el,createElement:node,body:node(),addEventListener:docEvents.addEventListener.bind(docEvents)},window:{innerWidth:390,addEventListener(){}},requestAnimationFrame:f=>f(),confirm:()=>true});vm.runInContext(source,c);
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
// The third tab participates in both swipe and keyboard navigation.
el('tabNotes').listeners.click[0]();touch('touchstart',260,120,heading);touch('touchmove',160,140,heading);touch('touchend',130,140,heading);assert.equal(el('settingsPanel').hidden,false);
touch('touchstart',260,120,heading);touch('touchend',130,120,heading);assert.equal(el('settingsPanel').hidden,false);
touch('touchstart',100,120,heading);touch('touchend',230,120,heading);assert.equal(el('notesPanel').hidden,false);
el('tabNotes').listeners.keydown[0]({key:'End',preventDefault(){}});assert.equal(el('settingsPanel').hidden,false);
el('tabSettings').listeners.keydown[0]({key:'Home',preventDefault(){}});assert.equal(el('budgetPanel').hidden,false);
// Saved credentials migrate to automatic connection; the restored Firebase UID is reused.
run(`app={};auth={currentUser:{uid:'restored-uid'}};let signIns=0,subscriptions=0;
updateProfile=async()=>{};setDoc=async()=>{};signInAnonymously=async()=>{signIns++;auth.currentUser={uid:'new-uid'}};
startRealtime=()=>{subscriptions++;return ()=>{}};updateCategoryChart=()=>{};noteDirty=false;
localStorage.setItem('hh_householdId','saved-household');localStorage.setItem('hh_displayName','保存済みの名前');`);
el('householdId').value='unsaved-edit';el('displayName').value='別の入力';
const restoring=run('restoreSavedConnection()');assert.equal(run('subscriptions'),0);run('resolveAuthReady()');await restoring;
assert.equal(run('isConnected'),true);assert.equal(run('uid'),'restored-uid');assert.equal(run('signIns'),0);assert.equal(el('householdId').value,'saved-household');assert.equal(storage.get('hh_autoConnect'),'1');
await run('disconnect()');assert.equal(storage.get('hh_autoConnect'),'0');assert.equal(run('auth.currentUser.uid'),'restored-uid');assert.equal(run('isConnected'),false);
const count=run('subscriptions');await run('restoreSavedConnection()');assert.equal(run('subscriptions'),count);
await run('connect()');assert.equal(run('isConnected'),true);assert.equal(storage.get('hh_autoConnect'),'1');assert.equal(run('signIns'),0);
// Cancelling an in-flight connection must not restart subscriptions later.
run(`let releaseRegistration,enteredRegistration;
const registrationStarted=new Promise(r=>enteredRegistration=r);
setDoc=()=>{enteredRegistration();return new Promise(r=>releaseRegistration=r)};`);
const connecting=run('connect()');await run('registrationStarted');await run('disconnect()');const beforeCancel=run('subscriptions');run('releaseRegistration()');await connecting;assert.equal(run('subscriptions'),beforeCancel);assert.equal(run('isConnected'),false);assert.equal(storage.get('hh_autoConnect'),'0');
console.log('PASS: three screens, auto-connect migration, restored identity, disconnect opt-out and in-flight cancellation');
// Pasted URLs are clickable without interpreting HTML or changing stored memo text.
const linkText='資料 https://drive.google.com/file/d/demo/view?usp=sharing&x=1#page=2。\n参考 https://example.com/a_(b) と (https://example.org/test)。';
el('sharedNote').value=linkText;run('updateNoteLinks()');
assert.equal(el('noteLinkList').children.length,3);assert.equal(el('noteLinks').hidden,false);
assert.equal(el('noteLinkList').children[0].href,'https://drive.google.com/file/d/demo/view?usp=sharing&x=1#page=2');
assert.equal(el('noteLinkList').children[1].href,'https://example.com/a_(b)');
assert.equal(el('noteLinkList').children[2].href,'https://example.org/test');
assert.equal(el('noteLinkList').children[0].target,'_blank');assert.equal(el('noteLinkList').children[0].rel,'noopener noreferrer');assert.equal(el('sharedNote').value,linkText);
el('sharedNote').value='javascript:alert(1) data:text/html,test <img src=x onerror=alert(1)>';run('updateNoteLinks()');assert.equal(el('noteLinks').hidden,true);assert.equal(el('noteLinkList').children.length,0);
el('sharedNote').value='https://example.com https://example.com/';run('updateNoteLinks()');assert.equal(el('noteLinkList').children.length,1);
run('applyNote({text:"https://docs.google.com/document/d/demo/edit",revision:1})');assert.equal(el('noteLinkList').children.length,1);
console.log('PASS: Drive/Docs links, queries, fragments, punctuation, parentheses, deduplication and unsafe-protocol rejection');
console.log('PASS: multiple notes, separate updates, list, revision conflicts, deletion, legacy note, stale-delete protection, disconnect cleanup');
})();

