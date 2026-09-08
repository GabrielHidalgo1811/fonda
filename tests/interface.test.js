import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { cleanRUT, formatRUT, validateRUT } from '../js/rutValidator.js';
import { MAX_DRINKS, PRODUCTS_CATALOG, lineTotal } from '../js/rules.js';
import { validateConfig } from '../js/cloud.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function fixture(t, configured = true) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), {
    url: 'https://fiestas.test', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  // jsdom does not implement the native dialog methods; emulate the browser primitive.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.localStorage.setItem('fiestas_seller_name', 'María Pérez');
  const state = { attendees: [], products: structuredClone(PRODUCTS_CATALOG), transactions: [], productStats: [], sellerStats: [], sellerProductStats: [], totalRevenue: 0, totalOrders: 0, payments: {} };
  const requests = [];
  const cloud = {
    state, connected: configured, pending: null, connectionMessage: 'Actualizado',
    getConfig: () => configured ? { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'public-test' } : null,
    initialize: async () => {}, subscribe: (fn) => { cloud.notify = fn; },
    refresh: async () => {},
    operate: async (kind, payload) => {
      requests.push({ kind, payload });
      if (kind === 'register') {
        const person = { id: 'student-' + requests.length, rut: payload.rut, nombre: payload.nombre, carrera: payload.carrera, tragos: payload.initialTragos };
        state.attendees.push(person);
        return { person };
      }
      if (kind === 'drink') {
        const person = state.attendees.find((p) => p.id === payload.id);
        if (person.tragos >= 3) throw new Error('Límite alcanzado');
        person.tragos++;
        return { person, limitReachedJustNow: person.tragos === 3 };
      }
      if (kind === 'sale') {
        const person = state.attendees.find((p) => p.rut === payload.rut);
        const items = payload.items.map((i) => ({ ...state.products.find((p) => p.id === i.id), qty: i.qty }));
        const drinks = items.reduce((s, i) => s + i.qty * i.drinks, 0);
        if (drinks && (!person || person.tragos + drinks > 3)) throw new Error('Venta bloqueada');
        if (person) person.tragos += drinks;
        const transaction = { number: ++state.totalOrders, items, total: items.reduce((s, i) => s + lineTotal(i, i.qty), 0),
          rut: payload.rut, payment: payload.payment, seller: payload.seller, created_at: new Date().toISOString() };
        state.transactions.unshift(transaction);
        for (const item of items) {
          let stat = state.productStats.find((product) => product.id === item.id);
          if (!stat) { stat = { id: item.id, name: item.name, quantity: 0, revenue: 0 }; state.productStats.push(stat); }
          stat.quantity += item.qty;
          stat.revenue += lineTotal(item, item.qty);
          let sellerProduct = state.sellerProductStats.find((product) => product.seller === payload.seller && product.id === item.id);
          if (!sellerProduct) { sellerProduct = { seller: payload.seller, id: item.id, name: item.name, quantity: 0, revenue: 0 }; state.sellerProductStats.push(sellerProduct); }
          sellerProduct.quantity += item.qty;
          sellerProduct.revenue += lineTotal(item, item.qty);
        }
        state.productStats.sort((a, b) => b.quantity - a.quantity);
        state.sellerProductStats.sort((a, b) => a.seller.localeCompare(b.seller) || b.quantity - a.quantity);
        let sellerStat = state.sellerStats.find((seller) => seller.seller === payload.seller);
        if (!sellerStat) { sellerStat = { seller: payload.seller, orders: 0, units: 0, revenue: 0 }; state.sellerStats.push(sellerStat); }
        sellerStat.orders++;
        sellerStat.units += items.reduce((sum, item) => sum + item.qty, 0);
        sellerStat.revenue += transaction.total;
        state.totalRevenue += transaction.total;
        return { person, transaction, limitReachedJustNow: person?.tragos === 3 };
      }
    }
  };
  dom.window.fixture = { cloud, cleanRUT, formatRUT, validateRUT, MAX_DRINKS, lineTotal };
  const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '');
  await dom.window.eval('(async () => { const {cloud, cleanRUT, formatRUT, validateRUT, MAX_DRINKS, lineTotal} = window.fixture;\n' + source + '\n})()');
  const get = (id) => dom.window.document.getElementById(id);
  const input = (id, value) => { get(id).value = value; get(id).dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const add = (id) => dom.window.document.querySelector('[data-cart="' + id + '"][data-delta="1"]').click();
  return { dom, get, input, add, state, requests, cloud };
}

