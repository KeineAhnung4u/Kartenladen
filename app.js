const KEY = 'pokeshop-data-v1';
const GITHUB_KEY = 'pokeshop-github-config';
const DB_FILE = 'data.json';

let state = { items: [], sales: [], purchases: [] };
let view = 'kasse';
let cart = [];
let priceResults = null;
let priceLoading = false;
let priceQuery = '';
let selectedCardForImport = null;
let renderTimer = null;
let saveTimer = null;
let githubSyncTimer = null;
let githubSyncing = false;

let searchState = {
  kasse: '', lager: '', ankauf: '', preiseName: '',
  kasseSet: '', lagerSet: '', ankaufSet: '', preiseSet: ''
};
let apiFilterOptions = { sets: [], types: [], rarities: [] };
let githubConfig = { token: '', user: '', repo: '', branch: 'main', lastSync: null, lastError: null };

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function eur(n) { return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2) + ' €'; }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ============ GITHUB SYNC ============
function loadGithubConfig() {
  try {
    const raw = localStorage.getItem(GITHUB_KEY);
    if (raw) githubConfig = { ...githubConfig, ...JSON.parse(raw) };
  } catch (e) {}
}

function saveGithubConfig() {
  localStorage.setItem(GITHUB_KEY, JSON.stringify(githubConfig));
}

function isGithubConfigured() {
  return githubConfig.token && githubConfig.user && githubConfig.repo;
}

function updateSyncStatus(status, message) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.className = 'sync-status ' + status;
  el.textContent = message;
}

