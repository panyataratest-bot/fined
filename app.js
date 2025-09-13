/* ===== CONFIG ===== */
const API_URL = 'https://script.google.com/macros/s/AKfycbzvUzNTia5h_nbl_hV6-pTj6PzXsCYB5DCdyEOXOav2c01KEkh_OZJF1YE1L0Y1NUKa/exec'; // เปลี่ยนเป็นของคุณ
const BUD_CAT_OVERALL   = '__BUDGET_OVERALL__';
const BUD_CAT_SAVE_GOAL = '__SAVING_GOAL__';

/* ===== STATE ===== */
let token = localStorage.getItem('fin_token') || '';
let displayName = localStorage.getItem('fin_name') || '';
let lastItems = [];
let withdrawIncomeIds = new Set();
const monthSettingsCache = {}; // { 'YYYY-MM': {budget, goal} }

/* ===== HELPERS ===== */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const fmt = n => Number(n||0).toLocaleString('th-TH',{minimumFractionDigits:2, maximumFractionDigits:2});
const esc = (s='') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function toast(msg, ok=true){ const el=$('#toast'); el.textContent=msg; el.style.background=ok?'#22543d':'#c53030'; el.style.opacity='1'; setTimeout(()=>el.style.opacity='0',2300); }
function toYMD(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function todayISO(){ return toYMD(new Date()); }
function monthBoundsOf(d){ return { start: toYMD(new Date(d.getFullYear(), d.getMonth(), 1)), end: toYMD(new Date(d.getFullYear(), d.getMonth()+1, 0)) }; }
function monthKeyNow(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function monthKeyFromRange(){ const f=$('#fFrom').value; if(!f) return monthKeyNow(); return f.slice(0,7); }
const sum = (arr, pick) => arr.reduce((s,x)=> s+(pick(x)||0), 0);
const groupBy = (arr, key) => arr.reduce((a,x)=> ((a[key(x)] = a[key(x)]||[]).push(x),a),{});
const runningSum = (arr)=>{ let s=0; return arr.map(v=>(s+=v,s)); };
const safeKey = (x)=> `${(x.date||'').slice(0,10)}T${(x.time||'00:00:00').slice(0,8)}`;

/* ===== fetch with timeout & light retry ===== */
async function fetchJSON(url, options={}, timeoutMs=18000){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch(e){ return { ok:false, error:'NON_JSON', raw:text }; }
    return j;
  }catch(e){ return { ok:false, error:'NETWORK_ERROR', message:String(e&&e.message||e) }; }
  finally{ clearTimeout(id); }
}
async function api(path, payload={}, useToken=true){
  const body = { path, payload };
  if (useToken && token) body.token = token;
  const isListCall = /\/list$/.test(path) || path.endsWith('transactions/list');
  const doCall = ()=> fetchJSON(API_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(body) });
  let j = await doCall();
  if ((!j.ok && j.error==='NETWORK_ERROR') && isListCall){ j = await doCall(); }
  if (!j.ok && (j.error==='BAD_TOKEN' || j.status===401 || j.error==='UNAUTHORIZED')){
    localStorage.removeItem('fin_token'); token=''; ensureLoginUI(); toast('เซสชันหมดอายุ โปรดเข้าสู่ระบบใหม่', false);
  }
  if (!j.ok && j.error==='NON_JSON'){ toast('เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (ข้อมูลไม่ถูกต้อง)', false); }
  return j;
}

