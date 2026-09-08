/**
 * Validador y Formateador de RUT Chileno (Módulo 11)
 */

export function cleanRUT(rut) {
  return typeof rut === 'string' ? rut.replace(/[^0-9kK]/g, '').toUpperCase() : '';
}

export function formatRUT(rut) {
  const cleaned = cleanRUT(rut);
  if (!cleaned) return '';
  if (cleaned.length === 1) return cleaned;

  const dv = cleaned.slice(-1);
  let body = cleaned.slice(0, -1);

  // Formatear cuerpo con puntos
  body = body.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return `${body}-${dv}`;
}

export function validateRUT(rut) {
  if (typeof rut !== 'string' || !/^[0-9.kK\s-]+$/.test(rut)) return false;
  const cleaned = cleanRUT(rut);
  if (!/^[1-9]\d{6,7}[0-9K]$/.test(cleaned)) {
    return false;
  }

  const body = cleaned.slice(0, -1);
  const dvInput = cleaned.slice(-1);

  // Calcular Dígito Verificador mediante algoritmo Módulo 11
  let sum = 0;
  let multiplier = 2;

  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body.charAt(i), 10) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  let dvExpected = '';

  if (remainder === 11) {
    dvExpected = '0';
  } else if (remainder === 10) {
    dvExpected = 'K';
  } else {
    dvExpected = remainder.toString();
  }

  return dvInput === dvExpected;
}
