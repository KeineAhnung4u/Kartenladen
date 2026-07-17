const KEY = 'pokeshop-data-v1';
const BACKUP_KEY = 'pokeshop-backup-v1';
let state = { items: [], sales: [], purchases: [] };
let view = 'kasse';
let cart = [];
let priceResults = null;
let priceLoading = false;
let priceQuery = '';
let priceErrorMessage = '';
let selectedCardForImport = null;
let priceSuggestions = [];
let priceSuggestionsLoading = false;
let priceSuggestionTimer = null;
let renderTimer = null;
let searchState = {
  kasse: '', kasseCategory: '', kasseSet: '', kasseType: '', kasseRarity: '', kasseSubtype: '',
  lager: '', lagerCategory: '', lagerSet: '', lagerType: '', lagerRarity: '', lagerSubtype: '',
  ankauf: '', ankaufSet: '', ankaufType: '', ankaufRarity: '', ankaufSubtype: '',
  preiseName: '', preiseSet: '', preiseType: '', preiseRarity: '', preiseSubtype: '',
};
let apiFilterOptions = { sets: [], types: [], subtypes: [], rarities: [], supertypes: [] };
let priceSearchTimer = null;
let priceRequestController = null;
let priceRequestSequence = 0;
let priceSuggestionController = null;
let priceSuggestionSequence = 0;
let priceResponseCache = new Map();
const PRICE_CACHE_TTL_MS = 60000;
const PRICE_TIMEOUT_MS = 8000;
const PRICE_SUGGESTION_TIMEOUT_MS = 6000;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function eur(n) { return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2) + ' €'; }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function buildTextBackup() {
  const lines = ['Pokeshop Backup', `Exported: ${new Date().toISOString()}`, ''];
  state.items.forEach(item => {
    const extra = item.filterTags ? `\t${JSON.stringify(item.filterTags)}` : '\t';
    lines.push(`${item.name}\t${item.category}\t${item.qty}\t${item.buyPrice}\t${item.sellPrice}${extra}`);
  });
  return lines.join('\n');
}

async function save() {
  const payload = JSON.stringify(state);
  const textBackup = buildTextBackup();
  try {
    if (window.storage && typeof window.storage.set === 'function') {
      await window.storage.set(KEY, payload, false);
      await window.storage.set(BACKUP_KEY, payload, false);
      await window.storage.set('pokeshop-text-backup-v1', textBackup, false);
    } else {
      localStorage.setItem(KEY, payload);
      localStorage.setItem(BACKUP_KEY, payload);
      localStorage.setItem('pokeshop-text-backup-v1', textBackup);
    }
  } catch (e) { console.error('Speichern fehlgeschlagen', e); }
}

async function load() {
  try {
    let raw = null, textBackup = null;
    if (window.storage && typeof window.storage.get === 'function') {
      const r = await window.storage.get(KEY, false);
      if (r && r.value) raw = r.value;
      else { const backup = await window.storage.get(BACKUP_KEY, false); if (backup && backup.value) raw = backup.value; }
      const txt = await window.storage.get('pokeshop-text-backup-v1', false);
      if (txt && txt.value) textBackup = txt.value;
    } else {
      raw = localStorage.getItem(KEY) || localStorage.getItem(BACKUP_KEY);
      textBackup = localStorage.getItem('pokeshop-text-backup-v1');
    }
    if (raw) state = JSON.parse(raw);
    else if (textBackup) {
      const lines = textBackup.split(/\r?\n/).filter(Boolean);
      const recoveredItems = [];
      for (let i = 2; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length >= 5) {
          const [name, category, qty, buyPrice, sellPrice] = parts;
          const extra = parts[5] ? JSON.parse(parts[5]) : null;
          recoveredItems.push({ id: uid(), name, category, qty: parseInt(qty, 10) || 0, buyPrice: parseFloat(buyPrice) || 0, sellPrice: parseFloat(sellPrice) || 0, filterTags: extra || {} });
        }
      }
      state.items = recoveredItems;
    }
  } catch (e) { console.warn('Keine gespeicherten Daten', e); }
  render();
}

function getFormFieldValue(form, name) {
  if (!form) return '';
  const field = form.elements && typeof form.elements.namedItem === 'function' ? form.elements.namedItem(name) : null;
  return field ? (field.value ?? '') : (form[name] ? form[name].value : '');
}

function getFilterTagsFromForm(form) {
  return {
    set: getFormFieldValue(form, 'set') || getFormFieldValue(form, 'pset') || '',
    type: getFormFieldValue(form, 'type') || getFormFieldValue(form, 'ptype') || '',
    rarity: getFormFieldValue(form, 'rarity') || getFormFieldValue(form, 'prarity') || '',
    subtype: getFormFieldValue(form, 'subtype') || getFormFieldValue(form, 'psubtype') || '',
  };
}

function getFilterTagSummary(itemOrEntry) {
  const tags = [];
  if (!itemOrEntry) return '';
  const set = itemOrEntry.set || (itemOrEntry.filterTags && itemOrEntry.filterTags.set) || '';
  const type = itemOrEntry.type || (itemOrEntry.filterTags && itemOrEntry.filterTags.type) || '';
  const rarity = itemOrEntry.rarity || (itemOrEntry.filterTags && itemOrEntry.filterTags.rarity) || '';
  const subtype = itemOrEntry.subtype || (itemOrEntry.filterTags && itemOrEntry.filterTags.subtype) || '';
  if (set) tags.push(`Set: ${set}`);
  if (type) tags.push(`Typ: ${type}`);
  if (rarity) tags.push(`Rarity: ${rarity}`);
  if (subtype) tags.push(`Subtype: ${subtype}`);
  return tags.join(' · ');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

function addToCart(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item || item.qty <= 0) return;
  const line = cart.find(c => c.itemId === itemId);
  if (line) { if (line.qty < item.qty) line.qty++; }
  else { cart.push({ itemId, qty: 1 }); }
  render();
}

function changeCartQty(itemId, delta) {
  const line = cart.find(c => c.itemId === itemId);
  const item = state.items.find(i => i.id === itemId);
  if (!line || !item) return;
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
  const saleItems = cart.map(c => {
    const item = state.items.find(i => i.id === c.itemId);
    return { itemId: c.itemId, name: item.name, qty: c.qty, price: item.sellPrice };
  });
  const total = cartTotal();
  state.sales.push({ id: uid(), date: todayStr(), items: saleItems, total });
  cart.forEach(c => {
    const item = state.items.find(i => i.id === c.itemId);
    if (item) item.qty = Math.max(0, item.qty - c.qty);
  });
  cart = [];
  await save();
  showToast('Verkauf gebucht: ' + eur(total));
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
    filterTags: getFilterTagsFromForm(form),
  });
  await save();
  form.reset();
  showToast('Artikel hinzugefügt');
  render();
}