/* ===== Budgets ===== */
async function loadMonthSettingsFromAPI(mk){
  const r = await api('budgets/list', { month: mk }, true);
  let budget=0, goal=0;
  if (r.ok){
    for (const it of (r.items||[])) {
      const cid = String(it.category_id);
      if (cid === BUD_CAT_OVERALL)   budget = Number(it.limit_amount||0);
      if (cid === BUD_CAT_SAVE_GOAL) goal   = Number(it.limit_amount||0);
    }
  }
  monthSettingsCache[mk] = { budget, goal };
  $('#budgetThisMonth').value = budget ? String(budget) : '';
  $('#savingGoalThisMonth').value = goal ? String(goal) : '';
  return { budget, goal };
}
async function saveMonthSettingsToAPI(mk, budget, goal){
  const [r1, r2] = await Promise.all([
    api('budgets/upsert', { month: mk, category_id: BUD_CAT_OVERALL,   limit_amount: Number(budget||0) }, true),
    api('budgets/upsert', { month: mk, category_id: BUD_CAT_SAVE_GOAL, limit_amount: Number(goal||0)   }, true),
  ]);
  if (r1.ok && r2.ok){
    monthSettingsCache[mk] = { budget:Number(budget||0), goal:Number(goal||0) };
    $('#budgetThisMonth').value = budget ? String(budget) : '';
    $('#savingGoalThisMonth').value = goal ? String(goal) : '';
    return true;
  }
  return false;
}

/* ===== LOGIN / TABS ===== */
function switchTab(name){
  $$('.tabbtn').forEach(b=>{
    const on = (b.dataset.tab===name);
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on?'true':'false');
  });
  $$('.section').forEach(s=> s.classList.toggle('active', s.id === 'tab-'+name));
  if (name==='dash'){ ensureRangeDefaults(); refreshDash(); }
  if (name==='list'){ refreshDash(true); }
}
$$('.tabbtn').forEach(b=> b.addEventListener('click', ()=> switchTab(b.dataset.tab)));

function ensureLoginUI(){
  if (token){
    $('#loginBox').style.display='none';
    $('#app').classList.add('active');
    $('#who').textContent = displayName || localStorage.getItem('fin_user') || '';
    $('#txDate').value = todayISO();
    ensureRangeDefaults();
    loadCategoriesAll().then(async () => {
      populateCatSelect(); renderQAs();
      await loadMonthSettingsFromAPI(monthKeyFromRange());
      setTimeout(()=> $('#txAmount')?.focus(), 80);
    });
    refreshDash(true);
  } else {
    $('#loginBox').style.display='';
    $('#app').classList.remove('active');
  }
}
$('#btnLogin').addEventListener('click', doLogin);
$('#inpPin').addEventListener('keydown', (e)=>{ if (e.key==='Enter') doLogin(); });
async function doLogin(){
  const user_id = $('#inpUser').value.trim();
  const pin = $('#inpPin').value.trim();
  if (!user_id || !pin){ $('#loginMsg').textContent='กรอกให้ครบ'; toast('กรอกให้ครบ', false); return; }
  $('#btnLogin').disabled = true; $('#loginMsg').textContent = 'กำลังเข้าสู่ระบบ...';
  const j = await api('auth/login', { user_id, pin }, false);
  $('#btnLogin').disabled = false;
  if (!j.ok){ const msg=(j.error==='USER_NOT_FOUND')?'ไม่พบบัญชีผู้ใช้':(j.error==='BAD_PIN')?'รหัสผ่านผิด':(j.message||'เข้าสู่ระบบไม่สำเร็จ'); $('#loginMsg').textContent=msg; toast(msg,false); return; }
  token = j.token; displayName = j.display_name || user_id;
  localStorage.setItem('fin_token', token); localStorage.setItem('fin_user', user_id); localStorage.setItem('fin_name', displayName);
  $('#loginMsg').textContent = ''; toast('ยินดีต้อนรับ!');
  ensureLoginUI(); switchTab('add');
}
$('#btnLogout').addEventListener('click', ()=>{
  localStorage.removeItem('fin_token'); localStorage.removeItem('fin_name'); localStorage.removeItem('fin_user');
  token=''; displayName=''; $('#inpUser').value=''; $('#inpPin').value=''; $('#loginMsg').textContent=''; ensureLoginUI();
});

