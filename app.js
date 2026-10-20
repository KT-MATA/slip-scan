"use strict";
const APP_VERSION = "1.0.1";
const $ = s => document.querySelector(s);
const { BRANDS, DEFAULT_CAR_LABELS } = window.SlipParser;
const BRAND_COLOR = {VISA:"var(--c1)",Mastercard:"var(--c2)",JCB:"var(--c3)",AMEX:"var(--c4)",Diners:"var(--c5)","銀聯":"var(--c6)","その他":"var(--c7)"};
const TYPES = ["売上","取消","返品"];
const PAYS = ["一括","分割","リボ","ボーナス","その他"];
const WD = ["日","月","火","水","木","金","土"];
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parseD = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d||1); };
const addDays = (s,n) => { const d = parseD(s); d.setDate(d.getDate()+n); return ymd(d); };
const addMonths = (s,n) => { const d = parseD(s); return ymd(new Date(d.getFullYear(), d.getMonth()+n, 1)); };
const monthRange = s => { const d = parseD(s); const y = d.getFullYear(), m = d.getMonth()+1; return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(y,m,0).getDate())}`]; };
const jpDate = s => { const d = parseD(s); return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日(${WD[d.getDay()]})`; };
const md = s => { const d = parseD(s); return `${d.getMonth()+1}/${d.getDate()}(${WD[d.getDay()]})`; };
const yen = n => (n<0?"−":"")+"¥"+Math.abs(Math.round(n)).toLocaleString("ja-JP");
const sign = s => s.type === "売上" ? 1 : -1;
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const newId = () => "s-"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);