async function deleteItem(id) {
  state.items = state.items.filter(i => i.id !== id);
  await save();
  render();
}

async function updateItemField(id, field, value) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (field === 'name' || field === 'category') item[field] = value;
  else if (field === 'qty') item.qty = Math.max(0, parseInt(value, 10) || 0);
  else item[field] = Math.max(0, parseFloat(value) || 0);
  await save();
}

async function addPurchase(form) {
  const name = form.pname.value.trim();
  if (!name) return;
  const qty = parseInt(form.pqty.value) || 1;
  const price = parseFloat(form.pprice.value) || 0;
  const tags = getFilterTagsFromForm(form);
  state.purchases.push({ id: uid(), date: todayStr(), name, qty, pricePaid: price, set: tags.set, type: tags.type, rarity: tags.rarity, subtype: tags.subtype });
  if (form.addToStock && form.addToStock.checked) {
    let existing = state.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.qty += qty;
      existing.buyPrice = price / qty || existing.buyPrice;
      existing.filterTags = {
        set: (existing.filterTags && existing.filterTags.set) || tags.set,
        type: (existing.filterTags && existing.filterTags.type) || tags.type,
        rarity: (existing.filterTags && existing.filterTags.rarity) || tags.rarity,
        subtype: (existing.filterTags && existing.filterTags.subtype) || tags.subtype,
      };
    } else {
      state.items.push({ id: uid(), name, category: form.pcategory.value, qty, buyPrice: price / qty || 0, sellPrice: 0, filterTags: tags });
    }
  }
  await save();
  form.reset();
  showToast('Ankauf erfasst');
  render();
}

async function sellItemFromLager(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item || item.qty <= 0) return;
  addToCart(itemId);
  view = 'kasse';
  render();
  setTimeout(() => {
    const searchInput = document.querySelector('[data-search-kasse]');
    if (searchInput) {
      searchInput.value = item.name;
      searchState.kasse = item.name;
      render();
    }
  }, 0);
  showToast('Artikel in den Verkauf gelegt');
}

function statTotals() {
  const revenue = state.sales.reduce((s, x) => s + x.total, 0);
  const spentAnkauf = state.purchases.reduce((s, x) => s + x.pricePaid, 0);
  const unitsSold = state.sales.reduce((s, x) => s + x.items.reduce((a, i) => a + i.qty, 0), 0);
  const lagerWert = state.items.reduce((s, x) => s + x.qty * x.sellPrice, 0);
  return { revenue, spentAnkauf, profit: revenue - spentAnkauf, unitsSold, lagerWert };
}

function salesByDay() {
  const map = {};
  state.sales.forEach(s => { map[s.date] = (map[s.date] || 0) + s.total; });
  return Object.keys(map).sort().slice(-7).map(d => ({ date: d, total: map[d] }));
}

function topSellers() {
  const map = {};
  state.sales.forEach(s => s.items.forEach(i => { map[i.name] = (map[i.name] || 0) + i.qty; }));
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

async function loadApiFilterOptions() {
  const endpoints = [
    { key: 'sets', url: 'https://api.pokemontcg.io/v2/sets' },
    { key: 'types', url: 'https://api.pokemontcg.io/v2/types' },
    { key: 'subtypes', url: 'https://api.pokemontcg.io/v2/subtypes' },
    { key: 'rarities', url: 'https://api.pokemontcg.io/v2/rarities' },
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const payload = await res.json();
      const items = Array.isArray(payload && payload.data) ? payload.data : [];
      apiFilterOptions[endpoint.key] = items.map(item => typeof item === 'string' ? item : item.name || item).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
    } catch (e) { console.warn('API-Filter fehlgeschlagen', endpoint.key, e); }
  }
  queueRender(80);
}

function showBootLoading() {
  const loader = document.getElementById('app-loading');
  if (loader) loader.classList.remove('hidden');
}
function hideBootLoading() {
  const loader = document.getElementById('app-loading');
  if (loader) loader.classList.add('hidden');
}

function buildPriceQuery(term) {
  const cleaned = String(term || '').trim();
  if (!cleaned) return 'name:*';
  const looksLikeApiQuery = /^(name:|set\.name:|types:|rarity:|subtypes:|supertypes:)|[():]/.test(cleaned) || /\b(and|or|not)\b/i.test(cleaned) || cleaned.includes(' AND ') || cleaned.includes(' OR ');
  if (looksLikeApiQuery) return cleaned;
  const words = cleaned.split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return `name:*${cleaned.toLowerCase()}*`;
  return words.map(w => `name:*${w.toLowerCase()}*`).join(' AND ');
}