async function githubGetFile() {
  if (!isGithubConfigured()) return null;
  const url = `https://api.github.com/repos/${githubConfig.user}/${githubConfig.repo}/contents/${DB_FILE}?ref=${githubConfig.branch}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${githubConfig.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (res.status === 404) return { sha: null, content: null };
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const data = await res.json();
  const decoded = atob(data.content.replace(/\n/g, ''));
  return { sha: data.sha, content: decoded };
}

async function githubPutFile(content, sha) {
  if (!isGithubConfigured()) return false;
  const url = `https://api.github.com/repos/${githubConfig.user}/${githubConfig.repo}/contents/${DB_FILE}`;
  const body = {
    message: `sync ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: githubConfig.branch
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${githubConfig.token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return true;
}

async function syncFromGithub() {
  if (!isGithubConfigured()) return false;
  try {
    updateSyncStatus('syncing', '⏳ Lade...');
    const file = await githubGetFile();
    if (file && file.content) {
      const remote = JSON.parse(file.content);
      state = remote;
      localStorage.setItem(KEY, JSON.stringify(state));
      githubConfig.lastSync = new Date().toISOString();
      githubConfig.lastError = null;
      saveGithubConfig();
      updateSyncStatus('ok', `✓ ${new Date().toLocaleTimeString('de-DE')}`);
      return true;
    } else {
      updateSyncStatus('ok', '✓ Lokal (leer auf GitHub)');
      return false;
    }
  } catch (e) {
    console.error('GitHub Load Error:', e);
    githubConfig.lastError = e.message;
    saveGithubConfig();
    updateSyncStatus('error', '✗ ' + e.message);
    return false;
  }
}

async function syncToGithub() {
  if (!isGithubConfigured() || githubSyncing) return;
  githubSyncing = true;
  try {
    updateSyncStatus('syncing', '⏳ Speichere...');
    const content = JSON.stringify(state);
    let sha = null;
    try {
      const file = await githubGetFile();
      sha = file ? file.sha : null;
    } catch (e) {}
    await githubPutFile(content, sha);
    githubConfig.lastSync = new Date().toISOString();
    githubConfig.lastError = null;
    saveGithubConfig();
    updateSyncStatus('ok', `✓ ${new Date().toLocaleTimeString('de-DE')}`);
  } catch (e) {
    console.error('GitHub Save Error:', e);
    githubConfig.lastError = e.message;
    saveGithubConfig();
    updateSyncStatus('error', '✗ ' + e.message);
  } finally {
    githubSyncing = false;
  }
}

function scheduleGithubSync() {
  if (!isGithubConfigured()) return;
  clearTimeout(githubSyncTimer);
  githubSyncTimer = setTimeout(syncToGithub, 1500);
}

// ============ LOCAL SAVE ============
async function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    scheduleGithubSync();
  } catch (e) { console.error('Save failed', e); }
}

async function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { console.warn('Load failed', e); }
}

// ============ BUSINESS LOGIC ============
function addToCart(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item || item.qty <= 0) return;
  const line = cart.find(c => c.itemId === itemId);
  if (line) { if (line.qty < item.qty) line.qty++; }
  else cart.push({ itemId, qty: 1 });
  render();
}

function changeCartQty(itemId, delta) {
  const line = cart.find(c => c.itemId === itemId);
  const item = state.items.find(i => i.id === itemId);
  if (!line) return;
  line.qty += delta;
  if (line.qty > item.qty) line.qty = item.qty;
  if (line.qty <= 0) cart = cart.filter(c => c.itemId !== itemId);
  render();
}

function cartTotal() {
  return cart.reduce((sum, c) => {
    const item = state.items.find(i => i.id === c.itemId);
    return sum + (item ? item.sellPrice * c.qty : 0);
  }, 0);
}

async function checkout() {
  if (cart.length === 0) return;
  const total = cartTotal();
  state.sales.push({
    id: uid(), date: todayStr(),
    items: cart.map(c => {
      const item = state.items.find(i => i.id === c.itemId);
      return { itemId: c.itemId, name: item.name, qty: c.qty, price: item.sellPrice };
    }),
    total
  });
  cart.forEach(c => {
    const item = state.items.find(i => i.id === c.itemId);
    if (item) item.qty = Math.max(0, item.qty - c.qty);
  });
  cart = [];
  await save();
  showToast('Verkauf: ' + eur(total));
  render();
}

async function addItem(form) {
  const name = form.name.value.trim();
  if (!name) return;
  state.items.push({
    id: uid(), name, category: form.category.value,
    qty: parseInt(form.qty.value) || 0,
    buyPrice: parseFloat(form.buyPrice.value) || 0,
    sellPrice: parseFloat(form.sellPrice.value) || 0,
    set: form.set.value, type: form.type.value, rarity: form.rarity.value
  });
  await save();
  form.reset();
  showToast('Hinzugefügt');
  render();
}

async function deleteItem(id) {
  if (!confirm('Wirklich löschen?')) return;
  state.items = state.items.filter(i => i.id !== id);
  await save();
  render();
}

async function updateItemField(id, field, value) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (field === 'name' || field === 'category') item[field] = value;
  else if (field === 'qty') item.qty = Math.max(0, parseInt(value) || 0);
  else item[field] = Math.max(0, parseFloat(value) || 0);
  await save();
}

async function addPurchase(form) {
  const name = form.pname.value.trim();
  if (!name) return;
  const qty = parseInt(form.pqty.value) || 1;
  const price = parseFloat(form.pprice.value) || 0;
  state.purchases.push({
    id: uid(), date: todayStr(), name, qty, pricePaid: price,
    set: form.pset.value, type: form.ptype.value, rarity: form.prarity.value
  });
  if (form.addToStock.checked) {
    let existing = state.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.qty += qty;
      existing.buyPrice = price / qty || existing.buyPrice;
    } else {
      state.items.push({
        id: uid(), name, category: form.pcategory.value, qty,
        buyPrice: price / qty || 0, sellPrice: 0,
        set: form.pset.value, type: form.ptype.value, rarity: form.prarity.value
      });
    }
  }
  await save();
  form.reset();
  selectedCardForImport = null;
  showToast('Ankauf erfasst');
  render();
}

async function loadApiFilterOptions() {
  const endpoints = [
    { key: 'sets', url: 'https://api.pokemontcg.io/v2/sets' },
    { key: 'types', url: 'https://api.pokemontcg.io/v2/types' },
    { key: 'rarities', url: 'https://api.pokemontcg.io/v2/rarities' }
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url);
      if (!res.ok) continue;
      const data = await res.json();
      apiFilterOptions[ep.key] = (data.data || []).map(i => typeof i === 'string' ? i : i.name).filter(Boolean).sort();
    } catch (e) {}
  }
  render();
}

function filterItems(items, term, filterState = {}) {
  const needle = (term || '').toLowerCase();
  return items.filter(item => {
    const matchTerm = !needle || item.name.toLowerCase().includes(needle);
    const matchSet = !filterState.set || (item.set || '').toLowerCase().includes(filterState.set.toLowerCase());
    const matchType = !filterState.type || (item.type || '').toLowerCase().includes(filterState.type.toLowerCase());
    const matchRarity = !filterState.rarity || (item.rarity || '').toLowerCase().includes(filterState.rarity.toLowerCase());
    return matchTerm && matchSet && matchType && matchRarity;
  });
}

function buildPriceQuery(term) {
  const words = term.trim().split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return '';
  return words.map(w => `name:*${w.toLowerCase()}*`).join(' AND ');
}

async function searchPrice() {
  const query = buildPriceQuery(searchState.preiseName);
  if (!query) { priceResults = []; render(); return; }
  priceLoading = true;
  priceQuery = searchState.preiseName;
  render();
  try {
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=8`;
    const res = await fetch(url);
    const data = await res.json();
    priceResults = data.data || [];
  } catch (e) {
    priceResults = 'error';
  }
  priceLoading = false;
  render();
}