test('la configuración rechaza claves secretas y URLs inseguras', () => {
  assert.deepEqual(validateConfig({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_example' }),
    { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_example' });
  assert.throws(() => validateConfig({ supabaseUrl: 'http://example.supabase.co', supabaseKey: 'sb_publishable_example' }));
  assert.throws(() => validateConfig({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_secret_example' }));
  const adminKey = 'header.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature';
  assert.throws(() => validateConfig({ supabaseUrl: 'https://example.supabase.co', supabaseKey: adminKey }));
});

test('sin conexión se muestra la interfaz, pero se bloquean los guardados', async (t) => {
  const { get } = await fixture(t, false);
  assert.equal(get('workspace').hidden, false);
  assert.equal(get('btnGiantAddDrink').disabled, true);
});

test('registro por RUT, tres tragos, alerta y bloqueo desde la interfaz', async (t) => {
  const { get, input, requests, state, cloud, dom } = await fixture(t);
  input('queueRutInput', '123456789');
  assert.equal(get('resultCard').classList.contains('hidden'), true);
  input('queueRutInput', '123456785');
  assert.equal(get('viewNew').hidden, false);
  input('inputNewName', 'Ana <script>prueba</script>');
  input('inputNewCarrera', 'Derecho');
  get('formQuickRegister').querySelector('[value="1"]').click();
  await settle();
  assert.equal(state.attendees[0].tragos, 1);
  assert.equal(get('viewFound').hidden, false);
  assert.equal(get('foundPersonName').textContent, 'Ana <script>prueba</script>');
  assert.equal(get('dbTableBody').querySelector('script'), null);
  get('btnGiantAddDrink').click();
  get('btnGiantAddDrink').click(); // Fast repeated click while the first is saving.
  await settle();
  assert.equal(state.attendees[0].tragos, 2);
  get('btnGiantAddDrink').click();
  await settle();
  assert.equal(state.attendees[0].tragos, 3);
  assert.equal(get('btnGiantAddDrink').disabled, true);
  assert.equal(get('alertModal').open, true);
  get('btnGiantAddDrink').click();
  assert.equal(requests.length, 3);
  get('alertModalClose').click();
  get('btnNextStudent').click();
  assert.equal(get('queueRutInput').value, '');
  assert.equal(get('resultCard').classList.contains('hidden'), true);
  cloud.notify();
  assert.equal(dom.window.document.querySelectorAll('[data-person]').length, 1);
});

test('alta desde caja empieza en cero; promoción suma dos y bloquea otra venta de dos', async (t) => {
  const { dom, get, input, add, state, requests, cloud } = await fixture(t);
  get('navTabSales').click();
  add('terremoto'); add('terremoto');
  assert.equal(get('cartTotalAmount').textContent, '$7.000');
  assert.equal(get('btnConfirmSale').disabled, true);
  input('saleRutInput', '123456785');
  assert.equal(get('saleRegisterForm').hidden, false);
  input('saleNewName', 'María'); input('saleNewCareer', 'Medicina');
  get('saleRegisterForm').querySelector('button').click();
  await settle();
  assert.equal(state.attendees[0].tragos, 0);
  assert.equal(get('tabContentSales').hidden, false);
  assert.equal(get('salePersonName').textContent, 'María');
  assert.equal(get('salePersonCareer').textContent, 'Medicina');
  assert.equal(get('btnConfirmSale').disabled, false);
  get('btnConfirmSale').click();
  await settle();
  assert.equal(state.attendees[0].tragos, 2);
  assert.equal(state.totalRevenue, 7000);
  assert.equal(requests[1].kind, 'sale');
  assert.equal(requests[1].payload.seller, 'María Pérez');
  get('navTabStats').click();
  assert.equal(get('statsRevenue').textContent, '$7.000');
  assert.equal(get('statsOrders').textContent, '1');
  assert.match(get('productStatsList').textContent, /2 unidades/);
  get('statsSellerFilter').value = 'María Pérez';
  get('statsSellerFilter').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(get('statsProductsTitle').textContent, /María Pérez/);
  assert.match(get('sellerStatsTableBody').textContent, /María Pérez/);
  get('navTabSales').click();
  assert.equal(get('cartTotalAmount').textContent, '$0');
  add('terremoto'); add('terremoto'); input('saleRutInput', '123456785');
  assert.equal(get('btnConfirmSale').disabled, true);
  assert.match(get('saleStudentStatus').textContent, /Venta bloqueada/);
  get('btnClearCart').click(); add('choripan');
  assert.equal(get('saleStudentSection').hidden, true);
  assert.equal(get('btnConfirmSale').disabled, false);
  cloud.connected = false; cloud.notify();
  assert.equal(get('btnConfirmSale').disabled, true);
});
