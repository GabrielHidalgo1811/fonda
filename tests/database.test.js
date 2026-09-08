import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { validateRUT, formatRUT } from '../js/rutValidator.js';
import { lineTotal, PRODUCTS_CATALOG } from '../js/rules.js';

const SELLER = 'María Pérez';

function validRut(body) {
  let sum = 0, multiplier = 2;
  for (const digit of String(body).split('').reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const check = 11 - sum % 11;
  return String(body) + (check === 11 ? '0' : check === 10 ? 'K' : check);
}

test('RUT chileno y precios de los afiches', () => {
  assert.equal(validateRUT('12.345.678-5'), true);
  assert.equal(validateRUT('123456785'), true);
  assert.equal(formatRUT('123456785'), '12.345.678-5');
  for (const value of ['', '00000000-0', '12345678-9', 'k2345678-5', 'a12345678-5', '123456785999', '0123456785']) {
    assert.equal(validateRUT(value), false, value);
  }
  for (let body = 10000000; body < 10000100; body++) assert.ok(validateRUT(validRut(body)));
  const terremoto = PRODUCTS_CATALOG.find((p) => p.id === 'terremoto');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((qty) => lineTotal(terremoto, qty)), [0, 4000, 7000, 11000, 14000, 18000]);
  assert.equal(lineTotal(PRODUCTS_CATALOG.find((p) => p.id === 'empanada-pino'), 2), 5600);
  assert.throws(() => lineTotal(terremoto, 1.5));
});

