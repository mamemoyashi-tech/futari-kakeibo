// ふたり家計簿（割り勘精算）
// - Firebase (v10 modular) + Firestore
// - 匿名ログインで、世帯コード householdId ごとに expenses を共有
// - 月次集計：当月合計を2等分し、差額の半分を精算額として表示

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  initializeFirestore, getFirestore, collection, doc, setDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, Timestamp, enableIndexedDbPersistence, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

// TODO: Firebase Console の Web SDK 設定を貼り付けてください
const firebaseConfig = {
  apiKey: "AIzaSyAxX6o56a5rzQvT33rQXIldIor9YpQzXno",
  authDomain: "futari-kakeibo-4c32c.firebaseapp.com",
  projectId: "futari-kakeibo-4c32c",
  storageBucket: "futari-kakeibo-4c32c.firebasestorage.app",
  messagingSenderId: "723945894846",
  appId: "1:723945894846:web:d8a17f0aae8bbf25323fef"
};


let app, db, auth;
let resolveAuthReady;
const authReady = new Promise(resolve => { resolveAuthReady = resolve; });
let initialAuthHandled = false;
let connecting = false, connectionEpoch = 0;
let uid = null;
let householdId = null;
let displayName = null;

// Realtime購読は「接続」操作の完了後に開始する。
// （Firestore ルールで members 登録を必須にしている場合、
//  ログイン直後に購読を開始すると Missing permissions になり得るため）
let isConnected = false;

let pieChart = null;

// 固定配色：淡いセージを中心に、アプリコットとバターイエローを限定使用
const PIE_COLORS = [
  "#D4E5D4", "#BFD6BF", "#F5D7BF", "#F3E9BB", "#EAF2E6",
  "#FBECE0", "#D4E5D4", "#BFD6BF", "#F5D7BF", "#F3E9BB"
];

function updateCategoryChart(rows){
  const canvas = el("categoryPie");
  const list = el("categoryList");
  const totalEl = el("chartTotal");
  if(!canvas || !list || !totalEl) return;

  // カテゴリ別合計
  const m = new Map();
  let total = 0;
  for(const r of rows){
    const cat = (r.category || "その他").toString();
    const amt = Number(r.amount || 0);
    total += amt;
    m.set(cat, (m.get(cat) || 0) + amt);
  }

  const entries = [...m.entries()].sort((a,b)=> b[1]-a[1]);
  const labels = entries.map(e=>e[0]);
  const values = entries.map(e=>e[1]);

  totalEl.textContent = `合計: ${fmtYen(total)}`;

  // 右側のリスト
  list.innerHTML = "";
  if(entries.length === 0){
    list.innerHTML = '<div class="muted small">データがありません</div>';
  }else{
    entries.forEach(([cat, amt], i) => {
      const row = document.createElement("div");
      row.className = "catRow";
      row.innerHTML = `
        <div class="catName"><span class="dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>${escapeHtml(cat)}</div>
        <div class="catAmt">${fmtYen(amt)}</div>
      `;
      list.appendChild(row);
    });
  }

  // 円グラフ
  const data = {
    labels,
    datasets: [{
      data: values,
      backgroundColor: labels.map((_, i)=> PIE_COLORS[i % PIE_COLORS.length]),
      borderColor: "#ffffff",
      borderWidth: 2,
    }]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed || 0;
            const pct = total > 0 ? Math.round((v/total)*100) : 0;
            return `${ctx.label}: ${fmtYen(v)} (${pct}%)`;
          }
        }
      }
    }
  };

  // Chart.js が読めない環境（PWA/オフライン/ネットワーク制限等）でも
  // 最低限の円グラフを表示できるようフォールバックする。
  if(typeof Chart === "undefined"){
    drawPieFallback(canvas, labels, values, data.datasets[0].backgroundColor, total);
    return;
  }

  if(!pieChart){
    pieChart = new Chart(canvas, { type: "pie", data, options });
  }else{
    pieChart.data = data;
    pieChart.update();
  }
}