/* ===== CATEGORIES ===== */
let cats = { income:[], expense:[], saving:[] };
function _isWithdrawIncomeName(name){ const s = String(name||''); return /ถอน.*ออม|ออม.*ถอน|ถอนออม|ถอนเงินออม|withdraw.*(save|saving)|saving.*withdraw/i.test(s); }
async function loadCategoriesAll(){
  for (const t of ['income','expense','saving']){
    const r = await api('categories/list', { type:t });
    cats[t] = r.ok ? (r.items||[]) : [];
  }
  withdrawIncomeIds = new Set((cats.income||[]).filter(c=> _isWithdrawIncomeName(c.name_th)).map(c=> c.category_id));
}
function populateCatSelect(){
  const t = $('#txType').value; const sel = $('#txCat'); sel.innerHTML='';
  (cats[t]||[]).forEach(c=>{ const o=document.createElement('option'); o.value=c.category_id; o.textContent=c.name_th; sel.appendChild(o); });
}
$('#txType').addEventListener('change', populateCatSelect);

function openAddCatModal(){
  $('#addCatType').value = $('#txType').value || 'expense';
  $('#addCatName').value = '';
  $('#addCatBackdrop').classList.add('show');
  setTimeout(()=> $('#addCatName').focus(), 30);
}
function closeAddCatModal(){ $('#addCatBackdrop').classList.remove('show'); }
$('#btnAddCatInline').addEventListener('click', openAddCatModal);
$('#btnAddCatCancel').addEventListener('click', closeAddCatModal);
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') { closeAddCatModal(); closeEdit(); } });

async function createCategoryFromModal(){
  const type = $('#addCatType').value;
  const name = $('#addCatName').value.trim();
  if (!name){ toast('กรอกชื่อหมวดก่อน', false); $('#addCatName').focus(); return; }
  const r = await api('categories/create', { name_th:name, type }, true);
  if (!r.ok){ toast('เพิ่มหมวดไม่สำเร็จ', false); return; }
  const newCatId = String(r.category_id || '');
  const newCatObj = { category_id: newCatId, name_th: name, type, user_id: 'self', is_active: true };
  cats[type] = [newCatObj, ...(cats[type]||[])];
  setType(type); populateCatSelect(); if (newCatId) $('#txCat').value = newCatId;
  closeAddCatModal(); toast('เพิ่มหมวดสำเร็จ'); loadCategoriesAll().catch(()=>{});
}
$('#btnAddCatSave').addEventListener('click', createCategoryFromModal);

function setType(type){
  $('#txType').value = type;
  $('#btnTypeExp').classList.toggle('secondary', type!=='expense');
  $('#btnTypeInc').classList.toggle('secondary', type!=='income');
  $('#btnTypeSav').classList.toggle('secondary', type!=='saving');
  populateCatSelect();
}
$('#btnTypeExp').addEventListener('click', ()=> setType('expense'));
$('#btnTypeInc').addEventListener('click', ()=> setType('income'));
$('#btnTypeSav').addEventListener('click', ()=> setType('saving'));

