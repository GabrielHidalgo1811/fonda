export const MAX_DRINKS = 3;

export const PRODUCTS_CATALOG = [
  { id: 'empanada-pino', name: 'Empanada de pino', price: 2800, pair_price: null, icon: '🥟', drinks: 0 },
  { id: 'empanada-queso', name: 'Empanada de queso', price: 2500, pair_price: null, icon: '🧀', drinks: 0 },
  { id: 'mote', name: 'Mote con huesillo', price: 2500, pair_price: null, icon: '🥤', drinks: 0 },
  { id: 'choripan', name: 'Choripán', price: 2000, pair_price: null, icon: '🌭', drinks: 0 },
  { id: 'anticucho', name: 'Anticucho', price: 4000, pair_price: 7000, icon: '🍢', drinks: 0 },
  { id: 'terremoto', name: 'Terremoto', price: 4000, pair_price: 7000, icon: '🍹', drinks: 1 },
  { id: 'bebida', name: 'Bebida (vaso)', price: 2000, pair_price: null, icon: '🥤', drinks: 0 }
];

export function lineTotal(product, qty) {
  if (!Number.isSafeInteger(qty) || qty < 0 || qty > 100) throw new Error('Cantidad inválida.');
  return product.pair_price == null ? product.price * qty
    : Math.floor(qty / 2) * product.pair_price + (qty % 2) * product.price;
}
