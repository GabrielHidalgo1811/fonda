import * as cloud from './cloud.js';
import { cleanRUT, formatRUT, validateRUT } from './rutValidator.js';
import { MAX_DRINKS, lineTotal } from './rules.js';

const $ = (id) => document.getElementById(id);
const money = (value) => '$' + Number(value).toLocaleString('es-CL');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let busy = false;
let cart = {};
let selectedTab = 'queue';
let lastRut = '';
let sellerName = '';

function validSellerName(value) {
  return value.trim().length <= 120 && /^\S+(?:\s+\S+)+$/.test(value.trim());
}
function showSellerSession() {
  $('sellerGate').hidden = !!sellerName;
  $('workspace').hidden = !sellerName;
  $('activeSeller').textContent = sellerName ? 'Vendedora: ' + sellerName : '';
}

function message(text, error = false) {
  $('appMessage').textContent = text;
  $('appMessage').classList.toggle('error-message', error);
  $('appMessage').hidden = !text;
}
function personByRut(rut) {
  return cloud.state.attendees.find((person) => cleanRUT(person.rut) === cleanRUT(rut));
}
function openLimit(person) {
  $('alertModalName').textContent = person.nombre + ' · ' + formatRUT(person.rut);
  if (!$('alertModal').open) $('alertModal').showModal();
}
function writesEnabled() {
  document.querySelectorAll('[data-write]').forEach((button) => {
    button.disabled = busy || !cloud.connected || !!cloud.pending || button.dataset.blocked === 'true';
  });
  ['queueRutInput', 'saleRutInput', 'inputNewName', 'inputNewCarrera', 'paymentMethod',
    'btnClearCart', 'btnNextStudent'].forEach((id) => { $(id).disabled = busy; });
  $('btnRetry').disabled = busy || !cloud.connected;
  document.querySelectorAll('[data-cart]').forEach((button) => {
    button.disabled = busy || !!cloud.pending || button.dataset.blocked === 'true';
  });
}
function switchTab(tab) {
  selectedTab = tab;
  $('tabContentQueue').hidden = tab !== 'queue';
  $('tabContentSales').hidden = tab !== 'sales';
  for (const [id, target] of [['navTabQueue', 'queue'], ['navTabSales', 'sales']]) {
    $(id).classList.toggle('active', target === tab);
    $(id).setAttribute('aria-pressed', String(target === tab));
  }
}

function renderQueue() {
  const rut = $('queueRutInput').value;
  const raw = cleanRUT(rut);
  const valid = validateRUT(rut);
  $('rutStatusBadge').className = 'rut-status-badge ' + (!raw ? 'empty' : valid ? 'valid' : 'invalid');
  $('rutStatusBadge').textContent = valid ? '✓ RUT válido' : raw ? 'Revisa el RUT y su dígito verificador.' : '';
  $('queueRutInput').setAttribute('aria-invalid', String(!!raw && !valid));
  $('resultCard').classList.toggle('hidden', !valid || !cloud.connected);
  if (!valid || !cloud.connected) return;
  const person = personByRut(rut);
  $('viewFound').hidden = !person;
  $('viewNew').hidden = !!person;
  const registerPrimary = $('formQuickRegister').querySelector('[value="1"]');
  registerPrimary.hidden = false;
  if (!person) return;
  $('foundPersonName').textContent = person.nombre;
  $('foundPersonCarrera').textContent = person.carrera;
  $('foundPersonRutSub').textContent = formatRUT(person.rut);
  const blocked = person.tragos >= MAX_DRINKS;
  const tone = blocked ? 'danger' : person.tragos === 2 ? 'warning' : 'safe';
  $('foundStatusBanner').className = 'status-alert-banner ' + tone;
  $('foundStatusBanner').textContent = blocked ? '⛔ 3 de 3 tragos · No vender más'
    : person.tragos + ' de 3 tragos · Puede comprar ' + (MAX_DRINKS - person.tragos) + ' más';
  $('drinkProgress').innerHTML = Array.from({ length: MAX_DRINKS }, (_, index) =>
    '<span class="' + (index < person.tragos ? 'filled ' + tone : '') + '">' + (index + 1) + '</span>').join('');
  $('drinkProgress').setAttribute('aria-label', person.tragos + ' de 3 tragos registrados');
  $('btnGiantAddDrink').dataset.blocked = String(blocked);
  $('btnGiantAddDrink').classList.toggle('blocked', blocked);
  $('btnGiantAddDrink').textContent = blocked ? 'Límite de 3 tragos alcanzado' : person.tragos === 2 ? 'Registrar el último trago permitido' : 'Registrar 1 trago';
}