/* ===== QUICK ADD ===== */
function getQAs(){ try{ return JSON.parse(localStorage.getItem('fin_quick_add')||'[]'); }catch{return [];} }
function setQAs(v){ localStorage.setItem('fin_quick_add', JSON.stringify(v)); }
function renderQAs(){
  const wrap = $('#quickWrap'); wrap.innerHTML='';
  const list = getQAs();
  if (!list.length){ wrap.innerHTML='<span class="inline-muted">ยังไม่มี Quick Add — เพิ่มด้านล่างได้เลย</span>'; return; }
  for (const q of list){
    const b = document.createElement('button');
    b.className='pill'; b.title='แตะเพื่อบันทึกทันที • คลิกกากบาทเพื่อลบ'; b.textContent = q.label + (q.category_name? ` • ${q.category_name}`:'');
    b.addEventListener('click', ()=> quickAddCommit(q));
    const x = document.createElement('span'); x.textContent=' ×'; x.style.opacity='.6'; x.style.fontWeight='700'; x.style.marginLeft='6px'; x.style.cursor='pointer';
    x.addEventListener('click', (e)=>{ e.stopPropagation(); setQAs(list.filter(x=>x.id!==q.id)); renderQAs(); toast('ลบรายการด่วนแล้ว'); });
    b.appendChild(x);
    wrap.appendChild(b);
  }
}
function _findCat(type, category_id){
  const list = (cats[type]||[]); return list.find(c => String(c.category_id) === String(category_id)) || null;
}
function populateQACatSelect(sel, type){
  sel.innerHTML = `<option value="">เลือกหมวด (อิงตามประเภท)</option>`;
  (cats[type]||[]).forEach(c=>{
    const o=document.createElement('option'); o.value=c.category_id; o.textContent=c.name_th; sel.appendChild(o);
  });
}
$('#btnAddQA').addEventListener('click', ()=>{
  const label = $('#qaLabel').value.trim();
  const type = $('#qaType').value;
  const amount = Number($('#qaAmount').value);
  if (!label || !isFinite(amount) || amount<=0){ toast('ใส่ชื่อและจำนวนเงิน Quick Add ให้ถูกต้อง', false); return; }

  const sel = document.createElement('select');
  sel.style.marginLeft='8px'; populateQACatSelect(sel, type);

  const tmp = document.createElement('div');
  tmp.className='inline-muted'; tmp.style.margin='8px 0';
  tmp.textContent='เลือกหมวดสำหรับ Quick Add แล้วกดตกลง: ';
  tmp.appendChild(sel);
  const okBtn = document.createElement('button'); okBtn.className='btn'; okBtn.style.marginLeft='8px'; okBtn.textContent='ตกลง';
  tmp.appendChild(okBtn);
  $('#quickWrap').prepend(tmp);

  okBtn.addEventListener('click', ()=>{
    const catId = (sel.value||'').trim();
    const obj = catId ? _findCat(type, catId) : null;
    const list = getQAs();
    list.unshift({
      id: Date.now(),
      label, type, amount: Math.round(amount*100)/100,
      category_id: catId || undefined,
      category_name: obj ? (obj.name_th||'') : undefined
    });
    setQAs(list.slice(0,12));
    renderQAs();
    tmp.remove();
    $('#qaLabel').value=''; $('#qaAmount').value='';
  });
});
async function quickAddCommit(q){
  let category_id = q && q.category_id ? q.category_id : '';
  const t = q?.type || 'expense';
  if (!category_id){
    const arr = (cats[t]||[]);
    if (!arr.length){ toast('ยังไม่มีหมวดสำหรับชนิดนี้', false); return; }
    category_id = arr[0].category_id;
  }
  const payload = { date: todayISO(), type: t, category_id, amount: q?.amount, note: q?.label };
  const r = await api('transactions/create', payload, true);
  if (r.ok){ toast('บันทึกด่วนสำเร็จ'); refreshDash(true); } else toast('บันทึกด่วนไม่สำเร็จ', false);
}

/* ===== ADD TRANSACTION ===== */
function normalizeAmount(v){ const n=Number(v); if (!isFinite(n) || n<=0) return NaN; return Math.round(n*100)/100; }
async function saveTx(keep=false){
  const amount = normalizeAmount($('#txAmount').value);
  const payload = { date: $('#txDate').value, type: $('#txType').value, category_id: $('#txCat').value, amount, note: $('#txNote').value.trim() };
  if (!payload.date){ $('#txMsg').textContent='กรุณาเลือกวันที่'; toast('กรุณาเลือกวันที่', false); return; }
  if (!payload.category_id || isNaN(amount)){ $('#txMsg').textContent='ข้อมูลไม่ครบหรือจำนวนเงินไม่ถูกต้อง'; toast('ตรวจสอบข้อมูลให้ครบก่อน', false); return; }
  $('#btnSave').disabled = true;
  const r = await api('transactions/create', payload, true);
  $('#btnSave').disabled = false;
  if (r.ok){
    $('#txMsg').textContent='บันทึกแล้ว'; toast('บันทึกสำเร็จ');
    $('#txAmount').value=''; $('#txNote').value='';
    if (!keep){ setType('expense'); $('#txDate').value = todayISO(); }
    refreshDash(true); $('#txAmount').focus();
  } else { $('#txMsg').textContent='ไม่สำเร็จ'; toast('บันทึกไม่สำเร็จ', false); }
}
$('#btnSave').addEventListener('click', ()=> saveTx($('#keepSwitch').checked));
$('#tab-add').addEventListener('keydown', (e)=>{ if (e.key==='Enter'){ e.preventDefault(); saveTx($('#keepSwitch').checked); } });

