// ふたり家計簿（割り勘精算）
// - Firebase (v10 modular) + Firestore
// - 匿名ログインで、世帯コード householdId ごとに expenses を共有
// - 月次集計：当月合計を2等分し、差額の半分を精算額として表示

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  initializeFirestore, getFirestore, collection, doc, setDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, Timestamp, enableIndexedDbPersistence, serverTimestamp
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

// Realtime購読は「接続」操作の完了後に開始する。
// （Firestore ルールで members 登録を必須にしている場合、
//  ログイン直後に購読を開始すると Missing permissions になり得るため）
let isConnected = false;

let pieChart = null;

// Moneytree風カラー（緑中心 + 水色アクセント）
const PIE_COLORS = [
  "#2F7D4C", "#47BCD0", "#1F5A37", "#6AD1C4", "#4B6A54", "#9FE3EA",
  "#7CCBA2", "#2A9D8F", "#A7E0C2", "#5FBF7A"
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
    ctx.fillStyle = "#4b6a54";
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
    ctx.fillStyle = colors[i] || "#2F7D4C";
    ctx.fill();
    // 白い境界線
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    angle += a;
  }

  // 中央に合計
  ctx.fillStyle = "#0f1a12";
  ctx.font = "800 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("合計", cx, cy - 10);
  ctx.fillStyle = "#1f5a37";
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
  pill.textContent = text;
  pill.className = "pill " + (ok ? "ok" : "danger");
}

function setAddMsg(msg, isError=false){
  const a = el("addMsg");
  a.textContent = msg;
  a.className = "muted small " + (isError ? "danger" : "");
}

function setListMsg(msg, isError=false){
  const a = el("listMsg");
  a.textContent = msg;
  a.className = "muted small " + (isError ? "danger" : "");
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



async function connect(){
  try{
    ensureFirebaseInitialized();
  }catch(e){
    setAddMsg(e.message, true);
    setStatus("未接続", false);
    return;
  }

  householdId = normalizeHouseholdId(el("householdId").value);
  displayName = (el("displayName").value || "").trim();

  if(!householdId || householdId.length < 4){
    setAddMsg("世帯コードを4文字以上で入力してください。", true);
    return;
  }
  if(!displayName){
    setAddMsg("表示名を入力してください。", true);
    return;
  }

  // UI の入力欄も正規化後で揃える（2人で微妙に違う入力を防ぐ）
  el("householdId").value = householdId;
  saveLocal();

  setAddMsg("");
  setStatus("接続中…", true);

  // いったん既存購読を止める（別世帯への接続切替など）
  if(stopRealtime){
    stopRealtime();
    stopRealtime = null;
  }
  isConnected = false;

  try{
    await signInAnonymously(auth);
  }catch(e){
    setStatus("未接続", false);
    setAddMsg("ログインに失敗しました: " + e.message, true);
    return;
  }

  // profile（匿名でもdisplayNameは持てます）
  try{
    await updateProfile(auth.currentUser, { displayName });
  }catch(e){
    // 無視しても動く
  }

  // members に表示名を保存（任意）
  try{
    const myUid = auth.currentUser?.uid;
    if(myUid){
      await setDoc(
        doc(db, "households", householdId, "members", myUid),
        { displayName, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }
  }catch(e){
    // 無視しても動く（権限設定等で失敗しても、expenses 自体は共有できる）
  }

  // ここまで来たら「接続完了」として購読開始
  isConnected = true;
  uid = auth.currentUser?.uid || uid;
  el("whoami").textContent = displayName;
  stopRealtime = startRealtime();

  setStatus("接続", true);
  setListMsg("同期中（リアルタイム）…");
}

async function disconnect(){
  if(!auth) return;
  if(stopRealtime){
    stopRealtime();
    stopRealtime = null;
  }
  isConnected = false;
  await signOut(auth);
  uid = null;
  setStatus("未接続", false);
  el("whoami").textContent = "未ログイン";
  setListMsg("切断しました。");
  el("tbody").innerHTML = "";
  el("myTotal").textContent = "-";
  el("otherTotal").textContent = "-";
  el("settlement").textContent = "-";
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
  if(!db || !uid || !householdId){
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

  return () => { unsubExpenses(); unsubMembers(); };
}


let stopRealtime = null;

function wireUI(){
  el("btnConnect").addEventListener("click", connect);
  el("btnDisconnect").addEventListener("click", disconnect);
  el("btnAdd").addEventListener("click", addExpense);
  el("btnClear").addEventListener("click", () => { el("amount").value=""; el("memo").value=""; setAddMsg(""); });
  el("date").value = defaultDate();
  initMonthSelectDefault();
  loadLocal();
}

wireUI();

onAuthStateChanged(getAuthSafe(), async (user) => {
  if(!user){
    setStatus("未接続", false);
    isConnected = false;
    return;
  }
  uid = user.uid;
  displayName = (el("displayName").value || user.displayName || "あなた").trim();
  el("whoami").textContent = displayName;

  // Realtime購読は connect() 側で開始する
  if(isConnected){
    setStatus("接続済み", true);
  }
});

function getAuthSafe(){
  ensureFirebaseInitialized();
  return auth;
}