function renderTable() {
  $('dbTotalCount').textContent = cloud.state.attendees.length;
  const query = $('dbSearchInput').value.trim().toLocaleLowerCase('es');
  const rutQuery = cleanRUT(query);
  const list = cloud.state.attendees.filter((p) => (p.nombre + ' ' + p.carrera + ' ' + formatRUT(p.rut)).toLocaleLowerCase('es').includes(query)
    || (/^[\d.kK -]+$/.test(query) && rutQuery && cleanRUT(p.rut).includes(rutQuery)));
  $('dbTableBody').innerHTML = list.length ? list.map((p) => {
    const tone = p.tragos >= 3 ? 'danger' : p.tragos === 2 ? 'warning' : 'safe';
    return '<tr><td class="rut-col">' + escape(formatRUT(p.rut)) + '</td><td><strong>' + escape(p.nombre)
      + '</strong></td><td>' + escape(p.carrera) + '</td><td><span class="badge-table-drink ' + tone + '">'
      + p.tragos + '/3</span></td><td><button class="btn-sub-minimal" data-person="' + escape(p.rut) + '">Consultar</button></td></tr>';
  }).join('') : '<tr><td colspan="5">No hay estudiantes que coincidan.</td></tr>';
}

function activeItems() {
  return cloud.state.products.filter((p) => (cart[p.id] || 0) > 0).map((p) => ({ ...p, qty: cart[p.id] }));
}
function renderSales() {
  const data = cloud.state;
  $('salesTotalRevenue').textContent = money(data.totalRevenue);
  $('salesTotalOrders').textContent = data.totalOrders;
  $('paymentTotals').textContent = 'Efectivo: ' + money(data.payments.efectivo || 0)
    + ' · Transferencias: ' + money(data.payments.transferencia || 0) + ' · Tarjetas: ' + money(data.payments.tarjeta || 0);
  $('productsListContainer').innerHTML = data.products.map((p) => {
    const qty = cart[p.id] || 0;
    return '<article class="product-card"><div class="product-info"><span class="product-icon" aria-hidden="true">' + escape(p.icon)
      + '</span><div><h3 class="product-title">' + escape(p.name) + '</h3><div class="product-price">' + money(p.price)
      + (p.pair_price ? ' · 2 por ' + money(p.pair_price) : '') + '</div>'
      + (p.drinks ? '<span class="alcohol-label">Cuenta para el límite de 3</span>' : '') + '</div></div>'
      + '<div class="product-controls"><button class="btn-qty-action" data-cart="' + escape(p.id) + '" data-delta="-1" data-blocked="' + (qty === 0)
      + '" aria-label="Quitar ' + escape(p.name) + '">−</button><span class="product-qty-badge">' + qty
      + '</span><button class="btn-qty-action" data-cart="' + escape(p.id) + '" data-delta="1" data-blocked="' + (qty >= (p.drinks ? 3 : 100))
      + '" aria-label="Agregar ' + escape(p.name) + '">+</button></div></article>';
  }).join('');
  const items = activeItems();
  const drinks = items.reduce((sum, item) => sum + item.drinks * item.qty, 0);
  $('cartItemsList').innerHTML = items.length ? items.map((item) =>
    '<div class="cart-item-row"><span class="item-name">' + escape(item.name) + ' × ' + item.qty
    + '</span><span class="item-total">' + money(lineTotal(item, item.qty)) + '</span></div>').join('')
    : '<p class="empty-cart">Selecciona productos para comenzar la venta.</p>';
  $('cartTotalAmount').textContent = money(items.reduce((sum, item) => sum + lineTotal(item, item.qty), 0));
  $('saleStudentSection').hidden = drinks === 0;
  const rut = $('saleRutInput').value;
  const person = personByRut(rut);
  const valid = validateRUT(rut);
  const remaining = person ? Math.max(0, 3 - person.tragos) : 0;
  const eligible = drinks === 0 || (valid && person && drinks <= remaining);
  $('btnConfirmSale').dataset.blocked = String(!items.length || !eligible);
  $('salePersonCard').hidden = !person;
  $('saleRegisterForm').hidden = !valid || !!person;
  if (person) {
    $('salePersonName').textContent = person.nombre;
    $('salePersonCareer').textContent = person.carrera;
    $('salePersonRut').textContent = formatRUT(person.rut) + ' · ' + person.tragos + ' de 3 tragos';
  }
  $('saleStudentStatus').textContent = !valid ? 'Ingresa un RUT válido para consultar el cupo.'
    : !person ? 'Este estudiante todavía no está registrado.'
      : person.nombre + ' · ' + person.tragos + '/3 registrados · '
        + (drinks > remaining ? 'Venta bloqueada: solo le quedan ' + remaining + '.' : 'Esta venta suma ' + drinks + ' trago(s).');
  $('saleStudentStatus').classList.toggle('text-warning', !eligible);
  $('salesHistoryTableBody').innerHTML = data.transactions.length ? data.transactions.map((sale) =>
    '<tr><td>#' + sale.number + '</td><td>' + escape(new Date(sale.created_at).toLocaleString('es-CL'))
    + '</td><td>' + escape(sale.seller || 'Sin registro') + '</td><td>'
    + escape(sale.items.map((i) => i.name + ' × ' + i.qty).join(', '))
    + '</td><td class="rut-col">' + escape(sale.rut ? formatRUT(sale.rut) : '—') + '</td><td>' + escape(sale.payment)
    + '</td><td><strong>' + money(sale.total) + '</strong></td></tr>').join('')
    : '<tr><td colspan="7">Aún no hay ventas confirmadas.</td></tr>';
}
function render() {
  $('connectionStatus').textContent = cloud.connectionMessage;
  $('connectionStatus').classList.toggle('text-error', !cloud.connected);
  $('pendingPanel').hidden = !cloud.pending;
  renderQueue();
  renderTable();
  renderSales();
  writesEnabled();
}
async function runMutation(kind, payload) {
  if (busy) return;
  busy = true;
  message('');
  writesEnabled();
  try {
    const result = await cloud.operate(kind, payload);
    if (kind === 'register') {
      $('formQuickRegister').reset();
      $('queueRutInput').value = formatRUT(result.person.rut);
      message('Estudiante registrado con ' + result.person.tragos + ' trago(s).');
    } else if (kind === 'sale') {
      cart = {};
      $('saleRutInput').value = '';
      message('Venta #' + result.transaction.number + ' guardada · ' + money(result.transaction.total) + '.');
    } else message('Trago registrado · ' + result.person.tragos + ' de 3.');
    if (result.limitReachedJustNow) openLimit(result.person);
  } catch (error) { message(error.message, true); }
  finally { busy = false; render(); }
}