/* ===== DASHBOARD / RANGES ===== */
let chartExp=null, chartFlow=null, chartSavCum=null;
function setKpiLoading(on){
  ['sumIncome','sumExpense','sumSaving','sumNet'].forEach(id=>{
    const el=$('#'+id);
    el.textContent = on ? '—' : el.textContent;
  });
}
function setRangeDaysBack(days){
  const now = new Date(); const from = toYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate()-days+1)); const to = toYMD(now);
  $('#fFrom').value = from; $('#fTo').value = to; onRangeChange();
}
$('#btnToday').addEventListener('click', ()=>{ const d=todayISO(); $('#fFrom').value=d; $('#fTo').value=d; onRangeChange(); });
$('#btn7').addEventListener('click', ()=> setRangeDaysBack(7));
$('#btn30').addEventListener('click', ()=> setRangeDaysBack(30));
$('#btnMonth').addEventListener('click', ()=>{ const mb=monthBoundsOf(new Date()); $('#fFrom').value=mb.start; $('#fTo').value=mb.end; onRangeChange(); });
$('#btnYear').addEventListener('click', ()=>{ const y=new Date().getFullYear(); $('#fFrom').value=`${y}-01-01`; $('#fTo').value=`${y}-12-31`; onRangeChange(); });
$('#btnRefresh').addEventListener('click', ()=> refreshDash());
function onRangeChange(){ updateRangeUI(); refreshDash(); }
$('#fFrom').addEventListener('change', onRangeChange);
$('#fTo').addEventListener('change', onRangeChange);

function updateRangeUI(){
  const f=$('#fFrom').value, t=$('#fTo').value;
  const today=todayISO(); const mb = monthBoundsOf(new Date());
  const now=new Date();
  const last7  = toYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate()-6));
  const last30 = toYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate()-29));
  const yStart= `${now.getFullYear()}-01-01`, yEnd=`${now.getFullYear()}-12-31`;
  const isToday = (f===today && t===today);
  const is7     = (f===last7  && t===today);
  const is30    = (f===last30 && t===today);
  const isMonth = (f===mb.start && t===mb.end);
  const isYear  = (f===yStart && t===yEnd);
  $('#rangeBadge').textContent = isToday?'วันนี้':is7?'7 วันล่าสุด':is30?'30 วันล่าสุด':isMonth?'เดือนนี้':isYear?'ปีนี้':'กำหนดเอง';
  [['btnToday',isToday],['btn7',is7],['btn30',is30],['btnMonth',isMonth],['btnYear',isYear]].forEach(([id,on])=>{
    const el=$('#'+id); el.classList.toggle('active', !!on);
  });
}

async function refreshDash(silent){
  if (!token){ if(!silent) toast('ยังไม่พบ token (กรุณาเข้าสู่ระบบก่อน)', false); return; }
  setKpiLoading(true);
  if (!cats.expense.length && !cats.income.length && !cats.saving.length){ await loadCategoriesAll(); }

  const mk = monthKeyFromRange();
  await loadMonthSettingsFromAPI(mk).catch(()=>{});

  const from = $('#fFrom').value, to = $('#fTo').value;
  const r = await api('transactions/list', { from, to, type:'all' });
  if (!r.ok){ if(!silent) toast('โหลดข้อมูลไม่สำเร็จ', false); return; }
  const items = (r.items||[]).map(x=> ({...x, amount:+x.amount}));
  lastItems = items.slice();

  const inc = sum(items, x=> x.type==='income'? x.amount:0);
  const exp = sum(items, x=> x.type==='expense'? x.amount:0);
  const savDep = sum(items, x=> x.type==='saving'? x.amount:0);
  const savWd  = sum(items, x=> x.type==='income' && withdrawIncomeIds.has(x.category_id) ? x.amount : 0);
  const savNet = savDep - savWd;
  const net    = inc - exp - savDep;

  $('#sumIncome').textContent = fmt(inc);
  $('#sumExpense').textContent = fmt(exp);
  $('#sumSaving').textContent  = fmt(savNet);
  $('#sumNet').textContent     = fmt(net);

  await updateBudgetUI(exp, savNet, mk);
  drawExpByCat(items, buildCatMap());
  drawFlow(items);
  drawSavingCum(items);
  renderList(items);
}