function getFocusRestoreState(activeElement) {
  if (!activeElement || !['INPUT', 'SELECT', 'TEXTAREA'].includes(activeElement.tagName)) return null;
  const ds = activeElement.dataset;
  let selector = null;
  if (ds.searchKasse !== undefined) selector = '[data-search-kasse]';
  else if (ds.searchLager !== undefined) selector = '[data-search-lager]';
  else if (ds.searchAnkauf !== undefined) selector = '[data-search-ankauf]';
  else if (ds.searchPreise !== undefined) selector = '[data-search-preise]';
  if (!selector) return null;
  return {
    selector,
    selectionStart: activeElement.selectionStart ?? activeElement.value.length,
    selectionEnd: activeElement.selectionEnd ?? activeElement.value.length
  };
}

function render() {
  const focusRestore = getFocusRestoreState(document.activeElement);
  const app = document.getElementById('app');
  const syncText = githubConfig.lastSync
    ? `✓ ${new Date(githubConfig.lastSync).toLocaleTimeString('de-DE')}`
    : (isGithubConfigured() ? '⏳ nie' : '⚠ nicht verbunden');
  const syncClass = githubConfig.lastError ? 'error' : (githubConfig.lastSync ? 'ok' : '');

  app.innerHTML = `
    <div class="header">
      <h1>Kartenladen Manager</h1>
      <div id="sync-status" class="sync-status ${syncClass}">${syncText}</div>
    </div>
    <div class="tabs">
      ${['kasse', 'lager', 'ankauf', 'statistik', 'preise', 'settings'].map((v, i) =>
        `<button class="tab ${view === v ? 'active' : ''}" data-view="${v}">${i + 1}. ${v.charAt(0).toUpperCase() + v.slice(1)}</button>`
      ).join('')}
    </div>
    <div id="content"></div>`;
  app.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { view = t.dataset.view; render(); }));
  const content = document.getElementById('content');
  if (view === 'kasse') content.innerHTML = renderKasse();
  else if (view === 'lager') content.innerHTML = renderLager();
  else if (view === 'ankauf') content.innerHTML = renderAnkauf();
  else if (view === 'statistik') content.innerHTML = renderStatistik();
  else if (view === 'preise') content.innerHTML = renderPreise();
  else if (view === 'settings') content.innerHTML = renderSettings();
  attachHandlers();
  if (focusRestore) {
    requestAnimationFrame(() => {
      const target = document.querySelector(focusRestore.selector);
      if (target) {
        target.focus();
        if (target.setSelectionRange) target.setSelectionRange(focusRestore.selectionStart, focusRestore.selectionEnd);
      }
    });
  }
}