function getCachedPriceResults(query) {
  const key = String(query || '').trim().toLowerCase();
  const entry = priceResponseCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

function cachePriceResults(query, data) {
  const key = String(query || '').trim().toLowerCase();
  priceResponseCache.set(key, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
  return data;
}

async function fetchPriceResults(query, options = {}) {
  const normalizedQuery = buildPriceQuery(query);
  const cached = getCachedPriceResults(normalizedQuery);
  if (cached) return cached;

  const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(normalizedQuery)}&pageSize=8&orderBy=-set.releaseDate`;
  let controller = options.signal || null;
  let timeoutId = null;

  if (!controller && typeof AbortController !== 'undefined') {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || PRICE_TIMEOUT_MS);
  }

  const fetchOptions = { headers: { 'Accept': 'application/json' } };
  if (controller) fetchOptions.signal = controller;

  try {
    const res = await fetch(url, fetchOptions);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json();
    const payload = parsed && parsed.data ? parsed.data : (Array.isArray(parsed) ? parsed : []);
    return cachePriceResults(normalizedQuery, payload);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    console.warn('Preis-URL fehlgeschlagen:', url, e.message);
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function searchPrice(query) {
  const q = (query || '').trim();
  const requestId = ++priceRequestSequence;
  if (priceRequestController) priceRequestController.abort();
  priceRequestController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  priceQuery = q;
  priceLoading = true;
  priceResults = null;
  priceErrorMessage = '';
  render();
  try {
    const data = await fetchPriceResults(q, { signal: priceRequestController ? priceRequestController.signal : null, timeoutMs: PRICE_TIMEOUT_MS });
    if (requestId !== priceRequestSequence) return;
    priceResults = Array.isArray(data) ? data : [];
  } catch (e) {
    if (requestId !== priceRequestSequence || (e && e.name === 'AbortError')) return;
    console.error('Preisabfrage fehlgeschlagen', e);
    priceResults = 'error';
    priceErrorMessage = 'Die Preisabfrage konnte gerade nicht geladen werden.';
  }
  if (requestId === priceRequestSequence) { priceLoading = false; render(); }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeText(value) { return String(value || '').toLowerCase().trim(); }
function parseMultiFilterValues(value) { return String(value || '').split(',').map(v => v.trim()).filter(Boolean); }
function getTagValue(item, key) {
  if (!item) return '';
  if (item.filterTags && typeof item.filterTags === 'object') return String(item.filterTags[key] || '');
  return '';
}

function catLabel(c) { return { sealed: 'Sealed', single: 'Einzelkarte', merch: 'Merch' }[c] || c; }

function filterItems(items, term, category, filterState = {}) {
  const needle = normalizeText(term);
  const categoryFilters = parseMultiFilterValues(category).map(v => v.toLowerCase());
  const set = normalizeText(filterState.set);
  const type = normalizeText(filterState.type);
  const rarity = normalizeText(filterState.rarity);
  const subtype = normalizeText(filterState.subtype);
  return items.filter(item => {
    const matchesCategory = categoryFilters.length === 0 || categoryFilters.includes((item.category || '').toLowerCase()) || categoryFilters.includes(catLabel(item.category).toLowerCase());
    const haystack = `${item.name} ${item.category || ''} ${catLabel(item.category)}`.toLowerCase();
    const matchesTerm = needle === '' || haystack.includes(needle);
    const matchesSet = set === '' || normalizeText(getTagValue(item, 'set')).includes(set);
    const matchesType = type === '' || normalizeText(getTagValue(item, 'type')).includes(type);
    const matchesRarity = rarity === '' || normalizeText(getTagValue(item, 'rarity')).includes(rarity);
    const matchesSubtype = subtype === '' || normalizeText(getTagValue(item, 'subtype')).includes(subtype);
    return matchesCategory && matchesTerm && matchesSet && matchesType && matchesRarity && matchesSubtype;
  });
}

function filterPurchases(items, term, filterState = {}) {
  const needle = normalizeText(term);
  const set = normalizeText(filterState.set);
  const type = normalizeText(filterState.type);
  const rarity = normalizeText(filterState.rarity);
  const subtype = normalizeText(filterState.subtype);
  return items.filter(item => {
    const haystack = `${item.name} ${item.date} ${item.qty}`.toLowerCase();
    const matchesTerm = needle === '' || haystack.includes(needle);
    const matchesSet = set === '' || normalizeText(item.set || '').includes(set);
    const matchesType = type === '' || normalizeText(item.type || '').includes(type);
    const matchesRarity = rarity === '' || normalizeText(item.rarity || '').includes(rarity);
    const matchesSubtype = subtype === '' || normalizeText(item.subtype || '').includes(subtype);
    return matchesTerm && matchesSet && matchesType && matchesRarity && matchesSubtype;
  });
}

function buildMultiValueClause(field, raw) {
  const values = parseMultiFilterValues(raw).map(v => v.toLowerCase());
  if (values.length === 0) return '';
  if (values.length === 1) return `${field}:*${values[0]}*`;
  return `(${values.map(v => `${field}:*${v}*`).join(' OR ')})`;
}

function getPriceFilterQuery() {
  const clauses = [];
  const name = searchState.preiseName.trim();
  if (name) clauses.push(buildPriceQuery(name));
  const setClause = buildMultiValueClause('set.name', searchState.preiseSet.trim());
  if (setClause) clauses.push(setClause);
  const typeClause = buildMultiValueClause('types', searchState.preiseType.trim());
  if (typeClause) clauses.push(typeClause);
  const rarityClause = buildMultiValueClause('rarity', searchState.preiseRarity.trim());
  if (rarityClause) clauses.push(rarityClause);
  const subtypeClause = buildMultiValueClause('subtypes', searchState.preiseSubtype.trim());
  if (subtypeClause) clauses.push(subtypeClause);
  return clauses.join(' AND ');
}

function schedulePriceSearch() {
  clearTimeout(priceSearchTimer);
  const query = getPriceFilterQuery();
  if (!query) { priceResults = []; priceLoading = false; priceErrorMessage = ''; queueRender(80); return; }
  priceSearchTimer = setTimeout(() => { searchPrice(query); }, 250);
}

function queueRender(delay = 140) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), delay);
}

function schedulePriceSuggestions() {
  clearTimeout(priceSuggestionTimer);
  const term = searchState.preiseName.trim();
  if (term.length < 2) { priceSuggestions = []; priceSuggestionsLoading = false; queueRender(80); return; }
  priceSuggestionTimer = setTimeout(() => { searchPriceSuggestions(term); }, 220);
}

async function searchPriceSuggestions(term) {
  const q = (term || '').trim();
  if (q.length < 2) { priceSuggestions = []; priceSuggestionsLoading = false; queueRender(80); return; }
  const requestId = ++priceSuggestionSequence;
  if (priceSuggestionController) priceSuggestionController.abort();
  priceSuggestionController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  priceSuggestionsLoading = true;
  queueRender(60);
  try {
    const data = await fetchPriceResults(q, { signal: priceSuggestionController ? priceSuggestionController.signal : null, timeoutMs: PRICE_SUGGESTION_TIMEOUT_MS });
    if (requestId !== priceSuggestionSequence) return;
    const payload = Array.isArray(data) ? data : [];
    priceSuggestions = payload.slice(0, 6).map(c => ({ name: c.name, set: c.set && c.set.name ? c.set.name : '', image: c.images && c.images.small ? c.images.small : '' }));
  } catch (e) {
    if (requestId !== priceSuggestionSequence || (e && e.name === 'AbortError')) return;
    priceSuggestions = [];
    console.warn('Vorschläge fehlgeschlagen', e);
  }
  if (requestId === priceSuggestionSequence) { priceSuggestionsLoading = false; queueRender(60); }
}

function selectPriceSuggestion(name) {
  searchState.preiseName = name;
  priceSuggestions = [];
  searchPrice(getPriceFilterQuery());
}

function getFocusRestoreState(activeElement) {
  if (!activeElement) return null;
  const tag = activeElement.tagName && activeElement.tagName.toLowerCase();
  if (!['input', 'textarea', 'select'].includes(tag)) return null;
  const isTextLike = tag === 'input' ? !['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes((activeElement.type || '').toLowerCase()) : true;
  if (!isTextLike) return null;
  const ds = activeElement.dataset;
  let selector = null;
  if (ds.searchKasse !== undefined) selector = '[data-search-kasse]';
  else if (ds.searchLager !== undefined) selector = '[data-search-lager]';
  else if (ds.searchAnkauf !== undefined) selector = '[data-search-ankauf]';
  else if (ds.searchKasseCat !== undefined) selector = '[data-search-kasse-cat]';
  else if (ds.searchLagerCat !== undefined) selector = '[data-search-lager-cat]';
  else if (ds.kasseFilter) selector = `[data-kasse-filter="${ds.kasseFilter}"]`;
  else if (ds.lagerFilter) selector = `[data-lager-filter="${ds.lagerFilter}"]`;
  else if (ds.ankaufFilter) selector = `[data-ankauf-filter="${ds.ankaufFilter}"]`;
  else if (ds.priceFilter) selector = `[data-price-filter="${ds.priceFilter}"]`;
  else if (activeElement.getAttribute('name') === 'q') selector = '#priceForm input[name="q"]';
  if (!selector) return null;
  return {
    selector,
    value: activeElement.value,
    selectionStart: activeElement.selectionStart ?? activeElement.value.length,
    selectionEnd: activeElement.selectionEnd ?? activeElement.value.length,
    selectionDirection: activeElement.selectionDirection || 'none',
  };
}

function render() {
  const focusRestore = getFocusRestoreState(document.activeElement);
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="header">
      <div class="brand">
        <div class="ball"></div>
        <div>
          <h1>Kartenladen Manager</h1>
          <div class="sub">Kasse · Lager · Ankauf · Statistik · Preise</div>
        </div>
      </div>
    </div>
    <div class="tabs">
      ${['kasse', 'lager', 'ankauf', 'statistik', 'preise'].map(v => `<div class="tab ${view === v ? 'active' : ''}" data-view="${v}">${labelFor(v)}</div>`).join('')}
    </div>
    <div id="content"></div>`;
  app.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { view = t.dataset.view; render(); }));
  const content = document.getElementById('content');
  if (view === 'kasse') content.innerHTML = renderKasse();
  else if (view === 'lager') content.innerHTML = renderLager();
  else if (view === 'ankauf') content.innerHTML = renderAnkauf();
  else if (view === 'statistik') content.innerHTML = renderStatistik();
  else if (view === 'preise') content.innerHTML = renderPreise();
  attachHandlers();
  if (focusRestore) {
    requestAnimationFrame(() => {
      const target = document.querySelector(focusRestore.selector);
      if (target) {
        target.focus();
        if (typeof target.setSelectionRange === 'function') {
          const start = Math.min(Math.max(focusRestore.selectionStart, 0), target.value.length);
          const end = Math.min(Math.max(focusRestore.selectionEnd, start), target.value.length);
          target.setSelectionRange(start, end, focusRestore.selectionDirection || 'none');
        }
      }
    });
  }
}

