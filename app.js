import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, Timestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut, updateProfile
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
let uid = null;
let householdId = null;
let displayName = null;

let stopRealtime = null;
let viewMode = "unsettled"; // "unsettled" | "monthly"
let lastSettlementAt = null; // Timestamp|null

let pieChart = null;

const el = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");
const fmtYen = (n) => `${Math.round(n).toLocaleString("ja-JP")}円`;

function yyyymmFromDate(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
}
function parseDateInput(val){
  if(!val) return null;
  const [y,m,d] = val.split("-").map(Number);
  return new Date(y, m-1, d);
}
function defaultDate(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function setStatus(text, ok=true){
  el("statusText").textContent = text;
  el("statusDot").className = "dot " + (ok ? "ok" : "");
}
function setMsg(id, msg, isError=false){
  const a = el(id);
  a.textContent = msg;
  a.className = "muted small " + (isError ? "danger" : "");
}
const setAddMsg = (m,e=false)=>setMsg("addMsg", m, e);
const setListMsg = (m,e=false)=>setMsg("listMsg", m, e);
const setSettleMsg = (m,e=false)=>setMsg("settleMsg", m, e);
const setHistoryMsg = (m,e=false)=>setMsg("historyMsg", m, e);

function ensureFirebaseInitialized(){
  if(app) return;
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
}

function saveLocal(){
  localStorage.setItem("hh_householdId", householdId ?? "");
  localStorage.setItem("hh_displayName", displayName ?? "");
}
function loadLocal(){
  el("householdId").value = localStorage.getItem("hh_householdId") || "";
  el("displayName").value = localStorage.getItem("hh_displayName") || "";
}

function colExpenses(){ return collection(db, "households", householdId, "expenses"); }
function colMembers(){ return collection(db, "households", householdId, "members"); }
function docState(){ return doc(db, "households", householdId, "state"); }
function colSettlements(){ return collection(db, "households", householdId, "settlements"); }

function escapeHtml(str){
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function fmtDate(ts){
  if(!ts) return "初回";
  const d = ts.toDate();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function computeSettlement(my, other){
  const total = my + other;
  const target = total / 2;
  const myDiff = my - target; // +なら払い過ぎ
  if(Math.abs(myDiff) < 0.5) return { dir:"none", amount:0, text:"精算不要", arrow:"↔" };
  const amount = Math.round(Math.abs(myDiff));
  if(myDiff > 0) return { dir:"other_to_me", amount, text:"相手 → あなた", arrow:"←" };
  return { dir:"me_to_other", amount, text:"あなた → 相手", arrow:"→" };
}

function updateTotalsUI(my, other){
  el("myTotal").textContent = my==null ? "-" : fmtYen(my);
  el("otherTotal").textContent = other==null ? "-" : fmtYen(other);
}
function setSettlementUI(res){
  el("arrowText").textContent = res.arrow || "↔";
  el("settlementText").textContent = res.text || "-";
  el("settlementAmount").textContent = res.amount ? fmtYen(res.amount) : "-";
}
function updateMonthlyUI(total, my, other, count){
  el("monthTotal").textContent = total==null ? "-" : fmtYen(total);
  el("monthMy").textContent = my==null ? "-" : fmtYen(my);
  el("monthOther").textContent = other==null ? "-" : fmtYen(other);
  el("monthCount").textContent = count==null ? "-" : `${count}件`;
}

function initMonthSelect(){
  const now = new Date();
  const sel = el("monthSelect");
  sel.innerHTML = "";
  for(let i=0;i<18;i++){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const mm = yyyymmFromDate(d);
    const opt = document.createElement("option");
    opt.value = mm; opt.textContent = mm;
    sel.appendChild(opt);
  }
  sel.value = yyyymmFromDate(now);
}

async function connect(){
  ensureFirebaseInitialized();
  householdId = (el("householdId").value || "").trim();
  displayName = (el("displayName").value || "").trim();

  if(!householdId || householdId.length < 4){
    setAddMsg("世帯コードを4文字以上で入力してください。", true);
    return;
  }
  if(!displayName){
    setAddMsg("表示名を入力してください。", true);
    return;
  }
  saveLocal();
  setAddMsg("");
  setStatus("接続中…", true);

  await signInAnonymously(auth);
  try{ await updateProfile(auth.currentUser, { displayName }); } catch(_){}

  try{
    await setDoc(doc(db, "households", householdId, "members", auth.currentUser.uid), {
      displayName, updatedAt: Timestamp.now()
    }, { merge:true });
  }catch(_){}
}

async function disconnect(){
  if(!auth) return;
  await signOut(auth);
}

async function addExpense(){
  if(!db || !uid || !householdId){
    setAddMsg("先に「接続」を押してください。", true);
    return;
  }
  const d = parseDateInput(el("date").value || defaultDate());
  const amount = Number(el("amount").value);
  const category = el("category").value;
  const memo = (el("memo").value || "").trim();

  if(!d){ setAddMsg("日付を入力してください。", true); return; }
  if(!Number.isFinite(amount) || amount <= 0){ setAddMsg("金額を正しく入力してください。", true); return; }

  const docData = {
    date: Timestamp.fromDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12,0,0,0)),
    yyyymm: yyyymmFromDate(d),
    category,
    amount: Math.round(amount),
    memo,
    payerUid: uid,
    payerName: displayName,
    createdAt: Timestamp.now(),
    settled: false,
    settledAt: null
  };

  try{
    await addDoc(colExpenses(), docData);
    setAddMsg("追加しました。");
    el("amount").value = "";
    el("memo").value = "";
  }catch(e){
    setAddMsg("追加に失敗しました: " + e.message, true);
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

    const td = tr.querySelector("td:last-child");
    const btn = document.createElement("button");
    btn.textContent = "削除";
    btn.className = "ghost";
    btn.disabled = (r.payerUid !== uid);
    btn.title = btn.disabled ? "自分の入力分のみ削除できます" : "削除";
    btn.onclick = async () => {
      if(!confirm("この明細を削除しますか？")) return;
      try{
        await deleteDoc(doc(db, "households", householdId, "expenses", r.id));
      }catch(e){
        alert("削除に失敗しました: " + e.message);
      }
    };
    td.appendChild(btn);

    tbody.appendChild(tr);
  }
}

function updatePieChart(categoryTotals, monthLabel){
  const labels = Object.keys(categoryTotals);
  const values = labels.map(k => categoryTotals[k]);

  const sum = values.reduce((a,b)=>a+b,0);
  el("pieMsg").textContent = sum ? `${monthLabel} のカテゴリ別内訳` : "この月の明細がありません。";

  const ctx = el("pieChart");
  const data = { labels, datasets:[{ data: values }] };

  if(pieChart){
    pieChart.data = data;
    pieChart.update();
  }else{
    pieChart = new window.Chart(ctx, {
      type: "pie",
      data,
      options: { responsive:true, plugins:{ legend:{ position:"bottom" } } }
    });
  }
}

async function settleNow(unsettledRows, membersByUid){
  if(!unsettledRows || unsettledRows.length === 0){
    setSettleMsg("未精算の明細がありません。");
    return;
  }
  const fromText = fmtDate(lastSettlementAt);
  if(!confirm(`未精算分（${fromText} 〜 今日）を精算済みにして確定しますか？\n（以後この期間は未精算集計から除外されます）`)) return;

  try{
    let my=0, other=0;
    for(const r of unsettledRows){
      if(r.payerUid === uid) my += (r.amount||0);
      else other += (r.amount||0);
    }
    const res = computeSettlement(my, other);

    const meName = (membersByUid.get(uid) || displayName || "あなた");
    let otherUid = null;
    for(const r of unsettledRows){ if(r.payerUid && r.payerUid !== uid){ otherUid = r.payerUid; break; } }
    const otherName = otherUid ? (membersByUid.get(otherUid) || "相手") : "相手";

    let resultText = "精算不要";
    if(res.dir === "me_to_other") resultText = `${meName} → ${otherName}`;
    if(res.dir === "other_to_me") resultText = `${otherName} → ${meName}`;

    const now = Timestamp.now();

    // 履歴
    await addDoc(colSettlements(), {
      fromAt: lastSettlementAt || null,
      toAt: now,
      direction: res.dir,
      amount: res.amount,
      resultText,
      myTotal: my,
      otherTotal: other,
      createdAt: now,
      createdBy: uid
    });

    // 明細を精算済みに（バッチ分割）
    for(let i=0;i<unsettledRows.length;i+=450){
      const chunk = unsettledRows.slice(i, i+450);
      const batch = writeBatch(db);
      chunk.forEach(r => batch.update(doc(db, "households", householdId, "expenses", r.id), { settled:true, settledAt: now }));
      await batch.commit();
    }

    // state更新
    await setDoc(docState(), {
      lastSettlementAt: now,
      lastSettlementBy: uid,
      updatedAt: now
    }, { merge:true });

    setSettleMsg(`未精算 ${unsettledRows.length} 件を精算済みにして確定しました。`);
  }catch(e){
    setSettleMsg("精算確定に失敗しました: " + e.message, true);
  }
}

function renderHistory(rows){
  const body = el("historyBody");
  body.innerHTML = "";
  if(!rows || rows.length === 0){
    setHistoryMsg("まだ精算履歴がありません。");
    return;
  }
  setHistoryMsg(`${rows.length} 件`);
  for(const r of rows){
    const tr = document.createElement("tr");
    const created = r.createdAt?.toDate ? r.createdAt.toDate() : null;
    const createdStr = created ? `${created.getFullYear()}-${pad2(created.getMonth()+1)}-${pad2(created.getDate())}` : "-";
    const from = r.fromAt ? fmtDate(r.fromAt) : "初回";
    const to = r.toAt ? fmtDate(r.toAt) : "-";
    tr.innerHTML = `
      <td class="nowrap">${createdStr}</td>
      <td class="nowrap">${from}〜${to}</td>
      <td>${escapeHtml(r.resultText || "精算")}</td>
      <td class="right nowrap">${r.amount ? fmtYen(r.amount) : "-"}</td>
    `;
    body.appendChild(tr);
  }
}

function startRealtime(){
  const membersByUid = new Map();
  let latestUnsettled = [];

  const unsubMembers = onSnapshot(colMembers(), (snap)=>{
    membersByUid.clear();
    snap.docs.forEach(d => membersByUid.set(d.id, d.data().displayName || d.id));
  });

  const unsubState = onSnapshot(docState(), (snap)=>{
    const data = snap.exists() ? snap.data() : {};
    lastSettlementAt = data.lastSettlementAt || null;
    el("periodText").textContent = `${fmtDate(lastSettlementAt)} 〜 今日`;
  });

  const unsubExpenses = onSnapshot(query(colExpenses(), orderBy("date","asc")), (snap)=>{
    const rows = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    const selMonth = el("monthSelect").value;

    // view rows
    let viewRows;
    if(viewMode === "unsettled"){
      viewRows = rows.filter(r => r.settled === false);
      el("listModeText").textContent = "未精算期間の明細を表示";
    }else{
      viewRows = rows.filter(r => r.yyyymm === selMonth);
      el("listModeText").textContent = "月次（選択月）の明細を表示";
    }
    viewRows.sort((a,b)=>(a.date?.seconds||0)-(b.date?.seconds||0));
    renderTable(viewRows, membersByUid);
    setListMsg(viewRows.length ? `${viewRows.length} 件` : "明細がありません。");

    // unsettled totals (always)
    latestUnsettled = rows.filter(r => r.settled === false).sort((a,b)=>(a.date?.seconds||0)-(b.date?.seconds||0));
    let my=0, other=0;
    for(const r of latestUnsettled){
      if(r.payerUid === uid) my += (r.amount||0);
      else other += (r.amount||0);
    }
    updateTotalsUI(my, other);
    setSettlementUI(computeSettlement(my, other));

    // monthly summary + pie
    const monthRows = rows.filter(r => r.yyyymm === selMonth);
    let mt=0, mm=0, mo=0;
    const catTotals = {};
    for(const r of monthRows){
      mt += (r.amount||0);
      if(r.payerUid === uid) mm += (r.amount||0);
      else mo += (r.amount||0);
      const c = r.category || "その他";
      catTotals[c] = (catTotals[c]||0) + (r.amount||0);
    }
    updateMonthlyUI(mt, mm, mo, monthRows.length);
    // keep fixed labels
    ["食費","日用品","雑費","外食","交通","医療","娯楽","その他"].forEach(k=>{ if(!(k in catTotals)) catTotals[k]=0; });
    updatePieChart(catTotals, selMonth);

    // wire settle with latest list
    el("btnSettleNow").onclick = () => settleNow(latestUnsettled, membersByUid);
  }, (err)=> setListMsg("取得に失敗: " + err.message, true));

  const unsubHist = onSnapshot(query(colSettlements(), orderBy("createdAt","desc")), (snap)=>{
    const rows = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    renderHistory(rows.slice(0,30));
  }, (err)=> setHistoryMsg("履歴取得に失敗: " + err.message, true));

  return ()=>{ unsubMembers(); unsubState(); unsubExpenses(); unsubHist(); };
}

function wireUI(){
  el("btnConnect").onclick = connect;
  el("btnDisconnect").onclick = disconnect;
  el("btnAdd").onclick = addExpense;
  el("btnClear").onclick = ()=>{ el("amount").value=""; el("memo").value=""; setAddMsg(""); };

  el("btnToggleView").onclick = ()=>{
    viewMode = (viewMode === "unsettled") ? "monthly" : "unsettled";
    el("btnToggleView").textContent = (viewMode === "unsettled") ? "月次に切替" : "未精算に切替";
  };

  el("btnShowHistory").onclick = ()=>{
    el("historyCard").style.display = "block";
    el("historyCard").scrollIntoView({ behavior:"smooth", block:"start" });
  };
  el("btnHideHistory").onclick = ()=> el("historyCard").style.display = "none";

  el("date").value = defaultDate();
  initMonthSelect();
  loadLocal();

  el("monthSelect").addEventListener("change", ()=>{
    // snapshotの再描画で反映されるが、チャートが即更新されるように軽くトリガ
  });
}

wireUI();

function getAuthSafe(){ ensureFirebaseInitialized(); return auth; }

onAuthStateChanged(getAuthSafe(), (user)=>{
  if(!user){
    uid = null;
    setStatus("未接続", false);
    el("whoami").textContent = "未ログイン";
    setListMsg("");
    setSettleMsg("");
    updateTotalsUI(null, null);
    updateMonthlyUI(null, null, null, null);
    setSettlementUI({dir:"none", amount:0, text:"-", arrow:"↔"});
    el("periodText").textContent = "-";
    return;
  }
  uid = user.uid;
  displayName = (el("displayName").value || user.displayName || "あなた").trim();
  el("whoami").textContent = displayName;
  setStatus("接続済み", true);

  householdId = (el("householdId").value || "").trim();
  if(!householdId){
    setListMsg("世帯コードを入力してください。", true);
    return;
  }
  if(stopRealtime) stopRealtime();
  stopRealtime = startRealtime();
});