/* ===== Budget UI ===== */
async function updateBudgetUI(expenseTotal, savingNet, mk){
  const cache = monthSettingsCache[mk] || { budget:0, goal:0 };
  const b = Number(cache.budget||0), g = Number(cache.goal||0);

  const pct = (!b || b<=0) ? 0 : Math.round((expenseTotal/b)*100);
  $('#budgetUsedPct').textContent = b>0 ? `${pct}%` : '—';
  $('#budgetBar').style.width = (b>0 ? Math.min(pct,100) : 0) + '%';

  let bTxt='รายจ่ายเดือนนี้: —';
  if (b>0){
    if (expenseTotal > b) bTxt = `เกินงบ ${fmt(expenseTotal - b)}`;
    else                  bTxt = `เหลืองบ ${fmt(b - expenseTotal)}`;
  }
  $('#budgetStatus').textContent = bTxt;

  const savingClamped = Math.max(0, savingNet);
  const pctSave = (!g || g<=0) ? 0 : Math.round((savingClamped/g)*100);
  $('#savingGoalPct').textContent = g>0 ? `${pctSave}%` : '—';
  $('#savingBar').style.width = (g>0 ? Math.min(pctSave,100) : 0) + '%';

  let sTxt='—';
  if (g>0){
    if (savingNet>=g) sTxt = `ถึงเป้าแล้ว (+${fmt(savingNet-g)})`;
    else              sTxt = `ขาดอีก ${fmt(g - savingNet)}`;
  }
  $('#savingGoalStatus').textContent = sTxt;
}
$('#btnSaveBudget').addEventListener('click', async ()=>{
  const mk = monthKeyFromRange();
  const vb = Number($('#budgetThisMonth').value||0);
  const vg = Number($('#savingGoalThisMonth').value||0);
  const ok = await saveMonthSettingsToAPI(
    mk,
    (isFinite(vb)&&vb>0)?Math.round(vb*100)/100:0,
    (isFinite(vg)&&vg>0)?Math.round(vg*100)/100:0
  );
  if (ok){
    toast('บันทึกงบ/เป้าออมสำเร็จ');
    await loadMonthSettingsFromAPI(mk);
    const exp = sum(lastItems, x=> x.type==='expense'? x.amount:0);
    const savDep = sum(lastItems, x=> x.type==='saving'? x.amount:0);
    const savWd  = sum(lastItems, x=> x.type==='income' && withdrawIncomeIds.has(x.category_id)? x.amount:0);
    await updateBudgetUI(exp, savDep - savWd, mk);
  } else { toast('บันทึกงบ/เป้าออมไม่สำเร็จ', false); }
});