function drawPieFallback(canvas, labels, values, colors, total){
  const ctx = canvas.getContext("2d");
  if(!ctx) return;

  // 高DPI対応
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if(canvas.width !== w) canvas.width = w;
  if(canvas.height !== h) canvas.height = h;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);

  const cw = rect.width;
  const ch = rect.height;
  ctx.clearRect(0,0,cw,ch);

  if(!total || total <= 0 || values.length === 0){
    ctx.fillStyle = "#657563";
    ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("データがありません", cw/2, ch/2);
    return;
  }

  const cx = cw/2;
  const cy = ch/2;
  const r = Math.min(cw, ch) * 0.42;

  let angle = -Math.PI/2;
  for(let i=0;i<values.length;i++){
    const v = values[i] || 0;
    const a = (v/total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + a);
    ctx.closePath();
    ctx.fillStyle = colors[i] || "#D4E5D4";
    ctx.fill();
    // 白い境界線
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    angle += a;
  }

  // 中央に合計
  ctx.fillStyle = "#3E5545";
  ctx.font = "800 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("合計", cx, cy - 10);
  ctx.fillStyle = "#3E5545";
  ctx.font = "800 16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText(fmtYen(total), cx, cy + 12);
}


const el = (id) => document.getElementById(id);
const fmtYen = (n) => `${Math.round(n).toLocaleString("ja-JP")}円`;
const pad2 = (n) => String(n).padStart(2, "0");