function labelFor(v) {
  return { kasse: '🛒 Kasse', lager: '📦 Lager', ankauf: '💰 Ankauf', statistik: '📊 Statistik', preise: '🃏 Preise' }[v];
}

function renderKasse() {
  const available = state.items.filter(i => i.qty > 0);
  const filtered = filterItems(available, searchState.kasse, searchState.kasseCategory, {
    set: searchState.kasseSet, type: searchState.kasseType, rarity: searchState.kasseRarity, subtype: searchState.kasseSubtype,
  });
  return `
  <div class="row" style="align-items:stretch;">
    <div class="card" style="flex:1.3;min-width:280px;">
      <h2>Artikel wählen</h2>
      <div class="row" style="margin-bottom:10px;">
        <div class="field"><label>Suche</label><input class="search-input" data-search-kasse value="${esc(searchState.kasse)}" placeholder="Name, Kategorie oder Teilbegriff"></div>
        <div class="field" style="max-width:140px;"><label>Kategorie</label>
          <select class="search-input" data-search-kasse-cat multiple size="3">
            <option value="sealed" ${parseMultiFilterValues(searchState.kasseCategory).includes('sealed') ? 'selected' : ''}>Sealed</option>
            <option value="single" ${parseMultiFilterValues(searchState.kasseCategory).includes('single') ? 'selected' : ''}>Einzelkarte</option>
            <option value="merch" ${parseMultiFilterValues(searchState.kasseCategory).includes('merch') ? 'selected' : ''}>Merch</option>
          </select>
        </div>
      </div>
      <div class="row" style="margin-bottom:10px;">
        <div class="field"><label>Set</label><select class="search-input" data-kasse-filter="set"><option value="">Alle Sets</option>${apiFilterOptions.sets.map(opt => `<option value="${esc(opt)}" ${searchState.kasseSet === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Typ</label><select class="search-input" data-kasse-filter="type"><option value="">Alle Typen</option>${apiFilterOptions.types.map(opt => `<option value="${esc(opt)}" ${searchState.kasseType === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Rarity</label><select class="search-input" data-kasse-filter="rarity"><option value="">Alle Rarities</option>${apiFilterOptions.rarities.map(opt => `<option value="${esc(opt)}" ${searchState.kasseRarity === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Subtype</label><select class="search-input" data-kasse-filter="subtype"><option value="">Alle Subtypes</option>${apiFilterOptions.subtypes.map(opt => `<option value="${esc(opt)}" ${searchState.kasseSubtype === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
      </div>
      ${filtered.length === 0 ? '<div class="empty">Kein passender Lagerbestand gefunden.</div>' :
      `<table><thead><tr><th>Artikel</th><th>Kat.</th><th>Bestand</th><th>Preis</th><th></th></tr></thead><tbody>
      ${filtered.map(i => `
        <tr>
          <td><div>${esc(i.name)}</div>${(() => { const meta = getFilterTagSummary(i); return meta ? `<div class="muted" style="font-size:11px;margin-top:2px;">${esc(meta)}</div>` : ''; })()}</td>
          <td><span class="tag tag-cat">${catLabel(i.category)}</span></td>
          <td>${i.qty}</td>
          <td><span class="tag tag-price">${eur(i.sellPrice)}</span></td>
          <td><button data-add="${i.id}">+ Hinzufügen</button></td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>
    <div class="card" style="flex:1;min-width:260px;">
      <h2>Warenkorb</h2>
      ${cart.length === 0 ? '<div class="empty">Warenkorb leer</div>' :
      cart.map(c => {
        const item = state.items.find(i => i.id === c.itemId);
        return `<div class="cart-line">
          <div><div>${esc(item.name)}</div><div class="muted" style="font-size:11.5px;">${eur(item.sellPrice)} × ${c.qty}</div></div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="icon-btn" data-dec="${c.itemId}">−</button>
            <span>${c.qty}</span>
            <button class="icon-btn" data-inc="${c.itemId}">+</button>
          </div>
        </div>`;
      }).join('')}
      <div class="total-box"><span>Gesamt</span><span class="amt">${eur(cartTotal())}</span></div>
      <button class="btn-gold" style="width:100%;margin-top:12px;" id="checkoutBtn" ${cart.length === 0 ? 'disabled' : ''}>Verkauf abschließen</button>
    </div>
  </div>`;
}

function renderLager() {
  const filtered = filterItems(state.items, searchState.lager, searchState.lagerCategory, {
    set: searchState.lagerSet, type: searchState.lagerType, rarity: searchState.lagerRarity, subtype: searchState.lagerSubtype,
  });
  return `
  <div class="card">
    <h2>Neuen Artikel anlegen</h2>
    <form id="addItemForm">
      <div class="row">
        <div class="field"><label>Name</label><input name="name" placeholder="z.B. Charizard ex 199/197" required></div>
        <div class="field" style="max-width:160px;"><label>Kategorie</label>
          <select name="category"><option value="sealed">Sealed</option><option value="single">Einzelkarte</option><option value="merch">Merch</option></select>
        </div>
        <div class="field" style="max-width:100px;"><label>Menge</label><input name="qty" type="number" min="0" value="1"></div>
        <div class="field" style="max-width:120px;"><label>Einkaufspreis</label><input name="buyPrice" type="number" step="0.01" min="0" value="0"></div>
        <div class="field" style="max-width:120px;"><label>Verkaufspreis</label><input name="sellPrice" type="number" step="0.01" min="0" value="0"></div>
        <button type="submit" class="btn-gold">Hinzufügen</button>
      </div>
      <div class="row" style="margin-top:10px;">
        <div class="field"><label>Set</label><select name="set"><option value="">—</option>${apiFilterOptions.sets.map(opt => `<option value="${esc(opt)}">${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Typ</label><select name="type"><option value="">—</option>${apiFilterOptions.types.map(opt => `<option value="${esc(opt)}">${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Rarity</label><select name="rarity"><option value="">—</option>${apiFilterOptions.rarities.map(opt => `<option value="${esc(opt)}">${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Subtype</label><select name="subtype"><option value="">—</option>${apiFilterOptions.subtypes.map(opt => `<option value="${esc(opt)}">${esc(opt)}</option>`).join('')}</select></div>
      </div>
    </form>
  </div>
  <div class="card">
    <h2>Backup & Lagerbestand</h2>
    <div class="row" style="margin-bottom:12px;">
      <button type="button" id="exportBackupBtn" class="btn-gold">Backup exportieren</button>
      <button type="button" id="importBackupBtn" class="btn-red">Backup importieren</button>
      <input type="file" id="backupImportInput" accept=".txt,text/plain" style="display:none;">
    </div>
    <div class="sub">Der Bestand wird automatisch im Browser gespeichert.</div>
  </div>
  <div class="card">
    <h2>Lagerbestand (${filtered.length}/${state.items.length})</h2>
    <div class="row" style="margin-bottom:10px;">
      <div class="field"><label>Suche</label><input class="search-input" data-search-lager value="${esc(searchState.lager)}" placeholder="Name oder Teilbegriff"></div>
      <div class="field" style="max-width:140px;"><label>Kategorie</label>
        <select class="search-input" data-search-lager-cat multiple size="3">
          <option value="sealed" ${parseMultiFilterValues(searchState.lagerCategory).includes('sealed') ? 'selected' : ''}>Sealed</option>
          <option value="single" ${parseMultiFilterValues(searchState.lagerCategory).includes('single') ? 'selected' : ''}>Einzelkarte</option>
          <option value="merch" ${parseMultiFilterValues(searchState.lagerCategory).includes('merch') ? 'selected' : ''}>Merch</option>
        </select>
      </div>
    </div>
    <div class="row" style="margin-bottom:10px;">
      <div class="field"><label>Set</label><select class="search-input" data-lager-filter="set"><option value="">Alle Sets</option>${apiFilterOptions.sets.map(opt => `<option value="${esc(opt)}" ${searchState.lagerSet === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
      <div class="field"><label>Typ</label><select class="search-input" data-lager-filter="type"><option value="">Alle Typen</option>${apiFilterOptions.types.map(opt => `<option value="${esc(opt)}" ${searchState.lagerType === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
      <div class="field"><label>Rarity</label><select class="search-input" data-lager-filter="rarity"><option value="">Alle Rarities</option>${apiFilterOptions.rarities.map(opt => `<option value="${esc(opt)}" ${searchState.lagerRarity === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
      <div class="field"><label>Subtype</label><select class="search-input" data-lager-filter="subtype"><option value="">Alle Subtypes</option>${apiFilterOptions.subtypes.map(opt => `<option value="${esc(opt)}" ${searchState.lagerSubtype === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
    </div>
    ${filtered.length === 0 ? '<div class="empty">Keine passenden Artikel gefunden.</div>' :
    `<table><thead><tr><th>Name</th><th>Kat.</th><th>Menge</th><th>EK</th><th>VK</th><th></th></tr></thead><tbody>
    ${filtered.map(i => `
      <tr>
        <td>
          <input data-edit="${i.id}" data-field="name" value="${esc(i.name)}" style="min-width:160px;">
          ${(() => { const meta = getFilterTagSummary(i); return meta ? `<div class="muted" style="font-size:11px;margin-top:4px;">${esc(meta)}</div>` : ''; })()}
        </td>
        <td><select data-edit="${i.id}" data-field="category">
          <option value="sealed" ${i.category === 'sealed' ? 'selected' : ''}>Sealed</option>
          <option value="single" ${i.category === 'single' ? 'selected' : ''}>Einzelkarte</option>
          <option value="merch" ${i.category === 'merch' ? 'selected' : ''}>Merch</option>
        </select></td>
        <td style="max-width:70px;"><input data-edit="${i.id}" data-field="qty" type="number" value="${i.qty}" ${i.qty <= 2 ? 'style="color:#e88;"' : ''}></td>
        <td style="max-width:90px;"><input data-edit="${i.id}" data-field="buyPrice" type="number" step="0.01" value="${i.buyPrice}"></td>
        <td style="max-width:90px;"><input data-edit="${i.id}" data-field="sellPrice" type="number" step="0.01" value="${i.sellPrice}"></td>
        <td>${i.qty <= 2 ? '<span class="tag tag-low">niedrig</span>' : ''}<button class="icon-btn" data-del="${i.id}">✕</button><button class="btn-gold" data-sell="${i.id}" style="padding:6px 10px;margin-left:4px;">Verkaufen</button></td>
      </tr>`).join('')}
    </tbody></table>`}
  </div>`;
}

function renderAnkauf() {
  const prefilledName = selectedCardForImport && selectedCardForImport.name ? selectedCardForImport.name : '';
  const prefilledPrice = selectedCardForImport && selectedCardForImport.price ? selectedCardForImport.price : '';
  const prefilledMeta = selectedCardForImport || {};
  const filteredPurchases = filterPurchases(state.purchases, searchState.ankauf, {
    set: searchState.ankaufSet, type: searchState.ankaufType, rarity: searchState.ankaufRarity, subtype: searchState.ankaufSubtype,
  });
  return `
  <div class="card">
    <h2>Ankauf erfassen</h2>
    <form id="addPurchaseForm">
      <div class="row">
        <div class="field"><label>Artikelname</label><input name="pname" value="${esc(prefilledName)}" required></div>
        <div class="field" style="max-width:160px;"><label>Kategorie</label>
          <select name="pcategory"><option value="single">Einzelkarte</option><option value="sealed">Sealed</option><option value="merch">Merch</option></select>
        </div>
        <div class="field" style="max-width:100px;"><label>Menge</label><input name="pqty" type="number" min="1" value="1"></div>
        <div class="field" style="max-width:130px;"><label>Gezahlter Preis</label><input name="pprice" type="number" step="0.01" min="0" value="${esc(prefilledPrice)}"></div>
        <div class="field" style="max-width:160px;display:flex;align-items:center;gap:6px;padding-bottom:8px;">
          <input type="checkbox" name="addToStock" id="addToStock" checked style="width:auto;">
          <label for="addToStock" style="margin:0;text-transform:none;font-size:12.5px;">Ins Lager übernehmen</label>
        </div>
        <button type="submit" class="btn-gold">Ankauf speichern</button>
      </div>
      <div class="row" style="margin-top:10px;">
        <div class="field"><label>Set</label><select name="pset"><option value="">—</option>${apiFilterOptions.sets.map(opt => `<option value="${esc(opt)}" ${prefilledMeta.set === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Typ</label><select name="ptype"><option value="">—</option>${apiFilterOptions.types.map(opt => `<option value="${esc(opt)}" ${prefilledMeta.type === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Rarity</label><select name="prarity"><option value="">—</option>${apiFilterOptions.rarities.map(opt => `<option value="${esc(opt)}" ${prefilledMeta.rarity === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
        <div class="field"><label>Subtype</label><select name="psubtype"><option value="">—</option>${apiFilterOptions.subtypes.map(opt => `<option value="${esc(opt)}" ${prefilledMeta.subtype === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>
      </div>
    </form>
  </div>
  <div class="card">
    <h2>Ankauf-Historie</h2>
    <div class="row" style="margin-bottom:10px;">
      <div class="field"><label>Suche</label><input class="search-input" data-search-ankauf value="${esc(searchState.ankauf)}" placeholder="Name, Datum oder Menge"></div>
    </div>
    ${filteredPurchases.length === 0 ? '<div class="empty">Keine Ankäufe gefunden.</div>' :
    `<table><thead><tr><th>Datum</th><th>Artikel</th><th>Menge</th><th>Gezahlt</th></tr></thead><tbody>
    ${filteredPurchases.slice().reverse().map(p => `
      <tr>
        <td>${p.date}</td>
        <td><div>${esc(p.name)}</div>${(() => { const meta = getFilterTagSummary(p); return meta ? `<div class="muted" style="font-size:11px;margin-top:2px;">${esc(meta)}</div>` : ''; })()}</td>
        <td>${p.qty}</td>
        <td><span class="tag tag-price">${eur(p.pricePaid)}</span></td>
      </tr>`).join('')}
    </tbody></table>`}
  </div>`;
}

function renderStatistik() {
  const t = statTotals();
  const days = salesByDay();
  const maxVal = Math.max(1, ...days.map(d => d.total));
  const sellers = topSellers();
  return `
  <div class="stat-grid">
    <div class="stat"><div class="lbl">Umsatz</div><div class="val gold">${eur(t.revenue)}</div></div>
    <div class="stat"><div class="lbl">Ausgaben</div><div class="val red">${eur(t.spentAnkauf)}</div></div>
    <div class="stat"><div class="lbl">Gewinn</div><div class="val ${t.profit >= 0 ? 'green' : 'red'}">${eur(t.profit)}</div></div>
    <div class="stat"><div class="lbl">Verkaufte Stück</div><div class="val">${t.unitsSold}</div></div>
    <div class="stat"><div class="lbl">Lagerwert</div><div class="val">${eur(t.lagerWert)}</div></div>
  </div>
  <div class="card">
    <h2>Umsatz letzte Tage</h2>
    ${days.length === 0 ? '<div class="empty">Noch keine Verkäufe.</div>' :
    `<div class="bars">${days.map(d => `
      <div class="bar-wrap">
        <div class="bar" style="height:${Math.max(4, (d.total / maxVal) * 100)}px;"></div>
        <div class="bar-lbl">${d.date.slice(5)}</div>
      </div>`).join('')}</div>`}
  </div>
  <div class="card">
    <h2>Meistverkauft</h2>
    ${sellers.length === 0 ? '<div class="empty">Noch keine Verkäufe.</div>' :
    `<table><thead><tr><th>Artikel</th><th>Verkauft</th></tr></thead><tbody>
    ${sellers.map(([name, qty]) => `<tr><td>${esc(name)}</td><td>${qty}×</td></tr>`).join('')}
    </tbody></table>`}
  </div>`;
}

function addCardToStock(card) {
  const name = card.name || 'Unbekannte Karte';
  const existing = state.items.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.qty += 1;
    existing.sellPrice = existing.sellPrice || 0;
    existing.filterTags = {
      set: (existing.filterTags && existing.filterTags.set) || (card.set || ''),
      type: (existing.filterTags && existing.filterTags.type) || (card.type || ''),
      rarity: (existing.filterTags && existing.filterTags.rarity) || (card.rarity || ''),
      subtype: (existing.filterTags && existing.filterTags.subtype) || (card.subtype || ''),
    };
  } else {
    state.items.push({ id: uid(), name, category: 'single', qty: 1, buyPrice: 0, sellPrice: 0, filterTags: { set: card.set || '', type: card.type || '', rarity: card.rarity || '', subtype: card.subtype || '' } });
  }
  save().then(() => { render(); showToast('Karte ins Lager übernommen'); });
}

function addCardToPurchase(card) {
  const name = card.name || 'Unbekannte Karte';
  selectedCardForImport = { name, price: null, set: card.set || '', type: card.type || '', rarity: card.rarity || '', subtype: card.subtype || '' };
  view = 'ankauf';
  render();
  setTimeout(() => {
    const form = document.getElementById('addPurchaseForm');
    if (form) {
      const pname = form.querySelector('input[name="pname"]');
      if (pname) { pname.value = name; pname.focus(); }
    }
  }, 0);
  showToast('Name in Ankauf übernommen');
}

function renderFilterSelect(name, value, options, placeholder = 'Wähle…', filterKey = null) {
  const selected = String(value || '').trim();
  const key = filterKey || name.toLowerCase();
  return `<div class="field"><label>${esc(name)}</label><select class="search-input" data-price-filter="${esc(key)}"><option value="">${esc(placeholder)}</option>${options.map(opt => `<option value="${esc(opt)}" ${selected === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
}

function renderPreise() {
  let resultsHtml = '';
  if (priceLoading) resultsHtml = '<div class="empty">Suche läuft…</div>';
  else if (priceResults === 'error') resultsHtml = `<div class="empty">${esc(priceErrorMessage)}</div>`;
  else if (Array.isArray(priceResults)) {
    if (priceResults.length === 0) resultsHtml = `<div class="empty">Keine Treffer für "${esc(priceQuery)}".</div>`;
    else resultsHtml = priceResults.map(c => {
      const cm = c.cardmarket && c.cardmarket.prices;
      const tp = c.tcgplayer && c.tcgplayer.prices;
      let tpMarket = null;
      if (tp) {
        const variant = tp.holofoil || tp.normal || tp.reverseHolofoil || Object.values(tp)[0];
        tpMarket = variant && variant.market;
      }
      const cardMeta = {
        set: c.set && c.set.name ? c.set.name : '',
        type: Array.isArray(c.types) && c.types.length ? c.types[0] : '',
        rarity: c.rarity || '',
        subtype: Array.isArray(c.subtypes) && c.subtypes.length ? c.subtypes[0] : ''
      };
      const cmUrl = `https://www.cardmarket.com/de/Pokemon/Products/Singles/Search?searchString=${encodeURIComponent(c.name + (c.set && c.set.name ? ' ' + c.set.name : ''))}`;
      return `<div class="price-result" data-set="${esc(cardMeta.set)}" data-type="${esc(cardMeta.type)}" data-rarity="${esc(cardMeta.rarity)}" data-subtype="${esc(cardMeta.subtype)}">
        ${c.images && c.images.small ? `<img src="${c.images.small}" alt="${esc(c.name)}">` : ''}
        <div style="flex:1;">
          <div class="name">${esc(c.name)}</div>
          <div class="set">${esc(c.set ? c.set.name : '')} ${c.number ? ('· #' + esc(c.number)) : ''}</div>
          <div class="price-badges">
            ${cm && cm.averageSellPrice ? `<span class="tag tag-price">CM Ø ${eur(cm.averageSellPrice)}</span>` : ''}
            ${cm && cm.trendPrice ? `<span class="tag tag-price">Trend ${eur(cm.trendPrice)}</span>` : ''}
            ${tpMarket ? `<span class="tag tag-cat">TCG $${tpMarket.toFixed(2)}</span>` : ''}
          </div>
          <div class="row" style="margin-top:8px;">
            <button type="button" class="btn-gold" data-import-stock="${esc(c.name)}">➕ Lager</button>
            <button type="button" class="btn-red" data-import-purchase="${esc(c.name)}">💰 Ankauf</button>
            <a href="${cmUrl}" target="_blank" rel="noopener" class="btn-cm" style="padding:9px 14px;border-radius:7px;text-decoration:none;">🔗 Cardmarket</a>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  
  const suggestionsHtml = priceSuggestions.length === 0 && !priceSuggestionsLoading ? '' :
    `<div class="price-suggestions">
      ${priceSuggestionsLoading ? '<div class="suggestion-row muted">Lädt…</div>' : ''}
      ${priceSuggestions.map(s => `<button type="button" class="suggestion-row" data-price-suggestion="${esc(s.name)}"><div>${esc(s.name)}</div><div class="suggestion-meta">${esc(s.set || '')}</div></button>`).join('')}
    </div>`;
    
  return `
  <div class="card">
    <h2>Karten suchen</h2>
    <form id="priceForm" class="row">
      <div class="field" style="position:relative;">
        <label>Kartenname</label>
        <input name="q" value="${esc(searchState.preiseName)}" placeholder="z.B. Charizard VMAX Evolving Skies" required>
        ${suggestionsHtml}
      </div>
      <button type="submit" class="btn-gold">Suchen</button>
    </form>
    <div class="row" style="margin-top:10px;">
      ${renderFilterSelect('Set', searchState.preiseSet, apiFilterOptions.sets, 'Alle Sets', 'set')}
      ${renderFilterSelect('Typ', searchState.preiseType, apiFilterOptions.types, 'Alle Typen', 'type')}
      ${renderFilterSelect('Rarity', searchState.preiseRarity, apiFilterOptions.rarities, 'Alle Rarities', 'rarity')}
      ${renderFilterSelect('Subtype', searchState.preiseSubtype, apiFilterOptions.subtypes, 'Alle Subtypes', 'subtype')}
    </div>
  </div>
  <div class="card"><h2>Ergebnisse</h2>${resultsHtml || '<div class="empty">Noch keine Suche gestartet.</div>'}</div>`;
}

async function exportBackup() {
  const content = buildTextBackup();
  const filename = `pokeshop-backup-${new Date().toISOString().slice(0, 10)}.txt`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
  showToast('Backup heruntergeladen');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 3 || !lines[0].includes('Pokeshop Backup')) throw new Error('Ungültig');
    const importedItems = [];
    for (let i = 2; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length >= 5) {
        const [name, category, qty, buyPrice, sellPrice] = parts;
        const extra = parts[5] ? JSON.parse(parts[5]) : null;
        importedItems.push({ id: uid(), name, category, qty: parseInt(qty, 10) || 0, buyPrice: parseFloat(buyPrice) || 0, sellPrice: parseFloat(sellPrice) || 0, filterTags: extra || {} });
      }
    }
    state.items = importedItems;
    await save();
    render();
    showToast('Backup importiert');
  } catch (e) {
    showToast('Backup konnte nicht gelesen werden');
  }
}

function attachHandlers() {
  const addForm = document.getElementById('addItemForm');
  if (addForm) addForm.addEventListener('submit', e => { e.preventDefault(); addItem(e.target); });
  const purForm = document.getElementById('addPurchaseForm');
  if (purForm) purForm.addEventListener('submit', e => { e.preventDefault(); addPurchase(e.target); });
  const priceForm = document.getElementById('priceForm');
  if (priceForm) priceForm.addEventListener('submit', e => {
    e.preventDefault();
    searchState.preiseName = e.target.q.value.trim();
    searchPrice(getPriceFilterQuery());
  });
  const exportBtn = document.getElementById('exportBackupBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportBackup);
  const importBtn = document.getElementById('importBackupBtn');
  const importInput = document.getElementById('backupImportInput');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) {
        importBackup(e.target.files[0]);
        e.target.value = '';
      }
    });
  }
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addToCart(b.dataset.add)));
  document.querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => changeCartQty(b.dataset.inc, 1)));
  document.querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => changeCartQty(b.dataset.dec, -1)));
  document.querySelectorAll('[data-import-stock]').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.price-result');
    const dataset = card ? card.dataset : {};
    addCardToStock({ name: b.dataset.importStock, set: dataset.set || '', type: dataset.type || '', rarity: dataset.rarity || '', subtype: dataset.subtype || '' });
  }));
  document.querySelectorAll('[data-import-purchase]').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.price-result');
    const dataset = card ? card.dataset : {};
    addCardToPurchase({ name: b.dataset.importPurchase, set: dataset.set || '', type: dataset.type || '', rarity: dataset.rarity || '', subtype: dataset.subtype || '' });
  }));
  const checkoutBtn = document.getElementById('checkoutBtn');
  if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);
  document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteItem(b.dataset.del)));
  document.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('change', () => updateItemField(el.dataset.edit, el.dataset.field, el.value)));
  document.querySelectorAll('[data-sell]').forEach(b => b.addEventListener('click', () => sellItemFromLager(b.dataset.sell)));

  const searchKasse = document.querySelector('[data-search-kasse]');
  if (searchKasse) searchKasse.addEventListener('input', e => { searchState.kasse = e.target.value; queueRender(80); });
  const searchKasseCat = document.querySelector('[data-search-kasse-cat]');
  if (searchKasseCat) searchKasseCat.addEventListener('change', e => { searchState.kasseCategory = Array.from(e.target.selectedOptions).map(o => o.value).join(','); queueRender(80); });
  const searchLager = document.querySelector('[data-search-lager]');
  if (searchLager) searchLager.addEventListener('input', e => { searchState.lager = e.target.value; queueRender(80); });
  const searchLagerCat = document.querySelector('[data-search-lager-cat]');
  if (searchLagerCat) searchLagerCat.addEventListener('change', e => { searchState.lagerCategory = Array.from(e.target.selectedOptions).map(o => o.value).join(','); queueRender(80); });
  const searchAnkauf = document.querySelector('[data-search-ankauf]');
  if (searchAnkauf) searchAnkauf.addEventListener('input', e => { searchState.ankauf = e.target.value; queueRender(80); });

  document.querySelectorAll('[data-price-filter]').forEach(el => {
    el.addEventListener('change', e => {
      const key = e.target.dataset.priceFilter;
      if (key === 'set') searchState.preiseSet = e.target.value;
      if (key === 'type') searchState.preiseType = e.target.value;
      if (key === 'rarity') searchState.preiseRarity = e.target.value;
      if (key === 'subtype') searchState.preiseSubtype = e.target.value;
      schedulePriceSearch();
    });
  });
  document.querySelectorAll('[data-kasse-filter]').forEach(el => {
    el.addEventListener('change', e => {
      const key = e.target.dataset.kasseFilter;
      if (key === 'set') searchState.kasseSet = e.target.value;
      if (key === 'type') searchState.kasseType = e.target.value;
      if (key === 'rarity') searchState.kasseRarity = e.target.value;
      if (key === 'subtype') searchState.kasseSubtype = e.target.value;
      queueRender(80);
    });
  });
  document.querySelectorAll('[data-lager-filter]').forEach(el => {
    el.addEventListener('change', e => {
      const key = e.target.dataset.lagerFilter;
      if (key === 'set') searchState.lagerSet = e.target.value;
      if (key === 'type') searchState.lagerType = e.target.value;
      if (key === 'rarity') searchState.lagerRarity = e.target.value;
      if (key === 'subtype') searchState.lagerSubtype = e.target.value;
      queueRender(80);
    });
  });
  document.querySelectorAll('[data-ankauf-filter]').forEach(el => {
    el.addEventListener('change', e => {
      const key = e.target.dataset.ankaufFilter;
      if (key === 'set') searchState.ankaufSet = e.target.value;
      if (key === 'type') searchState.ankaufType = e.target.value;
      if (key === 'rarity') searchState.ankaufRarity = e.target.value;
      if (key === 'subtype') searchState.ankaufSubtype = e.target.value;
      queueRender(80);
    });
  });

  const priceNameInput = document.querySelector('#priceForm input[name="q"]');
  if (priceNameInput) {
    priceNameInput.addEventListener('input', e => {
      searchState.preiseName = e.target.value;
      schedulePriceSearch();
      schedulePriceSuggestions();
    });
  }
  document.querySelectorAll('[data-price-suggestion]').forEach(btn => btn.addEventListener('click', () => selectPriceSuggestion(btn.dataset.priceSuggestion)));
}

document.addEventListener('DOMContentLoaded', async () => {
  showBootLoading();
  const urlParams = new URLSearchParams(window.location.search);
  const importDataParam = urlParams.get('importData');
  if (importDataParam) {
    try {
      const importedCard = JSON.parse(decodeURIComponent(importDataParam));
      selectedCardForImport = importedCard;
      view = 'ankauf';
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) { console.error('Import-Fehler:', e); }
  }
  try {
    await load();
    hideBootLoading();
    loadApiFilterOptions().catch(() => {});
  } catch (e) {
    console.error('Initialisierung fehlgeschlagen', e);
    hideBootLoading();
  }
});