/* ===== CHARTS ===== */
function buildCatMap(){ return Object.fromEntries((cats.expense.concat(cats.income).concat(cats.saving)).map(c=> [c.category_id, c.name_th])); }
function drawExpByCat(items, mapCat){
  const panelNo = $('#noDataExp'); if (window.chartExp) window.chartExp.destroy();
  const exps = items.filter(x=>x.type==='expense');
  if (!exps.length){ panelNo.classList.remove('hide'); return; }
  panelNo.classList.add('hide');
  const groupExp = groupBy(exps, x=> mapCat[x.category_id] || 'อื่น ๆ');
  const labels = Object.keys(groupExp);
  const data = labels.map(k=> sum(groupExp[k], x=> x.amount));
  window.chartExp = new Chart($('#chartExp'), {
    type:'bar',
    data:{ labels, datasets:[{ label:'จำนวน (บาท)', data }] },
    options:{ responsive:true, maintainAspectRatio:false, animation:false, scales:{ y:{ beginAtZero:true }}, plugins:{ legend:{ display:false } } }
  });
}
function drawFlow(items){
  const panelNo = $('#noDataFlow'); if (window.chartFlow) window.chartFlow.destroy();
  if (!items.length){ panelNo.classList.remove('hide'); return; }
  panelNo.classList.add('hide');
  const g = groupBy(items, x=> x.date);
  const ds = Object.keys(g).sort();
  const income  = ds.map(d=> sum(g[d], x=> x.type==='income'?  x.amount:0));
  const expense = ds.map(d=> sum(g[d], x=> x.type==='expense'? x.amount:0));
  const savingD = ds.map(d=> sum(g[d], x=> x.type==='saving'?  x.amount:0));
  const netDaily = ds.map((_,i)=> income[i] - expense[i] - savingD[i]);
  const netCumulative = runningSum(netDaily);
  window.chartFlow = new Chart($('#chartFlow'), {
    type:'line',
    data:{ labels: ds,
      datasets:[
        { label:'รายรับ', data:income },
        { label:'รายจ่าย', data:expense },
        { label:'คงเหลือสะสม', data:netCumulative }
      ]
    },
    options:{ responsive:true, maintainAspectRatio:false, animation:false, interaction:{ mode:'index', intersect:false }, scales:{ y:{ beginAtZero:true } } }
  });
}
function drawSavingCum(items){
  const panelNo = $('#noDataSav'); if (window.chartSavCum) window.chartSavCum.destroy();
  const byDateDep = groupBy(items.filter(x=>x.type==='saving'), x=> x.date);
  const byDateWdr = groupBy(items.filter(x=> x.type==='income' && withdrawIncomeIds.has(x.category_id)), x=> x.date);
  const dates = Array.from(new Set([...Object.keys(byDateDep), ...Object.keys(byDateWdr)])).sort();
  if (!dates.length){ panelNo.classList.remove('hide'); return; }
  panelNo.classList.add('hide');
  const netPerDay = dates.map(d=>{
    const dep = sum(byDateDep[d]||[], x=> x.amount);
    const wdr = sum(byDateWdr[d]||[], x=> x.amount);
    return dep - wdr;
  });
  const cum = runningSum(netPerDay);
  window.chartSavCum = new Chart($('#chartSavCum'), {
    type:'line',
    data:{ labels: dates, datasets:[{ label:'ออมสุทธิสะสม', data:cum }] },
    options:{ responsive:true, maintainAspectRatio:false, animation:false, scales:{ y:{ beginAtZero:true }}}
  });
}