$('btnRefresh').addEventListener('click', () => void cloud.refresh());
$('sellerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('sellerNameInput').value.trim().replace(/\s+/g, ' ');
  if (!validSellerName(value)) return message('Escribe tu nombre y apellido.', true);
  sellerName = value;
  try { localStorage.setItem('fiestas_seller_name', sellerName); } catch { /* The session still works without storage. */ }
  message('Sesión iniciada como ' + sellerName + '.');
  showSellerSession();
});
$('btnChangeSeller').addEventListener('click', () => {
  sellerName = '';
  try { localStorage.removeItem('fiestas_seller_name'); } catch { /* Storage may be unavailable. */ }
  $('sellerNameInput').value = '';
  message('');
  showSellerSession();
  $('sellerNameInput').focus();
});
$('btnRetry').addEventListener('click', () => { if (cloud.pending) void runMutation(cloud.pending.kind, cloud.pending.payload); });
$('navTabQueue').addEventListener('click', () => switchTab('queue'));
$('navTabSales').addEventListener('click', () => switchTab('sales'));
$('alertModalClose').addEventListener('click', () => $('alertModal').close());

$('queueRutInput').addEventListener('input', () => {
  // Keep invalid characters visible; never turn a mistyped RUT into another student's RUT.
  const raw = cleanRUT($('queueRutInput').value);
  if (/^[0-9.kK\s-]*$/.test($('queueRutInput').value)) $('queueRutInput').value = formatRUT($('queueRutInput').value);
  if (raw !== lastRut) { $('formQuickRegister').reset(); lastRut = raw; message(''); }
  renderQueue();
  writesEnabled();
});
$('btnNextStudent').addEventListener('click', () => {
  $('queueRutInput').value = ''; lastRut = '';
  $('formQuickRegister').reset(); message(''); renderQueue(); $('queueRutInput').focus();
});
$('formQuickRegister').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validateRUT($('queueRutInput').value)) return message('Revisa el RUT.', true);
  void runMutation('register', { rut: cleanRUT($('queueRutInput').value), nombre: $('inputNewName').value.trim(),
    carrera: $('inputNewCarrera').value.trim(), initialTragos: Number(event.submitter?.value ?? 1) });
});
$('btnGiantAddDrink').addEventListener('click', () => {
  const person = personByRut($('queueRutInput').value);
  if (!person) return;
  if (person.tragos >= 3) return openLimit(person);
  void runMutation('drink', { id: person.id });
});
$('btnToggleDb').addEventListener('click', () => {
  const open = $('dbContent').classList.toggle('open');
  $('btnToggleDb').setAttribute('aria-expanded', String(open));
  $('dbToggleIcon').textContent = open ? '▲' : '▼';
});
$('dbSearchInput').addEventListener('input', renderTable);
$('dbTableBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-person]');
  if (!button || busy) return;
  $('queueRutInput').value = formatRUT(button.dataset.person);
  $('formQuickRegister').reset();
  renderQueue(); writesEnabled(); $('queueRutInput').focus();
});
$('btnDownloadTxt').addEventListener('click', () => {
  if (!cloud.connected) return message('Actualiza la conexión antes de descargar.', true);
  const people = cloud.state.attendees;
  const content = 'FONDEANDO AURA · ESTUDIANTES Y TRAGOS\n' + new Date().toLocaleString('es-CL') + '\n\n'
    + people.map((p) => formatRUT(p.rut) + ' | ' + p.nombre + ' | ' + p.carrera + ' | ' + p.tragos
      + '/3' + (p.tragos >= 3 ? ' · NO VENDER MÁS' : '')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  link.download = 'estudiantes-fondeando-aura.txt';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
$('productsListContainer').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cart]');
  if (!button || button.disabled || busy || cloud.pending) return;
  const product = cloud.state.products.find((p) => p.id === button.dataset.cart);
  if (!product) return;
  cart[product.id] = Math.max(0, Math.min(product.drinks ? 3 : 100, (cart[product.id] || 0) + Number(button.dataset.delta)));
  renderSales(); writesEnabled();
});
$('btnClearCart').addEventListener('click', () => { cart = {}; $('saleRutInput').value = ''; renderSales(); writesEnabled(); });
$('saleRutInput').addEventListener('input', () => {
  if (/^[0-9.kK\s-]*$/.test($('saleRutInput').value)) $('saleRutInput').value = formatRUT($('saleRutInput').value);
  renderSales(); writesEnabled();
});
$('saleRegisterForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validateRUT($('saleRutInput').value)) return message('Revisa el RUT.', true);
  if (busy) return;
  busy = true;
  message('');
  writesEnabled();
  try {
    const result = await cloud.operate('register', {
      rut: cleanRUT($('saleRutInput').value),
      nombre: $('saleNewName').value.trim(),
      carrera: $('saleNewCareer').value.trim(),
      initialTragos: 0
    });
    $('saleRegisterForm').reset();
    message(result.person.nombre + ' quedó registrado. Ya puedes confirmar la venta.');
  } catch (error) { message(error.message, true); }
  finally { busy = false; render(); }
});
$('btnConfirmSale').addEventListener('click', () => {
  if ($('btnConfirmSale').disabled) return;
  void runMutation('sale', { items: activeItems().map((item) => ({ id: item.id, qty: item.qty })),
    rut: cleanRUT($('saleRutInput').value), payment: $('paymentMethod').value, seller: sellerName });
});

cloud.subscribe(render);
try {
  const storedSeller = localStorage.getItem('fiestas_seller_name') || '';
  if (validSellerName(storedSeller)) sellerName = storedSeller.trim().replace(/\s+/g, ' ');
  const attendees = localStorage.getItem('fiestas_attendees_db_v1');
  const sales = localStorage.getItem('fiestas_sales_db_v1');
  $('legacyPanel').hidden = !attendees && !sales;
  $('btnLegacyBackup').addEventListener('click', () => {
    const content = JSON.stringify({ exportedAt: new Date().toISOString(), attendees, sales }, null, 2);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    link.download = 'fiestas-respaldo-anterior.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
} catch { /* Browser storage may be unavailable. Supabase records remain separate. */ }
showSellerSession();
try {
  const config = cloud.getConfig();
  await cloud.initialize(config);
} catch (error) { message(error.message, true); }
render();