function renderKasse() {
  const available = state.items.filter(i => i.qty > 0);
  const filtered = filterItems(available, searchState.kasse, { set: searchState.kasseSet });
  return `
    <div class="row">
      <div style="flex:2;">
        <div class="card">
          <h2>Artikel</h2>
          <div class="row" style="margin-bottom:12px;">
            <div class="field"><input data-search-kasse value="${esc(searchState.kasse)}" placeholder="Suche..."></div>
            <div class="field" style="max-width:180px;">
              <select data-kasse-filter="set"><option value="">Alle Sets</option>${apiFilterOptions.sets.map(o => `<option value="${esc(o)}" ${searchState.kasseSet === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
            </div>
          </div>
          ${filtered.length === 0 ? '<div class="empty">Keine Artikel</div>' : `
            <table>
              <thead><tr><th>Name</th><th>Bestand</th><th>Preis</th><th></th></tr></thead>
              <tbody>
                ${filtered.map(i => `
                  <tr>
                    <td>${esc(i.name)}</td>
                    <td>${i.qty}</td>
                    <td><span class="tag tag-price">${eur(i.sellPrice)}</span></td>
                    <td><button data-add="${i.id}">+</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>
      <div style="flex:1;">
        <div class="card">
          <h2>Warenkorb</h2>
          ${cart.length === 0 ? '<div class="empty">Leer</div>' : cart.map(c => {
            const item = state.items.find(i => i.id === c.itemId);
            return `<div class="cart-line">
              <div>${esc(item.name)}<br><small>${eur(item.sellPrice)} × ${c.qty}</small></div>
              <div>
                <button class="icon-btn" data-dec="${c.itemId}">−</button>
                <button class="icon-btn" data-inc="${c.itemId}">+</button>
              </div>
            </div>`;
          }).join('')}
          <div class="total-box">
            <span>Gesamt</span>
            <span class="amount">${eur(cartTotal())}</span>
          </div>
          <button class="btn-primary" style="width:100%;margin-top:12px;" id="checkoutBtn" ${cart.length === 0 ? 'disabled' : ''}>Abschließen</button>
        </div>
      </div>
    </div>`;
}

function renderLager() {
  const filtered = filterItems(state.items, searchState.lager, { set: searchState.lagerSet });
  return `
    <div class="card">
      <h2>Neuer Artikel</h2>
      <form id="addItemForm">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required></div>
          <div class="field" style="max-width:120px;"><label>Kat.</label><select name="category"><option value="single">Einzelkarte</option><option value="sealed">Sealed</option><option value="merch">Merch</option></select></div>
          <div class="field" style="max-width:80px;"><label>Menge</label><input name="qty" type="number" value="1"></div>
          <div class="field" style="max-width:100px;"><label>EK</label><input name="buyPrice" type="number" step="0.01" value="0"></div>
          <div class="field" style="max-width:100px;"><label>VK</label><input name="sellPrice" type="number" step="0.01" value="0"></div>
          <button type="submit" class="btn-primary">+</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <div class="field"><label>Set</label><select name="set"><option value="">—</option>${apiFilterOptions.sets.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></div>
          <div class="field"><label>Typ</label><select name="type"><option value="">—</option>${apiFilterOptions.types.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></div>
          <div class="field"><label>Rarity</label><select name="rarity"><option value="">—</option>${apiFilterOptions.rarities.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></div>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Bestand (${filtered.length})</h2>
      <div class="row" style="margin-bottom:12px;">
        <div class="field"><input data-search-lager value="${esc(searchState.lager)}" placeholder="Suche..."></div>
        <div class="field" style="max-width:180px;">
          <select data-lager-filter="set"><option value="">Alle Sets</option>${apiFilterOptions.sets.map(o => `<option value="${esc(o)}" ${searchState.lagerSet === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
        </div>
      </div>
      ${filtered.length === 0 ? '<div class="empty">Keine Artikel</div>' : `
        <table>
          <thead><tr><th>Name</th><th>Menge</th><th>EK</th><th>VK</th><th></th></tr></thead>
          <tbody>
            ${filtered.map(i => `
              <tr>
                <td><input data-edit="${i.id}" data-field="name" value="${esc(i.name)}" style="width:100%;"></td>
                <td><input data-edit="${i.id}" data-field="qty" type="number" value="${i.qty}" style="width:60px;"></td>
                <td><input data-edit="${i.id}" data-field="buyPrice" type="number" step="0.01" value="${i.buyPrice}" style="width:80px;"></td>
                <td><input data-edit="${i.id}" data-field="sellPrice" type="number" step="0.01" value="${i.sellPrice}" style="width:80px;"></td>
                <td><button class="icon-btn" data-del="${i.id}">✕</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>`;
}

function renderAnkauf() {
  const prefilled = selectedCardForImport || {};
  return `
    <div class="card">
      <h2>Ankauf</h2>
      <form id="addPurchaseForm">
        <div class="row">
          <div class="field"><label>Name</label><input name="pname" value="${esc(prefilled.name || '')}" required></div>
          <div class="field" style="max-width:100px;"><label>Menge</label><input name="pqty" type="number" value="1"></div>
          <div class="field" style="max-width:120px;"><label>Preis</label><input name="pprice" type="number" step="0.01" value="${esc(prefilled.price || '')}"></div>
          <div class="field" style="max-width:120px;display:flex;align-items:center;gap:6px;">
            <input type="checkbox" name="addToStock" checked style="width:auto;">
            <label style="margin:0;">Ins Lager</label>
          </div>
          <button type="submit" class="btn-primary">Speichern</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <div class="field"><label>Set</label><select name="pset"><option value="">—</option>${apiFilterOptions.sets.map(o => `<option value="${esc(o)}" ${prefilled.set === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
          <div class="field"><label>Typ</label><select name="ptype"><option value="">—</option>${apiFilterOptions.types.map(o => `<option value="${esc(o)}" ${prefilled.type === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
          <div class="field"><label>Rarity</label><select name="prarity"><option value="">—</option>${apiFilterOptions.rarities.map(o => `<option value="${esc(o)}" ${prefilled.rarity === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Historie (${state.purchases.length})</h2>
      ${state.purchases.length === 0 ? '<div class="empty">Keine Ankäufe</div>' : `
        <table>
          <thead><tr><th>Datum</th><th>Name</th><th>Menge</th><th>Preis</th></tr></thead>
          <tbody>
            ${state.purchases.slice().reverse().map(p => `
              <tr>
                <td>${p.date}</td>
                <td>${esc(p.name)}</td>
                <td>${p.qty}</td>
                <td><span class="tag tag-price">${eur(p.pricePaid)}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>`;
}

function renderStatistik() {
  const revenue = state.sales.reduce((s, x) => s + x.total, 0);
  const spent = state.purchases.reduce((s, x) => s + x.pricePaid, 0);
  const profit = revenue - spent;
  const unitsSold = state.sales.reduce((s, x) => s + x.items.reduce((a, i) => a + i.qty, 0), 0);
  const lagerWert = state.items.reduce((s, x) => s + x.qty * x.sellPrice, 0);
  return `
    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Umsatz</div><div class="stat-value gold">${eur(revenue)}</div></div>
      <div class="stat"><div class="stat-label">Ausgaben</div><div class="stat-value red">${eur(spent)}</div></div>
      <div class="stat"><div class="stat-label">Gewinn</div><div class="stat-value ${profit >= 0 ? 'green' : 'red'}">${eur(profit)}</div></div>
      <div class="stat"><div class="stat-label">Verkauft</div><div class="stat-value">${unitsSold}</div></div>
      <div class="stat"><div class="stat-label">Lagerwert</div><div class="stat-value">${eur(lagerWert)}</div></div>
    </div>`;
}

function renderPreise() {
  let resultsHtml = '';
  if (priceLoading) resultsHtml = '<div class="empty">Suche...</div>';
  else if (priceResults === 'error') resultsHtml = '<div class="empty">Fehler</div>';
  else if (Array.isArray(priceResults) && priceResults.length > 0) {
    resultsHtml = priceResults.map(c => {
      const cm = c.cardmarket?.prices;
      const cmUrl = `https://www.cardmarket.com/de/Pokemon/Products/Singles/Search?searchString=${encodeURIComponent(c.name)}`;
      return `
        <div class="price-result">
          ${c.images?.small ? `<img src="${c.images.small}">` : ''}
          <div class="price-result-info">
            <div class="price-result-name">${esc(c.name)}</div>
            <div class="price-result-meta">${esc(c.set?.name || '')} ${c.number ? '#' + esc(c.number) : ''}</div>
            <div class="price-badges">
              ${cm?.averageSellPrice ? `<span class="tag tag-price">Ø ${eur(cm.averageSellPrice)}</span>` : ''}
              ${cm?.trendPrice ? `<span class="tag tag-price">Trend ${eur(cm.trendPrice)}</span>` : ''}
            </div>
            <div class="row">
              <button class="btn-primary" data-import-stock="${esc(c.name)}">Lager</button>
              <button class="btn-danger" data-import-purchase="${esc(c.name)}">Ankauf</button>
              <a href="${cmUrl}" target="_blank" class="btn-cm" style="padding:8px 14px;">Cardmarket</a>
            </div>
          </div>
        </div>`;
    }).join('');
  } else if (searchState.preiseName) {
    resultsHtml = '<div class="empty">Keine Treffer</div>';
  }
  return `
    <div class="card">
      <h2>Preise</h2>
      <form id="priceForm" class="row">
        <div class="field" style="flex:2;"><input data-search-preise name="q" value="${esc(searchState.preiseName)}" placeholder="Kartenname..."></div>
        <button type="submit" class="btn-primary">Suchen</button>
      </form>
    </div>
    ${resultsHtml ? `<div class="card">${resultsHtml}</div>` : ''}`;
}

function renderSettings() {
  return `
    <div class="card">
      <h2>GitHub Sync</h2>
      <div class="settings-info">
        Die Daten werden automatisch auf GitHub gespeichert und sind von überall erreichbar.<br>
        <b>Setup:</b> Erstelle einen Token unter <code>github.com/settings/tokens</code> → "Generate new token (classic)" → Scope <code>repo</code> auswählen.<br>
        Erstelle in deinem Repo eine leere Datei <code>data.json</code> (oder lass sie weg, wird automatisch angelegt).
      </div>
      <form id="githubForm">
        <div class="row">
          <div class="field"><label>GitHub Username</label><input name="user" value="${esc(githubConfig.user)}" placeholder="z.B. maxmustermann"></div>
          <div class="field"><label>Repository Name</label><input name="repo" value="${esc(githubConfig.repo)}" placeholder="z.B. kartenladen"></div>
        </div>
        <div class="row" style="margin-top:8px;">
          <div class="field" style="flex:2;"><label>Personal Access Token</label><input name="token" type="password" value="${esc(githubConfig.token)}" placeholder="ghp_xxxxxxxxxxxx"></div>
          <div class="field"><label>Branch</label><input name="branch" value="${esc(githubConfig.branch)}" placeholder="main"></div>
        </div>
        <div class="row" style="margin-top:12px;">
          <button type="submit" class="btn-primary">Speichern & Testen</button>
          <button type="button" id="syncNowBtn" ${!isGithubConfigured() ? 'disabled' : ''}>Jetzt syncen</button>
          <button type="button" id="clearGithubBtn" class="btn-danger">Verbindung trennen</button>
        </div>
      </form>
      ${githubConfig.lastSync ? `<div style="margin-top:12px;font-size:12px;color:#888;">Letzter Sync: ${new Date(githubConfig.lastSync).toLocaleString('de-DE')}</div>` : ''}
      ${githubConfig.lastError ? `<div style="margin-top:8px;font-size:12px;color:#c23b3b;">Letzter Fehler: ${esc(githubConfig.lastError)}</div>` : ''}
    </div>
    <div class="card">
      <h2>Lokales Backup</h2>
      <div class="row">
        <button type="button" id="exportBtn" class="btn-primary">Backup herunterladen</button>
        <button type="button" id="importBtn" class="btn-danger">Backup importieren</button>
        <input type="file" id="importFile" accept=".json" style="display:none;">
      </div>
      <div style="margin-top:8px;font-size:12px;color:#888;">
        ${state.items.length} Artikel · ${state.sales.length} Verkäufe · ${state.purchases.length} Ankäufe
      </div>
    </div>`;
}

function attachHandlers() {
  const addForm = document.getElementById('addItemForm');
  if (addForm) addForm.addEventListener('submit', e => { e.preventDefault(); addItem(e.target); });
  const purForm = document.getElementById('addPurchaseForm');
  if (purForm) purForm.addEventListener('submit', e => { e.preventDefault(); addPurchase(e.target); });
  const priceForm = document.getElementById('priceForm');
  if (priceForm) priceForm.addEventListener('submit', e => { e.preventDefault(); searchState.preiseName = e.target.q.value; searchPrice(); });
  const checkoutBtn = document.getElementById('checkoutBtn');
  if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addToCart(b.dataset.add)));
  document.querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => changeCartQty(b.dataset.inc, 1)));
  document.querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => changeCartQty(b.dataset.dec, -1)));
  document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteItem(b.dataset.del)));
  document.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('change', () => updateItemField(el.dataset.edit, el.dataset.field, el.value)));
  document.querySelectorAll('[data-import-stock]').forEach(b => b.addEventListener('click', () => {
    const name = b.dataset.importStock;
    const existing = state.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.qty++;
    else state.items.push({ id: uid(), name, category: 'single', qty: 1, buyPrice: 0, sellPrice: 0 });
    save().then(() => { render(); showToast('Ins Lager'); });
  }));
  document.querySelectorAll('[data-import-purchase]').forEach(b => b.addEventListener('click', () => {
    selectedCardForImport = { name: b.dataset.importPurchase };
    view = 'ankauf';
    render();
  }));

  const searchKasse = document.querySelector('[data-search-kasse]');
  if (searchKasse) searchKasse.addEventListener('input', e => { searchState.kasse = e.target.value; queueRender(); });
  const searchLager = document.querySelector('[data-search-lager]');
  if (searchLager) searchLager.addEventListener('input', e => { searchState.lager = e.target.value; queueRender(); });
  document.querySelectorAll('[data-kasse-filter]').forEach(el => el.addEventListener('change', e => {
    searchState['kasse' + el.dataset.kasseFilter.charAt(0).toUpperCase() + el.dataset.kasseFilter.slice(1)] = e.target.value;
    queueRender();
  }));
  document.querySelectorAll('[data-lager-filter]').forEach(el => el.addEventListener('change', e => {
    searchState['lager' + el.dataset.lagerFilter.charAt(0).toUpperCase() + el.dataset.lagerFilter.slice(1)] = e.target.value;
    queueRender();
  }));

  // Settings
  const githubForm = document.getElementById('githubForm');
  if (githubForm) {
    githubForm.addEventListener('submit', async e => {
      e.preventDefault();
      githubConfig.user = e.target.user.value.trim();
      githubConfig.repo = e.target.repo.value.trim();
      githubConfig.token = e.target.token.value.trim();
      githubConfig.branch = e.target.branch.value.trim() || 'main';
      saveGithubConfig();
      showToast('Teste Verbindung...');
      const ok = await syncFromGithub();
      if (ok) showToast('✓ Sync erfolgreich');
      else if (isGithubConfigured()) showToast('✓ Konfiguration gespeichert');
      render();
    });
  }
  const syncNowBtn = document.getElementById('syncNowBtn');
  if (syncNowBtn) syncNowBtn.addEventListener('click', async () => {
    await syncFromGithub();
    await syncToGithub();
    render();
  });
  const clearGithubBtn = document.getElementById('clearGithubBtn');
  if (clearGithubBtn) clearGithubBtn.addEventListener('click', () => {
    if (!confirm('GitHub-Verbindung wirklich trennen? Daten bleiben lokal.')) return;
    githubConfig = { token: '', user: '', repo: '', branch: 'main', lastSync: null, lastError: null };
    saveGithubConfig();
    render();
    showToast('Getrennt');
  });

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kartenladen-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup heruntergeladen');
  });
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.items) throw new Error('Ungültiges Format');
        if (!confirm(`Importieren? ${data.items.length} Artikel, ${data.sales?.length || 0} Verkäufe. Lokale Daten werden überschrieben.`)) return;
        state = data;
        await save();
        render();
        showToast('Importiert');
      } catch (err) {
        showToast('Fehler: ' + err.message, true);
      }
      e.target.value = '';
    });
  }
}

function queueRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key >= '1' && e.key <= '6') {
    view = ['kasse', 'lager', 'ankauf', 'statistik', 'preise', 'settings'][parseInt(e.key) - 1];
    render();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  loadGithubConfig();
  const urlParams = new URLSearchParams(window.location.search);
  const importData = urlParams.get('importData');
  if (importData) {
    try {
      selectedCardForImport = JSON.parse(decodeURIComponent(importData));
      view = 'ankauf';
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) {}
  }

  await load();

  if (isGithubConfigured()) {
    try {
      await syncFromGithub();
    } catch (e) {
      console.warn('GitHub sync failed, using local data', e);
    }
  }

  render();
  loadApiFilterOptions();
});