function yyyymmFromDate(d){
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${pad2(m)}`; // YYYY-MM
}

function parseDateInput(val){
  // val: "YYYY-MM-DD"
  if(!val) return null;
  const [y,m,d] = val.split("-").map(Number);
  return new Date(y, m-1, d);
}

function defaultDate(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function setStatus(text, ok=true){
  const pill = el("statusPill");
  pill.textContent = ok ? text : `! ${text}`;
  pill.className = "pill " + (ok ? "ok" : "danger");
}

function setAddMsg(msg, isError=false){
  const a = el("addMsg");
  a.textContent = isError && msg ? `! ${msg}` : msg;
  a.className = "muted small " + (isError ? "messageError" : "");
}

function setListMsg(msg, isError=false){
  const a = el("listMsg");
  a.textContent = isError && msg ? `! ${msg}` : msg;
  a.className = "muted small " + (isError ? "messageError" : "");
}

function ensureFirebaseInitialized(){
  if(app) return;
  app = initializeApp(firebaseConfig);
  // iOS/Safari（PWAのスタンドアロン含む）で Firestore の接続が不安定になる場合があるため、
  // 長輪講（Long Polling）を強制して安定性を上げる。
  // 参考: Firestore の既知の互換性問題（WebChannel / Fetch Streams 等）。
  try{
    db = initializeFirestore(app, {
      experimentalForceLongPolling: true,
      useFetchStreams: false,
    });
  }catch{
    // initializeFirestore が二重初期化などで失敗した場合のフォールバック
    db = getFirestore(app);
  }
  auth = getAuth(app);

  // オフライン永続化（対応ブラウザのみ）。失敗しても動作は継続。
  // ※複数タブ同時利用などで precondition になることがあります。
  enableIndexedDbPersistence(db).catch(() => {});
}

function monthRange(yyyymm){
  return getMonthBounds(yyyymm);
}

function saveLocal(){
  localStorage.setItem("hh_householdId", householdId ?? "");
  localStorage.setItem("hh_displayName", displayName ?? "");
}

function loadLocal(){
  const hid = localStorage.getItem("hh_householdId") || "";
  const name = localStorage.getItem("hh_displayName") || "";
  el("householdId").value = hid;
  el("displayName").value = name;
}

function normalizeHouseholdId(raw){
  // 共有IDはちょっとした違い（空白/全角）で別世帯になりがちなので正規化
  return (raw || "")
    .trim()
    .replace(/[\s\u3000]+/g, "") // 半角/全角スペース除去
    .toLowerCase();
}



function setConnectionMessage(message, error = false){
  const status = el("settingsMsg");
  status.textContent = error ? `! ${message}` : message;
  status.className = error ? "messageError" : "muted";
}
function shouldAutoConnect(){
  return localStorage.getItem("hh_autoConnect") !== "0" &&
    normalizeHouseholdId(localStorage.getItem("hh_householdId")).length >= 4 &&
    !!(localStorage.getItem("hh_displayName") || "").trim();
}
async function restoreSavedConnection(){
  if(shouldAutoConnect()) await connect({automatic:true});
}
async function connect({automatic = false} = {}){
  if(connecting) return;
  const nextHousehold = normalizeHouseholdId(automatic ? localStorage.getItem("hh_householdId") : el("householdId").value);
  const nextName = (automatic ? localStorage.getItem("hh_displayName") || "" : el("displayName").value || "").trim();
  if(nextHousehold.length < 4){setConnectionMessage("世帯コードを4文字以上で入力してください。",true);return;}
  if(!nextName){setConnectionMessage("表示名を入力してください。",true);return;}
  if(noteDirty && !confirm("共有メモに未保存の変更があります。接続先を切り替えると変更を破棄しますか？")) return;
  const epoch = ++connectionEpoch;
  connecting = true;el("btnConnect").disabled = true;
  stopNotes();
  if(stopRealtime){stopRealtime();stopRealtime=null;}
  isConnected = false;
  householdId = nextHousehold;displayName = nextName;
  setStatus(automatic ? "自動接続中…" : "接続中…",true);
  setConnectionMessage(automatic ? "保存済みの設定で接続しています…" : "接続しています…");
  try{
    ensureFirebaseInitialized();
    // Wait for Firebase to restore the existing anonymous identity before signing in.
    await authReady;
    if(epoch !== connectionEpoch) return;
    if(!auth.currentUser) await signInAnonymously(auth);
    if(epoch !== connectionEpoch) return;
    const user = auth.currentUser;
    try{await updateProfile(user,{displayName:nextName});}catch{}
    if(epoch !== connectionEpoch) return;
    try{
      await setDoc(doc(db,"households",nextHousehold,"members",user.uid),
        {displayName:nextName,updatedAt:serverTimestamp()},{merge:true});
    }catch{}
    if(epoch !== connectionEpoch) return;
    uid = user.uid;
    isConnected = true;
    el("householdId").value = nextHousehold;
    el("displayName").value = nextName;
    saveLocal();localStorage.setItem("hh_autoConnect","1");
    el("whoami").textContent = nextName;
    stopRealtime = startRealtime();
    setStatus("接続済み",true);
    setConnectionMessage("接続済みです。この端末では次回から自動接続します。「切断」で自動接続も停止します。");
    setListMsg("同期中（リアルタイム）…");
  }catch(error){
    if(epoch !== connectionEpoch) return;
    isConnected = false;
    setStatus("未接続",false);
    setConnectionMessage("接続できませんでした。通信状況を確認して、もう一度接続してください。",true);
  }finally{
    if(epoch === connectionEpoch){connecting=false;el("btnConnect").disabled=false;}
  }
}
async function disconnect(){
  if(noteDirty && !confirm("共有メモの未保存の変更を破棄して切断しますか？")) return;
  connectionEpoch++;
  connecting=false;el("btnConnect").disabled=false;
  localStorage.setItem("hh_autoConnect","0");
  stopNotes();
  if(stopRealtime){stopRealtime();stopRealtime=null;}
  isConnected=false;uid=null;
  // Stop sharing, but retain this device's identity so its past expenses stay attributed correctly.
  setStatus("未接続",false);
  el("whoami").textContent="未接続";
  setConnectionMessage("切断しました。自動接続も停止しています。再開するには「共有をはじめる」を押してください。");
  setListMsg("切断しました。");
  el("tbody").innerHTML="";
  el("myTotal").textContent="-";el("otherTotal").textContent="-";el("settlement").textContent="-";
  updateCategoryChart([]);
}

function getExpensesCol(){
  return collection(db, "households", householdId, "expenses");
}

function getMonthBounds(yyyymm){
  const [y,m] = yyyymm.split("-").map(Number);
  const start = new Date(y, m-1, 1, 0,0,0,0);
  const end = new Date(y, m, 1, 0,0,0,0);
  return { start, end };
}

function updateMonthSelect(months){
  const sel = el("monthSelect");
  const current = sel.value;
  sel.innerHTML = "";
  months.forEach(mm => {
    const opt = document.createElement("option");
    opt.value = mm;
    opt.textContent = mm;
    sel.appendChild(opt);
  });
  if(current && months.includes(current)) sel.value = current;
}

function computeSettlement(my, other){
  // 2人均等：各自が目標 = (my + other)/2
  const total = my + other;
  const target = total / 2;
  const myDiff = my - target; // +なら払い過ぎ、-なら不足
  // 相手 → 自分へ支払う額（正なら相手が自分に払う／負なら自分が相手に払う）
  // ただし表示では「どちらがどちらにいくら」を出す
  if(Math.abs(myDiff) < 0.5){
    return { text: "精算不要（ぴったり同額）", dir: "none", amount: 0 };
  }
  const amount = Math.round(Math.abs(myDiff));
  if(myDiff > 0){
    // 自分が多く払っている -> 相手が自分に払う
    return { text: `相手 → あなた に ${fmtYen(amount)} 支払う`, dir: "other_to_me", amount };
  }else{
    return { text: `あなた → 相手 に ${fmtYen(amount)} 支払う`, dir: "me_to_other", amount };
  }
}

function renderTable(rows, membersByUid){
  const tbody = el("tbody");
  tbody.innerHTML = "";
  for(const r of rows){
    const tr = document.createElement("tr");

    const dt = r.date?.toDate ? r.date.toDate() : null;
    const dateStr = dt ? `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}` : "-";
    const payerName = (membersByUid.get(r.payerUid) || r.payerName || r.payerUid || "").toString();

    tr.innerHTML = `
      <td class="nowrap">${dateStr}</td>
      <td>${escapeHtml(r.category || "")}</td>
      <td>${escapeHtml(r.memo || "")}</td>
      <td class="nowrap">${escapeHtml(payerName)}</td>
      <td class="right nowrap">${fmtYen(r.amount || 0)}</td>
      <td class="right nowrap"></td>
    `;

    const tdAct = tr.querySelector("td:last-child");
    const btn = document.createElement("button");
    btn.textContent = "削除";
    btn.className = "danger";
    btn.addEventListener("click", async () => {
      if(!confirm("この明細を削除しますか？")) return;
      try{
        await deleteDoc(doc(db, "households", householdId, "expenses", r.id));
      }catch(e){
        alert("削除に失敗しました: " + e.message);
      }
    });
    // 自分の明細だけ削除可能に（UIだけ。ルールで縛るなら後述）
    btn.disabled = (r.payerUid !== uid);
    btn.title = btn.disabled ? "自分の入力分のみ削除できます" : "削除";
    tdAct.appendChild(btn);

    tbody.appendChild(tr);
  }
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initMonthSelectDefault(){
  const d = new Date();
  const thisMonth = yyyymmFromDate(d);
  updateMonthSelect([thisMonth]);
  el("monthSelect").value = thisMonth;
}

async function addExpense(){
  if(!isConnected || !db || !uid || !householdId){
    setAddMsg("先に「接続」を押してください。", true);
    return;
  }
  const dateVal = el("date").value || defaultDate();
  const d = parseDateInput(dateVal);
  const category = el("category").value;
  const amount = Number(el("amount").value);
  const memo = (el("memo").value || "").trim();

  if(!d){
    setAddMsg("日付を入力してください。", true);
    return;
  }
  if(!Number.isFinite(amount) || amount <= 0){
    setAddMsg("金額を正しく入力してください。", true);
    return;
  }

  const docData = {
    date: Timestamp.fromDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12,0,0,0)),
    yyyymm: yyyymmFromDate(d),
    category,
    amount: Math.round(amount),
    memo,
    payerUid: uid,
    payerName: displayName,
    createdAt: Timestamp.now()
  };

  try{
    await addDoc(getExpensesCol(), docData);
    setAddMsg("追加しました。");
    el("amount").value = "";
    el("memo").value = "";
  }catch(e){
    setAddMsg("追加に失敗しました: " + e.message, true);
  }
}


function startRealtime(){
  startNotes();
  // members 取得（表示名）
  const membersByUid = new Map();
  let allRows = [];

  const rerenderFromState = () => {
    const month = el("monthSelect").value;
    const { start, end } = monthRange(month);

    const filtered = allRows.filter(r => {
      const dt = r.date?.toDate ? r.date.toDate() : null;
      if(!dt) return false;
      return dt >= start && dt < end;
    });

    // 合計（2人前提）
    let my = 0, other = 0;
    for(const r of filtered){
      if(r.payerUid === uid) my += (r.amount||0);
      else other += (r.amount||0);
    }

    el("myTotal").textContent = fmtYen(my);
    el("otherTotal").textContent = fmtYen(other);
    el("settlement").textContent = computeSettlement(my, other).text;

    // 円グラフ（カテゴリ別）
    updateCategoryChart(filtered);

    // 明細
    renderTable(filtered, membersByUid);

    if(filtered.length === 0) setListMsg("この月の明細はまだありません。");
    else setListMsg(`${filtered.length} 件`);
  };


  const unsubMembers = onSnapshot(
    collection(db, "households", householdId, "members"),
    (snap) => {
      membersByUid.clear();
      snap.docs.forEach(d => membersByUid.set(d.id, d.data().displayName || d.id));
      rerenderFromState();
    },
    (err) => {
      // members がルールで許可されていない場合でも、明細自体は表示できるようにする
      // （表示名がUIDになるだけ）。
      if(String(err?.code || "").includes("permission-denied")){
        membersByUid.clear();
        // ここでは強いエラー表示を出さない
        rerenderFromState();
        return;
      }
      setListMsg("取得に失敗: " + err.message, true);
    }
  );

  // 初回は選択月に基づいて where してもよいが、簡便のため household の全明細を購読（小規模想定）
  // 大量になる場合は、monthSelect変更時に購読を切り替える実装にしてください。
  const qAll = query(getExpensesCol(), orderBy("date", "asc"));
  const unsubExpenses = onSnapshot(
    qAll,
    (snap) => {
      allRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // 利用月候補更新（データがある月 + 当月）
      const months = new Set([yyyymmFromDate(new Date())]);
      for(const r of allRows){
        const dt = r.date?.toDate ? r.date.toDate() : null;
        if(dt) months.add(yyyymmFromDate(dt));
      }
      const monthList = [...months].sort().reverse();
      updateMonthSelect(monthList);
      // 初期選択が空なら最新月
      if(!el("monthSelect").value) el("monthSelect").value = monthList[0] || yyyymmFromDate(new Date());

      rerenderFromState();
    },
    (err) => setListMsg("取得に失敗: " + err.message, true)
  );

  el("monthSelect").addEventListener("change", rerenderFromState);
  el("btnRefresh").addEventListener("click", rerenderFromState);

  return () => { unsubExpenses(); unsubMembers(); el("monthSelect").removeEventListener("change", rerenderFromState); el("btnRefresh").removeEventListener("click", rerenderFromState); };
}


let stopRealtime = null;

function wireUI(){
  wireNotes();
  el("btnConnect").addEventListener("click", connect);
  el("btnDisconnect").addEventListener("click", disconnect);
  el("btnAdd").addEventListener("click", addExpense);
  el("btnClear").addEventListener("click", () => { el("amount").value=""; el("memo").value=""; setAddMsg(""); });
  el("date").value = defaultDate();
  initMonthSelectDefault();
  loadLocal();
}

let unsubscribeNotes = null;
let noteDirty = false, noteReady = false, noteSaving = false;
let noteRevision = 0, latestNote = null, noteSession = 0;
let selectedNoteId = null, noteIsNew = false;
let notesById = new Map();
function noteMessage(message, kind = "info"){
  const status = el("noteStatus");
  status.textContent = kind === "info" ? message : `! ${message}`;
  status.className = kind === "error" ? "messageError" : kind === "warning" ? "messageWarning" : "muted";
}
function noteButtons(){
  const editable = noteReady && selectedNoteId !== null;
  el("btnNewNote").disabled = !noteReady || noteSaving;
  el("btnSaveNote").disabled = !editable || !noteDirty || noteSaving;
  el("btnDeleteNote").disabled = !editable || noteIsNew || noteSaving;
  el("btnBackNotes").disabled = noteSaving;
  el("noteTitle").disabled = !editable;
  el("sharedNote").disabled = !editable;
}
// URLs remain plain text in Firestore; only safe http(s) anchors are rendered in the UI.
function extractNoteLinks(text){
  const links = [], seen = new Set();
  for(const match of String(text || "").matchAll(/https?:\/\/[^\s<>"'`]+/giu)){
    let value = match[0].replace(/[。、，．！？；：「」『』【】〈〉《》）］｝.,;!]+$/gu, "");
    // Keep balanced parentheses inside a URL, but drop surrounding prose punctuation.
    for(const [open,close] of [["(",")"],["[","]"],["{","}"]]){
      while(value.endsWith(close) && value.split(close).length > value.split(open).length) value=value.slice(0,-1);
    }
    try{
      const url = new URL(value);
      if(!["http:","https:"].includes(url.protocol) || !url.hostname || seen.has(url.href)) continue;
      seen.add(url.href);links.push({text:value,href:url.href});
    }catch{}
  }
  return links;
}
function updateNoteLinks(){
  const links = extractNoteLinks(el("sharedNote").value);
  const list = el("noteLinkList");
  list.replaceChildren();
  el("noteLinks").hidden = links.length === 0;
  for(const link of links){
    const anchor = document.createElement("a");
    anchor.textContent=link.text;
    anchor.href=link.href;
    anchor.target="_blank";
    anchor.rel="noopener noreferrer";
    list.appendChild(anchor);
  }
}
function applyNote(data){
  el("noteTitle").value = data?.title || (data ? "共有メモ" : "");
  el("sharedNote").value = data?.text || "";
  updateNoteLinks();
  noteRevision = data?.revision || 0;
  noteDirty = false;
  el("btnReloadNote").hidden = true;
  el("noteMeta").textContent = data?.updatedByName ? `最終更新：${data.updatedByName}` : "";
  noteButtons();
}
function renderNotesList(){
  const list = el("notesList");
  list.replaceChildren();
  const notes = [...notesById.entries()].filter(([,data]) => !data.deleted);
  notes.sort((a,b) => (b[1].updatedAt?.toMillis?.() || 0) - (a[1].updatedAt?.toMillis?.() || 0) || a[0].localeCompare(b[0]));
  el("notesEmpty").hidden = !noteReady || notes.length > 0;
  for(const [id,data] of notes){
    const button = document.createElement("button");
    button.className = "noteItem";
    const title = document.createElement("strong");
    title.textContent = data.title || "共有メモ";
    const preview = document.createElement("span");
    preview.className = "muted";
    preview.textContent = (data.text || "本文なし").slice(0,100);
    button.append(title,preview);
    button.addEventListener("click", () => openNote(id));
    list.appendChild(button);
  }
}
function canLeaveNote(){
  return !noteSaving && (!noteDirty || confirm("未保存の変更を破棄して移動しますか？"));
}
function backToNotes(){
  if(!canLeaveNote()) return;
  selectedNoteId = null; noteIsNew = false; latestNote = null;
  applyNote(null);
  el("noteEditor").hidden = true;
  el("notesListView").hidden = false;
  noteMessage(noteReady ? "メモを選ぶか、新しいメモを作成してください。" : "「設定」画面から接続してください。");
}
function openNote(id = null){
  if(!noteReady || !canLeaveNote()) return;
  const data = id ? notesById.get(id) : null;
  if(id && (!data || data.deleted)) return;
  selectedNoteId = id || doc(collection(db,"households",householdId,"notes")).id;
  noteIsNew = !id;
  latestNote = data;
  applyNote(data);
  el("notesListView").hidden = true;
  el("noteEditor").hidden = false;
  noteMessage(id ? "編集後に「保存して共有」を押してください。" : "タイトルと本文を入力して保存してください。");
  el("noteTitle").focus();
}
function stopNotes(){
  noteSession++;
  if(unsubscribeNotes) unsubscribeNotes();
  unsubscribeNotes = null;
  noteDirty = noteReady = noteSaving = false;
  selectedNoteId = null; noteIsNew = false; latestNote = null;
  notesById = new Map();
  applyNote(null); renderNotesList();
  el("noteEditor").hidden = true;
  el("notesListView").hidden = false;
  noteMessage("「設定」画面で世帯コードを入力して接続してください。");
}
function reconcileSelectedNote(){
  if(!selectedNoteId || noteIsNew) return;
  latestNote = notesById.get(selectedNoteId) || null;
  if(noteSaving) return;
  if(!latestNote || latestNote.deleted){
    // Keep the local editor visible so the user can copy text after a remote deletion.
    noteMessage("相手がこのメモを削除しました。入力内容をコピーして、新しいメモとして保存してください。", "warning");
    el("btnReloadNote").hidden = false;
  }else if(noteDirty){
    if((latestNote.revision || 0) !== noteRevision){
      noteMessage("相手が更新しました。入力内容をコピーしてから最新メモを読み込んでください。", "warning");
      el("btnReloadNote").hidden = false;
    }
  }else{ applyNote(latestNote); }
}
function startNotes(){
  stopNotes();
  const session = noteSession;
  noteMessage("共有メモを読み込み中…");
  unsubscribeNotes = onSnapshot(collection(db,"households",householdId,"notes"), {includeMetadataChanges:true}, snap => {
    if(session !== noteSession) return;
    if(snap.metadata.fromCache && !noteReady){noteMessage("共有メモの最新情報を確認中…");return;}
    if(snap.metadata.hasPendingWrites) return;
    notesById = new Map(snap.docs.map(d => [d.id,d.data()]));
    noteReady = true;
    renderNotesList(); noteButtons(); reconcileSelectedNote();
    if(!selectedNoteId) noteMessage("メモを選ぶか、新しいメモを作成してください。");
  }, error => {
    if(session !== noteSession) return;
    noteReady = false; noteButtons();
    noteMessage(error.code === "permission-denied" ? "共有メモにアクセスできません。メモの共有設定を確認してください。" : "共有メモを取得できませんでした。再接続してください。", "error");
  });
}
async function saveNote(){
  if(!noteReady || !noteDirty || noteSaving || !isConnected || !selectedNoteId) return;
  const session = noteSession, id = selectedNoteId, isNew = noteIsNew;
  const ref = doc(db,"households",householdId,"notes",id);
  const text = el("sharedNote").value, rawTitle = el("noteTitle").value;
  if(!rawTitle.trim() && !text.trim()){noteMessage("タイトルか本文を入力してください。", "warning");return;}
  const title = rawTitle.trim() || "無題のメモ";
  const revision = noteRevision, name = displayName, authorUid = uid;
  noteSaving = true;noteButtons();noteMessage("保存中…");
  try{
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if(isNew ? snapshot.exists() : !snapshot.exists() || snapshot.data().deleted || (snapshot.data().revision || 0) !== revision) throw new Error("note-conflict");
      transaction.set(ref,{title,text,revision:revision+1,deleted:false,updatedBy:authorUid,updatedByName:name,updatedAt:serverTimestamp()});
    });
    if(session !== noteSession || selectedNoteId !== id) return;
    const known = notesById.get(id);
    if(!known || (known.revision || 0) <= revision){
      notesById.set(id,{title,text,revision:revision+1,deleted:false,updatedByName:name,updatedAt:Timestamp.now()});
      renderNotesList();
    }
    noteIsNew = false;noteRevision = revision+1;
    noteDirty = el("sharedNote").value !== text || el("noteTitle").value !== rawTitle;
    if(!noteDirty) el("noteTitle").value = title;
    el("btnReloadNote").hidden = true;
    el("noteMeta").textContent = `最終更新：${name}`;
    noteMessage(noteDirty ? "保存しました。続けて入力した変更は未保存です。" : "保存して共有しました。");
  }catch(error){
    if(session !== noteSession) return;
    noteMessage(error.message === "note-conflict" ? "相手の更新または削除があるため保存しませんでした。入力内容をコピーしてから最新メモを確認してください。" : "保存できませんでした。入力内容は残っています。接続や共有設定を確認してください。", error.message === "note-conflict" ? "warning" : "error");
    if(error.message === "note-conflict") el("btnReloadNote").hidden = false;
  }finally{
    if(session === noteSession){noteSaving=false;noteButtons();reconcileSelectedNote();}
  }
}
async function deleteNote(){
  if(!noteReady || !selectedNoteId || noteIsNew || noteSaving || !isConnected) return;
  if(!confirm("このメモをふたりの一覧から削除しますか？未保存の変更も破棄されます。")) return;
  const session = noteSession, id = selectedNoteId, revision = noteRevision;
  noteSaving=true;noteButtons();
  try{
    await runTransaction(db,async transaction => {
      const ref = doc(db,"households",householdId,"notes",id);
      const snapshot = await transaction.get(ref);
      if(!snapshot.exists() || snapshot.data().deleted || (snapshot.data().revision || 0) !== revision) throw new Error("note-conflict");
      // A tombstone prevents a stale editor from recreating a deleted note.
      transaction.set(ref,{title:"",text:"",deleted:true,revision:revision+1,updatedAt:serverTimestamp(),updatedBy:uid,updatedByName:displayName});
    });
    if(session !== noteSession) return;
    notesById.set(id,{deleted:true,revision:revision+1});renderNotesList();
    noteSaving=false;noteDirty=false;backToNotes();noteMessage("削除しました。");
  }catch(error){
    if(session !== noteSession) return;
    noteMessage(error.message === "note-conflict" ? "相手が変更したため削除しませんでした。最新メモを確認してください。" : "削除できませんでした。再度お試しください。", error.message === "note-conflict" ? "warning" : "error");
    if(error.message === "note-conflict") el("btnReloadNote").hidden=false;
  }finally{if(session === noteSession){noteSaving=false;noteButtons();}}
}
function wireNotes(){
  const tabs = [el("tabBudget"), el("tabNotes"), el("tabSettings")];
  const panels = [el("budgetPanel"), el("notesPanel"), el("settingsPanel")];
  let active = 0;
  function show(index, focus = false){
    active = index;
    tabs.forEach((tab,i) => {tab.setAttribute("aria-selected", String(i === index));tab.tabIndex = i === index ? 0 : -1;panels[i].hidden = i !== index;});
    if(focus) tabs[index].focus();
    if(index === 0 && pieChart) requestAnimationFrame(() => pieChart.resize());
  }
  tabs.forEach((tab,i) => {
    tab.addEventListener("click", () => show(i));
    tab.addEventListener("keydown", event => {
      if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){
        event.preventDefault(); show(event.key === "Home" ? 0 : event.key === "End" ? tabs.length-1 : (active + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length, true);
      }
    });
  });
  let gesture = null, suppressClickUntil = 0;
  // Listen across the page, including the heading, chart and memo cards.
  // Native form editing and horizontally scrolling containers keep their gestures.
  document.addEventListener("touchstart", event => {
    gesture = null;
    if(event.touches.length !== 1) return;
    const target = event.target;
    if(target.closest("input,textarea,select,a,[contenteditable]:not([contenteditable='false'])")) return;
    for(let n = target; n && n !== document.body; n = n.parentElement){
      if(n.scrollWidth > n.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return;
    }
    const touch = event.touches[0];
    // Leave the system's edge-back gesture available.
    if(touch.clientX < 16 || touch.clientX > window.innerWidth - 16) return;
    gesture = {x:touch.clientX,y:touch.clientY,horizontal:false};
  }, {passive:true});
  document.addEventListener("touchmove", event => {
    if(!gesture) return;
    if(event.touches.length !== 1){gesture=null;return;}
    const dx = event.touches[0].clientX-gesture.x;
    const dy = event.touches[0].clientY-gesture.y;
    if(!gesture.horizontal){
      if(Math.abs(dy)>12 && Math.abs(dy)>Math.abs(dx)){gesture=null;return;}
      if(Math.abs(dx)>12 && Math.abs(dx)>Math.abs(dy)*1.2) gesture.horizontal=true;
    }
    if(gesture.horizontal && event.cancelable) event.preventDefault();
  }, {passive:false});
  document.addEventListener("touchcancel", () => {gesture=null;}, {passive:true});
  document.addEventListener("touchend", event => {
    if(!gesture || !event.changedTouches.length) return;
    const g = gesture;gesture=null;
    const touch = event.changedTouches[0];
    const dx = touch.clientX-g.x, dy = touch.clientY-g.y;
    if(Math.abs(dx)>=48 && Math.abs(dx)>Math.abs(dy)*1.4){
      // A swipe across a memo card must not also open that card on release.
      suppressClickUntil=Date.now()+400;
      if(dx<0 && active<tabs.length-1) show(active+1);
      else if(dx>0 && active>0) show(active-1);
    }
  }, {passive:true});
  document.addEventListener("click", event => {
    if(event.detail>0 && Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}
  }, true);
  for(const id of ["sharedNote","noteTitle"]){
    el(id).addEventListener("input", () => {noteDirty=true;noteButtons();updateNoteLinks();noteMessage("未保存の変更があります。");});
  }
  el("btnNewNote").addEventListener("click", () => openNote());
  el("btnBackNotes").addEventListener("click", backToNotes);
  el("btnSaveNote").addEventListener("click", saveNote);
  el("btnDeleteNote").addEventListener("click", deleteNote);
  el("btnReloadNote").addEventListener("click", () => {
    if(!canLeaveNote()) return;
    const data = notesById.get(selectedNoteId);
    if(!data || data.deleted){noteDirty=false;backToNotes();return;}
    latestNote=data;applyNote(data);noteMessage("最新メモを読み込みました。");
  });
  window.addEventListener("beforeunload", event => {if(noteDirty){event.preventDefault();event.returnValue = "";}});
}
wireUI();

onAuthStateChanged(getAuthSafe(), async user => {
  if(!initialAuthHandled){
    initialAuthHandled=true;
    resolveAuthReady();
    await restoreSavedConnection();
    return;
  }
  if(!user && isConnected){
    await disconnect();
    setConnectionMessage("接続が切れました。設定画面から再接続してください。",true);
  }
});
window.addEventListener("online", () => {
  if(initialAuthHandled && !isConnected && !connecting) restoreSavedConnection();
});

function getAuthSafe(){
  ensureFirebaseInitialized();
  return auth;
}