test('Migración y reglas reales de PostgreSQL', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated;');
  await db.exec(await readFile(new URL('../supabase/migrations/202609080001_fiestas.sql', import.meta.url), 'utf8'));
  const operate = async (kind, payload, key = randomUUID()) => {
    const result = await db.query('select public.fiestas_operate($1, $2, $3::jsonb) result', [key, kind, JSON.stringify(payload)]);
    return result.rows[0].result;
  };
  const snapshot = async () => (await db.query('select public.fiestas_snapshot() state')).rows[0].state;
  const register = (rut, initialTragos = 1) => operate('register', { rut, nombre: 'Estudiante de prueba', carrera: 'Informática', initialTragos });

  await t.test('el catálogo SQL coincide con los afiches y el cálculo de caja', async () => {
    const catalog = (await snapshot()).products;
    assert.deepEqual(catalog.map(({ id, name, price, pair_price, icon, drinks }) => ({ id, name, price, pair_price, icon, drinks })), PRODUCTS_CATALOG);
    for (let body = 10000000; body < 10000030; body++) {
      assert.equal((await db.query('select public.fiestas_valid_rut($1) valid', [validRut(body)])).rows[0].valid, true);
    }
  });

  await t.test('registro, RUT normalizado, duplicado e información obligatoria', async () => {
    const { person } = await register('12.345.678-5');
    assert.equal(person.rut, '123456785');
    assert.equal(person.tragos, 1);
    await assert.rejects(register('123456785'), /ya está registrado/);
    await assert.rejects(register('12.345.678-9'), /RUT chileno válido/);
    await assert.rejects(register(validRut(11000000), 4), /cero o un trago/);
    await assert.rejects(operate('register', { rut: validRut(11000000), nombre: ' ', carrera: 'Derecho' }), /nombre y la carrera/);
    assert.equal((await snapshot()).attendees.length, 1);
  });

  await t.test('solo se permiten tres tragos, incluso enviando varias solicitudes', async () => {
    const { person } = await register(validRut(11000001), 0);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => operate('drink', { id: person.id })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal((await snapshot()).attendees.find((p) => p.id === person.id).tragos, 3);
    assert.equal((await db.query('select count(*)::int n from public.fiestas_drink_movements where attendee_id=$1', [person.id])).rows[0].n, 3);
  });

  await t.test('reintentar la misma operación no duplica el trago', async () => {
    const { person } = await register(validRut(11000002), 0);
    const key = randomUUID();
    const a = await operate('drink', { id: person.id }, key);
    const b = await operate('drink', { id: person.id }, key);
    assert.deepEqual(a, b);
    assert.equal((await snapshot()).attendees.find((p) => p.id === person.id).tragos, 1);
    await assert.rejects(operate('drink', { id: randomUUID() }, key), /otra operación/);
  });

  await t.test('venta con promoción suma el cobro y los tragos una sola vez', async () => {
    const rut = validRut(11000003);
    const { person } = await register(rut, 0);
    const key = randomUUID();
    const payload = { rut, payment: 'transferencia', seller: SELLER, items: [{ id: 'terremoto', qty: 2, price: 1 }, { id: 'empanada-pino', qty: 1 }] };
    const result = await operate('sale', payload, key);
    assert.equal(result.transaction.total, 9800);
    assert.equal(result.person.tragos, 2);
    await operate('sale', payload, key);
    const data = await snapshot();
    assert.equal(data.totalRevenue, 9800);
    assert.equal(data.totalOrders, 1);
    assert.equal(data.payments.transferencia, 9800);
    assert.equal(data.attendees.find((p) => p.id === person.id).tragos, 2);
    assert.ok(data.sellerStats.some((seller) => seller.seller === SELLER && seller.orders >= 1 && seller.revenue >= 9800));
    assert.ok(data.sellerProductStats.some((product) => product.seller === SELLER && product.id === 'terremoto' && product.quantity >= 2));
  });

  await t.test('venta que excede el límite se rechaza completa y no aumenta la caja', async () => {
    const rut = validRut(11000003);
    const before = await snapshot();
    await assert.rejects(operate('sale', { rut, payment: 'efectivo', seller: SELLER, items: [{ id: 'choripan', qty: 1 }, { id: 'terremoto', qty: 2 }] }), /Venta bloqueada/);
    assert.deepEqual(await snapshot(), before);
    const result = await operate('sale', { rut, payment: 'efectivo', seller: SELLER, items: [{ id: 'terremoto', qty: 1 }] });
    assert.equal(result.person.tragos, 3);
    assert.equal(result.limitReachedJustNow, true);
    await assert.rejects(operate('drink', { id: result.person.id }), /Límite/);
  });

  await t.test('comida sin RUT; alcohol requiere registro; precios y cantidades se validan en SQL', async () => {
    const sale = await operate('sale', { payment: 'tarjeta', seller: SELLER, items: [{ id: 'anticucho', qty: 5 }] });
    assert.equal(sale.transaction.total, 18000);
    assert.equal(sale.person, null);
    await assert.rejects(operate('sale', { payment: 'efectivo', seller: SELLER, items: [{ id: 'terremoto', qty: 1 }] }), /RUT válido/);
    await assert.rejects(operate('sale', { rut: validRut(11000004), payment: 'efectivo', seller: SELLER, items: [{ id: 'terremoto', qty: 1 }] }), /Registra primero/);
    for (const items of [[], [{ id: 'choripan', qty: -1 }], [{ id: 'choripan', qty: 0 }], [{ id: 'choripan', qty: 1.5 }],
      [{ id: 'gratis', qty: 1 }], [{ id: 'choripan', qty: 1 }, { id: 'choripan', qty: 1 }]]) {
      await assert.rejects(operate('sale', { payment: 'efectivo', seller: SELLER, items }));
    }
  });

  await t.test('los totales incluyen más que las últimas 50 ventas', async () => {
    const before = await snapshot();
    for (let i = 0; i < 51; i++) await operate('sale', { payment: 'efectivo', seller: SELLER, items: [{ id: 'bebida-200', qty: 1 }] });
    const after = await snapshot();
    assert.equal(after.transactions.length, 50);
    assert.equal(after.totalOrders, before.totalOrders + 51);
    assert.equal(after.totalRevenue, before.totalRevenue + 15300);
    assert.ok(after.productStats.some((product) => product.id === 'bebida-200' && product.quantity >= 51));
  });

  await t.test('la clave pública puede usar las funciones pero no cambiar tablas directamente', async () => {
    await db.exec('set role anon');
    assert.ok((await snapshot()).attendees.length);
    const result = await register(validRut(11000005), 0);
    assert.equal(result.person.tragos, 0);
    await assert.rejects(db.query('update public.fiestas_attendees set tragos=0'), /permission denied/);
    await assert.rejects(db.query('delete from public.fiestas_sales'), /permission denied/);
    await db.exec('reset role');
  });
});