/* ---------- IndexedDB ---------- */
const DB = (() => {
  let dbp = null;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("taxi-slips", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("slips", {keyPath:"id"}).createIndex("biz", "biz");
      d.createObjectStore("kv", {keyPath:"k"});
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const os = async (name, mode = "readonly") => (await open()).transaction(name, mode).objectStore(name);
  return {
    async range(from, to){ return req((await os("slips")).index("biz").getAll(IDBKeyRange.bound(from, to))); },
    async all(){ return req((await os("slips")).getAll()); },
    async put(s){ return req((await os("slips","readwrite")).put(s)); },
    async putMany(list){
      const st = await os("slips","readwrite");
      await Promise.all(list.map(s => req(st.put(s))));
    },
    async del(id){ return req((await os("slips","readwrite")).delete(id)); },
    async get(k, def){ const r = await req((await os("kv")).get(k)); return r ? r.v : def; },
    async set(k, v){ return req((await os("kv","readwrite")).put({k, v})); },
    async kvAll(){ return req((await os("kv")).getAll()); },
  };
})();

/* ---------- state ---------- */
const state = {
  date: ymd(new Date()), view: "day", month: [], monthKey: "", dayDoc: null,
  cars: [], carLabels: DEFAULT_CAR_LABELS.slice(), jobs: [], editing: null, filter: null, ready: false,
};
const carMap = () => Object.fromEntries(state.cars.filter(c => c.car).map(c => [String(c.car), c.driver]));
const driverOf = s => s.driver || carMap()[s.car] || "";

async function loadMonth(force){
  const [from, to] = monthRange(state.date);
  if(!force && state.monthKey === from) return;
  state.month = await DB.range(from, to);
  state.monthKey = from; state.ready = true;
}
async function reload(){ await loadMonth(true); render(); }

/* ---------- OCR ---------- */
let workerP = null, ocrProgress = () => {};
function setOcrState(text, cls){ const el = $("#ocrState"); el.className = "sync " + (cls||""); el.lastElementChild.textContent = text; }
function getWorker(){
  if(workerP) return workerP;
  const base = new URL("vendor", location.href).href;
  setOcrState("文字認識を準備中…");
  workerP = Tesseract.createWorker("jpn", 1, {
    workerPath: base + "/worker.min.js", corePath: base, langPath: base,
    workerBlobURL: false, gzip: true,
    logger: m => ocrProgress(m),
  }).then(async w => {
    await w.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" });
    setOcrState("文字認識 準備OK（オフライン）", "on");
    return w;
  }).catch(e => {
    workerP = null;
    setOcrState("文字認識を開始できませんでした", "bad");
    throw e;
  });
  return workerP;
}

async function loadImage(file){
  try { return await createImageBitmap(file, {imageOrientation:"from-image"}); }
  catch {
    const url = URL.createObjectURL(file);
    try { return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
    catch { throw new Error("この画像形式は開けませんでした。カメラの設定でJPEGにして撮り直してください。"); }
  }
}
function scaled(src, w, h, k){
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w*k)); c.height = Math.max(1, Math.round(h*k));
  const g = c.getContext("2d", {willReadFrequently:true});
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
// 感熱紙の薄い印字を読みやすくする：グレースケール化してコントラストを引き伸ばす
function enhance(c){
  const g = c.getContext("2d", {willReadFrequently:true});
  const img = g.getImageData(0, 0, c.width, c.height), p = img.data, n = p.length/4;
  const hist = new Uint32Array(256), gray = new Uint8ClampedArray(n);
  for(let i = 0; i < n; i++){ const v = (p[i*4]*0.299 + p[i*4+1]*0.587 + p[i*4+2]*0.114) | 0; gray[i] = v; hist[v]++; }
  let lo = 0, hi = 255, acc = 0;
  for(let v = 0; v < 256; v++){ acc += hist[v]; if(acc > n*0.01){ lo = v; break; } }
  acc = 0;
  for(let v = 255; v >= 0; v--){ acc += hist[v]; if(acc > n*0.05){ hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for(let i = 0; i < n; i++){
    const v = Math.min(255, Math.max(0, (gray[i] - lo) * 255 / span));
    p[i*4] = p[i*4+1] = p[i*4+2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}
async function prep(file){
  const src = await loadImage(file);
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  // 文字の高さがOCRに向く大きさになるよう、短い辺を1200px前後にそろえる
  const k = Math.min(2, Math.max(0.2, Math.min(1200 / Math.min(w, h), 2400 / Math.max(w, h))));
  const work = enhance(scaled(src, w, h, k));
  const thumb = scaled(src, w, h, Math.min(1, 520 / Math.max(w, h))).toDataURL("image/jpeg", 0.6);
  if(src.close) src.close();
  return {canvas: work, thumb};
}

/* ---------- scan queue (one at a time; OCR is CPU-heavy on a phone) ---------- */
let busy = false;
function enqueue(files){
  for(const f of files) state.jobs.push({id:newId(), file:f, biz:state.date, status:"queued", pct:0});
  renderJobs(); keepAwake(); pump();
}
async function pump(){
  if(busy) return;
  const j = state.jobs.find(x => x.status === "queued"); if(!j) return;
  busy = true; j.status = "reading"; j.pct = 0; renderJobs();
  try { await runJob(j); } finally { busy = false; pump(); }
}
async function runJob(j){
  try {
    if(!j.canvas){ const p = await prep(j.file); j.canvas = p.canvas; j.thumb = p.thumb; j.file = null; renderJobs(); }
    const w = await getWorker();
    ocrProgress = m => { if(m.status === "recognizing text"){ j.pct = Math.round(m.progress*100); updateJobBar(j); } };
    const { data } = await w.recognize(j.canvas);
    ocrProgress = () => {};
    const r = window.SlipParser.parse(data.text, {carLabels: state.carLabels});
    if(!r.amount && !r.car && !r.approval){
      j.status = "error"; j.raw = r.raw;
      j.msg = "伝票の文字を読み取れませんでした。明るい場所で、伝票をまっすぐ画面いっぱいに撮り直してください。";
      renderJobs(); return;
    }
    const s = {
      id:newId(), biz:j.biz, car:r.car, driver: carMap()[r.car] || "",
      amount:r.amount, type:r.type, pay:r.pay, brand:r.brand, date:r.date, time:r.time,
      approval:r.approval, slip:r.slip, terminal:r.terminal, last4:r.last4,
      confidence:r.confidence, missing:r.missing, raw:r.raw, thumb:j.thumb,
      note:"", checked:false, createdAt:Date.now(), source:"scan",
    };
    await DB.put(s);
    state.jobs = state.jobs.filter(x => x !== j);
    await reload();
    if(r.missing.includes("号車") || r.missing.includes("金額")){
      toast(`${r.missing.join("・")}が読めませんでした。入力してください`);
      openSheet(s, false);
    } else {
      toast(`号車${s.car}${s.driver ? "（"+s.driver+"）" : ""} ${yen(sign(s)*s.amount)}`);
    }
  } catch(e) {
    ocrProgress = () => {};
    j.status = "error"; j.msg = (e && e.message) || "読み取りに失敗しました。再試行してください。";
    renderJobs();
  }
}

let wakeLock = null;
async function keepAwake(){
  try { if(!wakeLock && navigator.wakeLock){ wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch {}
}
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible" && state.jobs.length) keepAwake(); });

/* ---------- derived ---------- */
const byTime = (a,b) => (a.time||"99:99").localeCompare(b.time||"99:99") || (a.createdAt||0)-(b.createdAt||0);
const daySlips = () => state.month.filter(s => s.biz === state.date).sort(byTime);
const viewSlips = () => state.view === "day" ? daySlips() : state.month;
function totals(rows){
  const t = {net:0, sales:0, salesN:0, voids:0, voidsN:0, checked:0, brand:{}};
  for(const s of rows){
    const a = Number(s.amount)||0, sg = sign(s);
    t.net += sg*a;
    if(sg > 0){ t.sales += a; t.salesN++; } else { t.voids += a; t.voidsN++; }
    if(s.checked) t.checked++;
    const b = s.brand || "その他"; t.brand[b] = (t.brand[b]||0) + sg*a;
  }
  return t;
}
const groupKey = s => driverOf(s) ? "d:"+driverOf(s) : "c:"+(s.car||"?");
function groups(rows){
  const g = {};
  for(const s of rows){ const k = groupKey(s); (g[k] ||= {key:k, driver:driverOf(s), cars:new Set(), rows:[]}).rows.push(s); if(s.car) g[k].cars.add(s.car); }
  return Object.values(g).map(x => ({...x, t:totals(x.rows)})).sort((a,b) => (!!b.driver - !!a.driver) || b.t.net - a.t.net);
}
function flags(rows){
  const keyCount = {};
  for(const s of rows){ if(s.approval){ const k = s.approval+"|"+s.amount+"|"+s.type; keyCount[k] = (keyCount[k]||0)+1; } }
  return s => {
    const f = [];
    if(s.type !== "売上") f.push(["bad", s.type]);
    if(s.approval && keyCount[s.approval+"|"+s.amount+"|"+s.type] > 1) f.push(["warn","重複?"]);
    if(!s.checked && (s.confidence === "low" || !s.amount || !s.car)) f.push(["warn","要確認"]);
    if(s.car && !driverOf(s)) f.push(["warn","ドライバー未登録"]);
    if(s.date && s.date !== s.biz) f.push(["info","伝票日 "+md(s.date)]);
    return f;
  };
}

/* ---------- render ---------- */
function render(){
  const v = state.view;
  document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === v));
  $("#reportView").hidden = v === "settings"; $("#settingsView").hidden = v !== "settings";
  $("#datebar").hidden = v === "settings";
  $("#dateInput").hidden = v !== "day"; $("#monthInput").hidden = v !== "month";
  $("#dateInput").value = state.date; $("#monthInput").value = state.date.slice(0,7);
  $("#today").textContent = v === "month" ? "今月" : "今日";
  $("#daySec").hidden = v !== "day"; $("#monthSec").hidden = v !== "month";
  $("#recon").hidden = v !== "day";
  if(v === "settings"){ renderSettings(); return; }
  renderSummary(); renderJobs(); renderDrivers();
  if(v === "day") renderList(); else renderMonth();
}

function renderSummary(){
  const rows = viewSlips(), t = totals(rows);
  const title = state.view === "day" ? jpDate(state.date) : (d => `${d.getFullYear()}年${d.getMonth()+1}月`)(parseD(state.date));
  const brands = BRANDS.filter(b => t.brand[b] !== undefined);
  const pos = brands.reduce((n,b) => n + Math.max(0, t.brand[b]), 0);
  const bar = pos > 0 ? brands.map(b => `<span style="width:${Math.max(0,t.brand[b])/pos*100}%;background:${BRAND_COLOR[b]}"></span>`).join("") : "";
  $("#summary").innerHTML = `
    <div class="r-head"><span>${esc(title)}</span><span>${state.ready ? rows.length+"枚" : "読み込み中…"}</span></div>
    <div class="r-total"><span class="lbl">${state.view === "day" ? "日計" : "月計"}（取消差引後）</span><span class="big">${yen(t.net)}</span></div>
    <div class="r-lines">
      <span class="k">売上</span><span class="c num">${t.salesN}件</span><span class="v num">${yen(t.sales)}</span>
      <span class="k">取消・返品</span><span class="c num">${t.voidsN}件</span><span class="v num ${t.voids?"neg":""}">${t.voids ? "−"+yen(t.voids) : yen(0)}</span>
      <span class="k">確認済み</span><span class="c num">${t.checked}/${rows.length}</span><span class="v">${rows.length && t.checked === rows.length ? '<span class="pill good">全件確認</span>' : ""}</span>
    </div>
    ${bar ? `<div class="bar" aria-hidden="true">${bar}</div>
    <div class="legend">${brands.map(b => `<div><b style="background:${BRAND_COLOR[b]}"></b><span class="nm">${esc(b)}</span><span class="num">${yen(t.brand[b])}</span></div>`).join("")}</div>` : ""}`;
  renderRecon();
}

function renderRecon(){
  if(state.view !== "day") return;
  const d = state.dayDoc || {}, ci = $("#r_count"), ai = $("#r_amount");
  if(document.activeElement !== ci) ci.value = d.termCount ?? "";
  if(document.activeElement !== ai) ai.value = d.termAmount ?? "";
  updateReconResult();
}
function updateReconResult(){
  const ci = $("#r_count"), ai = $("#r_amount"), t = totals(daySlips()), parts = [];
  if(ci.value !== ""){ const dn = t.salesN - Number(ci.value); parts.push(dn === 0 ? '<span class="pill good">件数 一致</span>' : `<span class="pill bad">件数 ${dn>0?"+":""}${dn}件</span>`); }
  if(ai.value !== ""){ const da = t.net - Number(ai.value); parts.push(da === 0 ? '<span class="pill good">金額 一致</span>' : `<span class="pill bad">金額 差 ${da>0?"+":""}${yen(da)}</span>`); }
  $("#reconRes").innerHTML = parts.length ? `<div class="row">${parts.join("")}</div>` : '<span class="note">端末の日計表の数字を入れると、スキャン分と一致するか確かめます。</span>';
}
let reconTimer = null;
function reconInput(){
  updateReconResult();
  clearTimeout(reconTimer);
  const date = state.date;
  reconTimer = setTimeout(() => {
    const c = $("#r_count").value, a = $("#r_amount").value;
    state.dayDoc = {termCount: c === "" ? null : Number(c), termAmount: a === "" ? null : Number(a)};
    DB.set("day-"+date, state.dayDoc);
  }, 500);
}
async function loadDay(){ state.dayDoc = await DB.get("day-"+state.date, null); renderRecon(); }

function renderDrivers(){
  const gs = groups(viewSlips());
  const el = $("#drivers");
  const unk = gs.filter(g => !g.driver).length;
  $("#drvHint").textContent = unk ? `未登録の号車 ${unk}件 → 設定で登録` : "";
  if(!gs.length){ el.innerHTML = `<div class="empty">${state.ready ? "伝票をスキャンすると、ドライバーごとの合計がここに出ます。" : "読み込み中…"}</div>`; return; }
  el.innerHTML = gs.map(g => `
    <button type="button" class="drv ${g.driver ? "" : "unk"}" data-key="${esc(g.key)}" aria-pressed="${state.filter === g.key}">
      <span class="nm">${esc(g.driver || "号車 "+[...g.cars].join("・"))}</span>
      <span class="car">${g.driver ? "号車 "+esc([...g.cars].join("・")) : "ドライバー未登録"}</span>
      <span class="amt ${g.t.net<0?"neg":""}">${yen(g.t.net)}</span>
      <span class="sub">${g.rows.length}枚${g.t.voidsN ? `・取消 ${g.t.voidsN}` : ""}</span>
    </button>`).join("");
}

function slipRow(s, fl){
  const f = fl(s), drv = driverOf(s);
  const sub = [drv, s.pay && s.pay !== "一括" ? s.pay : "", s.approval ? "承認 "+s.approval : "", s.last4 ? "末尾 "+s.last4 : ""].filter(Boolean).join(" · ");
  return `<div class="slip ${s.type !== "売上" ? "void" : ""}" data-id="${esc(s.id)}">
    <button type="button" class="chk" aria-pressed="${!!s.checked}" aria-label="確認済み"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
    <button type="button" class="body">
      <span class="l1"><span class="carno">${s.car ? esc(s.car)+"号車" : "号車?"}</span><span class="time">${esc(s.time || "--:--")}</span><span class="chip" style="background:${BRAND_COLOR[s.brand] || BRAND_COLOR["その他"]}">${esc(s.brand || "その他")}</span>${f.map(([k,t]) => `<span class="pill ${k}">${esc(t)}</span>`).join("")}</span>
      <span class="l2">${esc(sub || "　")}</span>
    </button>
    <span class="amt">${s.type !== "売上" ? "−" : ""}¥${(Number(s.amount)||0).toLocaleString("ja-JP")}</span>
  </div>`;
}
function renderList(){
  let rows = daySlips();
  const all = rows.length;
  if(state.filter) rows = rows.filter(s => groupKey(s) === state.filter);
  const fEl = $("#filter");
  fEl.hidden = !state.filter;
  if(state.filter){
    const g = groups(daySlips()).find(x => x.key === state.filter);
    fEl.innerHTML = `<span class="pill info">${esc(g ? (g.driver || "号車 "+[...g.cars].join("・")) : "")} だけ表示中</span><button type="button" class="btn small" id="clearFilter">すべて表示</button>`;
  }
  $("#listTitle").textContent = state.filter ? `伝票 ${rows.length}/${all}枚` : `伝票 ${all}枚`;
  $("#checkAll").disabled = !rows.some(s => !s.checked);
  $("#csvBtn").disabled = $("#shareBtn").disabled = !rows.length;
  const el = $("#list");
  if(!state.ready){ el.innerHTML = '<div class="empty">読み込み中…</div>'; return; }
  if(!rows.length){
    el.innerHTML = `<div class="empty"><strong>この日の伝票はまだありません</strong>下の「伝票をスキャン」で控えを撮ると、号車・金額・ブランド・承認番号を読み取ってここに並べます。伝票は1枚ずつ、画面いっぱいにまっすぐ撮ってください。</div>`;
    return;
  }
  const fl = flags(daySlips());
  el.innerHTML = rows.map(s => slipRow(s, fl)).join("");
}

function renderMonth(){
  const byDay = {};
  for(const s of state.month) (byDay[s.biz] ||= []).push(s);
  const days = Object.keys(byDay).sort();
  const tb = $("#monthTable");
  if(!days.length){ tb.innerHTML = `<tbody><tr><td class="empty" colspan="4">${state.ready ? "この月の伝票はまだありません" : "読み込み中…"}</td></tr></tbody>`; return; }
  tb.innerHTML = `<thead><tr><th>日付</th><th>枚数</th><th>確認</th><th>合計</th></tr></thead><tbody>` +
    days.map(d => { const t = totals(byDay[d]), n = byDay[d].length;
      return `<tr class="click" data-day="${d}" tabindex="0"><td>${md(d)}</td><td class="num">${n}</td><td>${t.checked === n ? '<span class="pill good">済</span>' : `<span class="pill mute">${t.checked}/${n}</span>`}</td><td class="num ${t.net<0?"neg":""}">${yen(t.net)}</td></tr>`; }).join("") + "</tbody>";
}

function renderJobs(){
  $("#jobs").innerHTML = state.jobs.map(j => `
    <div class="job" data-job="${j.id}">
      ${j.thumb ? `<img src="${j.thumb}" alt="">` : '<div class="ph"></div>'}
      <div class="txt">
        ${j.status === "error"
          ? `<strong>読み取れませんでした</strong>${esc(j.msg)}<div class="acts">${j.canvas || j.file ? '<button type="button" class="btn small" data-act="retry">再試行</button>' : ""}<button type="button" class="btn small" data-act="manual">手入力する</button><button type="button" class="btn small" data-act="drop">閉じる</button></div>`
          : `<strong>${j.status === "queued" ? "順番待ち" : "読み取り中…"}</strong>${esc(jpDate(j.biz))}の伝票として登録します<div class="prog"><span style="width:${j.pct}%"></span></div>`}
      </div>
      ${j.status !== "error" ? '<div class="spin" aria-hidden="true"></div>' : ""}
    </div>`).join("");
}
function updateJobBar(j){ const el = document.querySelector(`.job[data-job="${j.id}"] .prog span`); if(el) el.style.width = j.pct+"%"; }

/* ---------- settings ---------- */
function renderSettings(){
  renderCars();
  $("#carLabels").value = state.carLabels.join(",");
  $("#versionNote").textContent = `バージョン ${APP_VERSION}`;
  renderUnknownCars();
}
function renderCars(){
  if(!state.cars.length) state.cars.push({car:"", driver:""});
  $("#cars").innerHTML = `<div class="carrow note"><span>号車</span><span>ドライバー</span><span></span></div>` + state.cars.map((c,i) => `
    <div class="carrow" data-i="${i}">
      <input inputmode="numeric" placeholder="例 105" value="${esc(c.car)}" data-f="car" aria-label="号車">
      <input placeholder="例 山田" value="${esc(c.driver)}" data-f="driver" aria-label="ドライバー">
      <button type="button" class="x" data-del="${i}" aria-label="この行を削除">✕</button>
    </div>`).join("");
}
async function renderUnknownCars(){
  const map = carMap();
  const cars = [...new Set((await DB.all()).filter(s => s.car && !map[s.car] && !s.driver).map(s => s.car))].sort((a,b) => a-b);
  $("#unknownCars").innerHTML = cars.length ? `<div class="unknown">未登録の号車：${cars.map(c => `<button type="button" data-addcar="${esc(c)}">${esc(c)}</button>`).join("")}</div>` : "";
}
function readCars(){
  document.querySelectorAll("#cars .carrow[data-i]").forEach(r => {
    const c = state.cars[r.dataset.i];
    c.car = r.querySelector('[data-f="car"]').value.trim().replace(/[^\d]/g, "");
    c.driver = r.querySelector('[data-f="driver"]').value.trim();
  });
}
async function saveCars(){
  readCars();
  const seen = new Set();
  state.cars = state.cars.filter(c => c.car && c.driver && !seen.has(c.car) && seen.add(c.car));
  await DB.set("cars", state.cars);
  // ドライバー未設定の伝票に、登録した担当を反映する
  const map = carMap();
  const fix = (await DB.all()).filter(s => s.car && !s.driver && map[s.car]).map(s => ({...s, driver: map[s.car]}));
  if(fix.length) await DB.putMany(fix);
  updateDriverList();
  toast(fix.length ? `登録しました（伝票${fix.length}枚に反映）` : "登録しました");
  await loadMonth(true); renderSettings();
}
function updateDriverList(){ $("#driverList").innerHTML = [...new Set(state.cars.map(c => c.driver))].map(d => `<option value="${esc(d)}">`).join(""); }

/* ---------- edit sheet ---------- */
function fillSelect(id, opts){ $(id).innerHTML = opts.map(o => `<option>${esc(o)}</option>`).join(""); }
fillSelect("#f_brand", BRANDS); fillSelect("#f_type", TYPES); fillSelect("#f_pay", PAYS);
const FIELDS = ["car","driver","biz","date","time","brand","type","pay","amount","approval","slip","terminal","last4","note"];
function openSheet(s, isNew){
  state.editing = {orig:s, isNew};
  $("#sheetTitle").textContent = isNew ? "伝票を手入力" : "伝票を編集";
  for(const k of FIELDS) $("#f_"+k).value = s[k] ?? "";
  if(!s.driver && s.car) $("#f_driver").value = carMap()[s.car] || "";
  $("#f_checked").checked = !!s.checked;
  const img = $("#sheetImg"); img.hidden = !s.thumb; if(s.thumb) img.src = s.thumb; img.classList.remove("zoom");
  $("#rawBox").hidden = !s.raw; $("#rawText").textContent = s.raw || ""; $("#rawBox").open = false;
  $("#delBtn").hidden = isNew; delArm(false);
  $("#sheet").hidden = false;
  const first = !s.car ? "#f_car" : !s.amount ? "#f_amount" : "#saveBtn";
  setTimeout(() => $(first).focus(), 30);
}
function closeSheet(){ $("#sheet").hidden = true; state.editing = null; }
let delArmed = false;
function delArm(on){ delArmed = on; $("#delBtn").textContent = on ? "もう一度押すと削除" : "削除"; }
$("#delBtn").onclick = async () => {
  if(!delArmed){ delArm(true); return; }
  const id = state.editing.orig.id; closeSheet();
  await DB.del(id); toast("削除しました"); reload();
};
$("#f_car").addEventListener("input", e => { const d = carMap()[e.target.value.trim()]; if(d) $("#f_driver").value = d; });
$("#cancelBtn").onclick = closeSheet;
$("#sheet").addEventListener("click", e => { if(e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
$("#sheetImg").onclick = e => e.target.classList.toggle("zoom");
$("#saveBtn").onclick = async () => {
  if(!$("#editForm").reportValidity()) return;
  const v = {};
  for(const k of FIELDS) v[k] = $("#f_"+k).value.trim();
  v.car = v.car.replace(/[^\d]/g, "");
  v.amount = Math.abs(parseInt(v.amount, 10)) || 0;
  v.last4 = v.last4.replace(/\D/g, "").slice(-4);
  const {orig, isNew} = state.editing;
  const s = {...orig, ...v, checked: $("#f_checked").checked, confidence: "high", missing: []};
  closeSheet();
  await DB.put(s);
  toast(s.biz !== state.date ? `${jpDate(s.biz)}に保存しました` : isNew ? "追加しました" : "保存しました");
  reload();
};
function manualNew(prefill){
  openSheet({id:newId(), biz:state.date, date:state.date, time:"", car:"", driver:"", brand:"VISA", type:"売上", pay:"一括", amount:"", checked:false, createdAt:Date.now(), source:"manual", ...(prefill||{})}, true);
}

/* ---------- CSV / backup ---------- */
function toCSV(rows){
  const head = ["集計日","号車","ドライバー","伝票日付","時刻","ブランド","区分","支払方法","金額","差引金額","承認番号","伝票番号","端末番号","カード末尾","確認済み","メモ"];
  const body = rows.map(s => [s.biz, s.car, driverOf(s), s.date, s.time, s.brand, s.type, s.pay, s.amount, sign(s)*(Number(s.amount)||0), s.approval, s.slip, s.terminal, s.last4, s.checked ? "済" : "", s.note]);
  // ドライバー別の集計も末尾に付ける
  const sum = [[], ["ドライバー別集計"], ["ドライバー","号車","枚数","売上","取消・返品","差引合計"]].concat(
    groups(rows).map(g => [g.driver || "(未登録)", [...g.cars].join("・"), g.rows.length, g.t.sales, g.t.voids, g.t.net]));
  return "﻿" + [head, ...body, ...sum].map(r => r.map(v => { v = String(v ?? ""); return /[",\r\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }).join(",")).join("\r\n");
}
function saveFile(name, data, type){
  const url = URL.createObjectURL(new Blob([data], {type}));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const canShareFiles = (() => { try { return !!navigator.canShare && navigator.canShare({files:[new File(["x"], "t.csv", {type:"text/csv"})]}); } catch { return false; } })();
async function shareFile(name, data){
  try { await navigator.share({files:[new File([data], name, {type:"text/csv"})], title:name}); }
  catch(e) { if(e && e.name !== "AbortError") toast("送れませんでした。CSV保存を使ってください"); }
}
const sortRows = rows => [...rows].sort((a,b) => a.biz.localeCompare(b.biz) || byTime(a,b));
const dayCSV = () => { const r = state.filter ? daySlips().filter(s => groupKey(s) === state.filter) : daySlips(); return [`クレジット伝票_${state.date}.csv`, toCSV(r)]; };
const monthCSV = () => [`クレジット伝票_${state.date.slice(0,7)}.csv`, toCSV(sortRows(state.month))];
$("#csvBtn").onclick = () => { const [n,d] = dayCSV(); saveFile(n, d, "text/csv"); };
$("#csvMonth").onclick = () => { const [n,d] = monthCSV(); saveFile(n, d, "text/csv"); };
$("#shareBtn").onclick = () => { const [n,d] = dayCSV(); shareFile(n, d); };
$("#shareMonth").onclick = () => { const [n,d] = monthCSV(); shareFile(n, d); };
$("#shareBtn").hidden = $("#shareMonth").hidden = !canShareFiles;

$("#exportJson").onclick = async () => {
  const data = {app:"taxi-slips", version:1, exportedAt:new Date().toISOString(), slips: await DB.all(), kv: await DB.kvAll()};
  saveFile(`伝票バックアップ_${ymd(new Date())}.json`, JSON.stringify(data), "application/json");
};
$("#importJson").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if(!f) return;
  try {
    const data = JSON.parse(await f.text());
    if(data.app !== "taxi-slips" || !Array.isArray(data.slips)) throw new Error();
    await DB.putMany(data.slips);
    for(const kv of data.kv || []) await DB.set(kv.k, kv.v);
    await loadSettings(); await reload();
    toast(`${data.slips.length}枚の伝票を戻しました`);
  } catch { toast("バックアップファイルを読めませんでした"); }
});

/* ---------- events ---------- */
$("#camInput").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; if(f.length) enqueue(f); });
$("#libInput").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; if(f.length) enqueue(f); });
$("#manualBtn").onclick = () => manualNew();
$("#list").addEventListener("click", async e => {
  const row = e.target.closest(".slip"); if(!row) return;
  const s = state.month.find(x => x.id === row.dataset.id); if(!s) return;
  if(e.target.closest(".chk")){ await DB.put({...s, checked: !s.checked}); reload(); }
  else if(e.target.closest(".body")) openSheet(s, false);
});
$("#drivers").addEventListener("click", e => {
  const b = e.target.closest(".drv"); if(!b) return;
  if(state.view === "month"){ state.view = "day"; }
  state.filter = state.filter === b.dataset.key ? null : b.dataset.key;
  render();
});
$("#filter").addEventListener("click", e => { if(e.target.id === "clearFilter"){ state.filter = null; render(); } });
$("#jobs").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if(!b) return;
  const j = state.jobs.find(x => x.id === b.closest(".job").dataset.job); if(!j) return;
  if(b.dataset.act === "retry"){ j.status = "queued"; renderJobs(); pump(); }
  else {
    state.jobs = state.jobs.filter(x => x !== j); renderJobs();
    if(b.dataset.act === "manual") manualNew({biz:j.biz, date:j.biz, thumb:j.thumb, raw:j.raw});
  }
});
$("#checkAll").onclick = async () => {
  let rows = daySlips(); if(state.filter) rows = rows.filter(s => groupKey(s) === state.filter);
  await DB.putMany(rows.filter(s => !s.checked).map(s => ({...s, checked:true}))); reload();
};
$("#monthTable").addEventListener("click", e => { const tr = e.target.closest("tr[data-day]"); if(tr) go(tr.dataset.day, "day"); });
$("#monthTable").addEventListener("keydown", e => { if(e.key === "Enter"){ const tr = e.target.closest("tr[data-day]"); if(tr) tr.click(); } });
document.querySelectorAll(".seg button").forEach(b => b.onclick = () => { state.view = b.dataset.view; if(state.view !== "day") state.filter = null; render(); });
async function go(s, view){
  state.date = s; if(view) state.view = view; state.filter = null;
  await loadMonth(); render(); loadDay();
}
$("#prev").onclick = () => go(state.view === "day" ? addDays(state.date, -1) : addMonths(state.date, -1));
$("#next").onclick = () => go(state.view === "day" ? addDays(state.date, 1) : addMonths(state.date, 1));
$("#today").onclick = () => go(ymd(new Date()));
$("#dateInput").addEventListener("change", e => { if(e.target.value) go(e.target.value); });
$("#monthInput").addEventListener("change", e => { if(e.target.value) go(e.target.value + "-01"); });
$("#r_count").addEventListener("input", reconInput);
$("#r_amount").addEventListener("input", reconInput);

$("#addCar").onclick = () => { readCars(); state.cars.push({car:"", driver:""}); renderCars(); document.querySelector("#cars .carrow:last-child input").focus(); };
$("#cars").addEventListener("click", e => { const d = e.target.closest("[data-del]"); if(d){ readCars(); state.cars.splice(Number(d.dataset.del), 1); renderCars(); } });
$("#unknownCars").addEventListener("click", e => {
  const b = e.target.closest("[data-addcar]"); if(!b) return;
  readCars();
  const empty = state.cars.find(c => !c.car && !c.driver);
  if(empty) empty.car = b.dataset.addcar; else state.cars.push({car:b.dataset.addcar, driver:""});
  renderCars();
  const idx = state.cars.findIndex(c => c.car === b.dataset.addcar);
  document.querySelector(`#cars .carrow[data-i="${idx}"] [data-f="driver"]`).focus();
});
$("#saveCars").onclick = saveCars;
$("#saveLabels").onclick = async () => {
  const v = $("#carLabels").value.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
  state.carLabels = v.length ? v : DEFAULT_CAR_LABELS.slice();
  await DB.set("carLabels", state.carLabels); toast("保存しました");
};

let toastTimer = null;
function toast(t){ const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 2800); }

async function loadSettings(){
  state.cars = await DB.get("cars", []);
  state.carLabels = await DB.get("carLabels", DEFAULT_CAR_LABELS.slice());
  updateDriverList();
}

async function boot(){
  render();
  await loadSettings();
  await loadMonth(true);
  render(); loadDay();
  if("serviceWorker" in navigator && location.protocol !== "file:"){
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // 新しい版が入ったら、スキャン中でなければ読み込み直して切り替える
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if(!hadController) return;
      if(!state.jobs.length && $("#sheet").hidden) location.reload();
      else toast("新しい版があります。次に開いたときに切り替わります");
    });
  }
  if(navigator.storage && navigator.storage.persist){
    const ok = await navigator.storage.persist().catch(() => false);
    $("#storageNote").textContent = ok ? "このスマホの保存領域は自動で消されない設定になっています。" : "ブラウザの設定によっては、空き容量が少ないとデータが消されることがあります。バックアップを取ってください。";
  }
  // 起動直後に文字認識を温めておく（初回スキャンを速くする）
  setTimeout(() => getWorker().catch(() => {}), 800);
}
boot();