/* ===== LIST + EDIT ===== */
function renderList(items){
  const wrap = $('#listWrap');
  wrap.querySelectorAll('.transaction-item').forEach(n=> n.remove());
  const sorted = items.slice().sort((a,b)=> safeKey(b).localeCompare(safeKey(a)));
  $('#emptyList').style.display = sorted.length? 'none':'block';
  $('#listCount').textContent = `${sorted.length} รายการ`;

  const catMap = buildCatMap();
  for (const x of sorted){
    const li = document.createElement('div');
    li.className='transaction-item';

    const isWithdrawIncome = (x.type==='income' && withdrawIncomeIds.has(x.category_id));
    const typeTxt = x.type==='income'?(isWithdrawIncome?'รายรับ (ถอนออม)':'รายรับ'):(x.type==='saving'?'ออมเงิน':'รายจ่าย');
    const iconType = x.type==='income'?'income':(x.type==='saving'?'saving':'expense');
    const catName = catMap[x.category_id] || x.category_name || x.category_id || '';

    li.innerHTML = `
      <div class="transaction-info">
        <div class="transaction-icon ${iconType}">
          <span class="material-icons">${iconType==='income'?'trending_up':iconType==='saving'?'savings':'trending_down'}</span>
        </div>
        <div class="transaction-details">
          <h4>${esc(catName)} — <span class="inline-muted">${typeTxt}</span></h4>
          <p>${esc((x.date||'').slice(0,10))}${x.note? ' · '+esc(x.note):''}</p>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px">
        <div class="transaction-amount ${x.type}">${fmt(x.amount)}</div>
        <div class="row-actions">
          <button class="pill" data-act="edit" data-id="${esc(x.tx_id||'')}">แก้ไข</button>
        </div>
      </div>`;
    wrap.appendChild(li);
  }
}
$('#listWrap').addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-act="edit"]'); if (!btn) return; openEditById(btn.getAttribute('data-id'));
});
function populateEditCatSelect(){
  const t = $('#editType').value; const sel = $('#editCat'); sel.innerHTML='';
  (cats[t]||[]).forEach(c=>{ const o=document.createElement('option'); o.value=c.category_id; o.textContent=c.name_th; sel.appendChild(o); });
}
async function openEditById(txId){
  if (!txId){ toast('ไม่พบรหัสรายการ', false); return; }
  let it = lastItems.find(x=> String(x.tx_id)===String(txId));
  if (!it){
    const r = await api('transactions/list', { from: $('#fFrom').value, to: $('#fTo').value, type:'all' });
    if (!r.ok){ toast('โหลดรายการไม่สำเร็จ', false); return; }
    lastItems = (r.items||[]); it = lastItems.find(x=> String(x.tx_id)===String(txId));
    if (!it){ toast('รายการหายไปแล้ว', false); return; }
  }
  $('#editTxId').value = it.tx_id;
  $('#editDate').value = (it.date||'').slice(0,10);
  $('#editType').value = it.type;
  populateEditCatSelect();
  $('#editCat').value = it.category_id;
  $('#editAmount').value = String(it.amount);
  $('#editNote').value = it.note||'';
  $('#editBackdrop').classList.add('show');
}
function closeEdit(){ $('#editBackdrop').classList.remove('show'); }
$('#btnCancel').addEventListener('click', closeEdit);
$('#editType').addEventListener('change', populateEditCatSelect);
$('#btnUpdate').addEventListener('click', async ()=>{
  const tx_id = $('#editTxId').value;
  const amount = Number($('#editAmount').value);
  if (!tx_id || !isFinite(amount) || amount<=0){ toast('ข้อมูลไม่ครบหรือจำนวนเงินไม่ถูกต้อง', false); return; }
  const payload = { tx_id, date: $('#editDate').value, type: $('#editType').value, category_id: $('#editCat').value, amount: Math.round(amount*100)/100, note: $('#editNote').value.trim() };
  $('#btnUpdate').disabled = true;
  const r = await api('transactions/update', payload, true);
  $('#btnUpdate').disabled = false;
  if (r.ok){ toast('อัปเดตสำเร็จ'); closeEdit(); refreshDash(true); } else toast(r.message||'อัปเดตไม่สำเร็จ', false);
});
$('#btnDelete').addEventListener('click', async ()=>{
  $('#confirmMsg').textContent='ยืนยันการลบรายการนี้?';
  $('#confirmBackdrop').classList.add('show');
  const ok = await new Promise(resolve=>{
    const yes=()=>{ cleanup(); resolve(true); };
    const no =()=>{ cleanup(); resolve(false); };
    const cleanup=()=>{
      $('#btnYes').removeEventListener('click', yes);
      $('#btnNo').removeEventListener('click', no);
      $('#confirmBackdrop').classList.remove('show');
    };
    $('#btnYes').addEventListener('click', yes);
    $('#btnNo').addEventListener('click', no);
  });
  if (!ok) return;
  const tx_id = $('#editTxId').value; if (!tx_id) return;
  $('#btnDelete').disabled = true;
  const r = await api('transactions/delete', { tx_id }, true);
  $('#btnDelete').disabled = false;
  if (r.ok){ toast('ลบเรียบร้อย'); closeEdit(); refreshDash(true); } else toast(r.message||'ลบไม่สำเร็จ', false);
});

/* ===== INIT ===== */
function ensureRangeDefaults(){
  if (!$('#fFrom').value || !$('#fTo').value){
    const now = new Date(); const mb = monthBoundsOf(now);
    $('#fFrom').value = mb.start; $('#fTo').value = mb.end;
  }
  updateRangeUI();
}
function init(){
  setType('expense'); ensureLoginUI(); renderQAs();
}
init();
