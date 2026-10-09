import {
  BUSINESS_TIME_ZONE,
  businessToday,
  Decimal,
  type Currency,
  type CustomerDto,
} from '@ayr/shared';

/**
 * RF-S3/M1: la misma etiqueta en los tres lugares que muestran un cliente elegido
 * (cotización/pedido nuevo, cambiar cliente de un pedido, importador) — antes cada uno la
 * armaba a mano y dos de los tres ya coincidían por casualidad.
 */
export function customerLabel(c: Pick<CustomerDto, 'name' | 'docNumber'>): string {
  return `${c.name} — ${c.docNumber}`;
}

/**
 * Formateo para mostrar. Los valores llegan del API como string con su escala fija
 * (D-003): acá solo se les da forma. El redondeo se hace con `Decimal`, nunca
 * truncando la cadena, porque un `S/ 3.45` donde el costo real es `3.4567` le da al
 * usuario una cuenta distinta al multiplicarlo por los kilos.
 */

const SYMBOL: Record<Currency, string> = { PEN: 'S/', USD: 'US$' };

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `"1234.5678"` → `"S/ 1,234.57"`. `decimals` sube a 4 para precios unitarios. */
export function formatMoney(value: string, currency: Currency = 'PEN', decimals = 2): string {
  const rounded = new Decimal(value)
    .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
    .toFixed(decimals);
  const negative = rounded.startsWith('-');
  const [intPart = '0', decPart = ''] = rounded.replace('-', '').split('.');
  return `${negative ? '-' : ''}${SYMBOL[currency]} ${group(intPart)}${decPart ? `.${decPart}` : ''}`;
}

/**
 * cc31: un importe sin el símbolo, para la columna de una lista cuya cabecera ya dice la moneda
 * («Total (S/)»): `"1717.2"` → `"1,717.20"`.
 */
export function formatAmount(value: string | Decimal, decimals = 2): string {
  return formatNumber(value, decimals);
}

/** cc31: la moneda de una cabecera de columna: `"Total (S/)"`. */
export function currencyHeader(label: string, currency: Currency = 'PEN'): string {
  return `${label} (${SYMBOL[currency]})`;
}

/**
 * Igual que `formatMoney` pero tolera `null`: el API oculta los costos a VENDEDOR
 * (§3.4) devolviéndolos vacíos, y la vista muestra un guion en vez de un cero que se
 * leería como un costo real de S/ 0.00.
 */
export function formatMoneyOrDash(
  value: string | null | undefined,
  currency: Currency = 'PEN',
  decimals = 2,
): string {
  return value === null || value === undefined ? '—' : formatMoney(value, currency, decimals);
}

/**
 * Símbolo corto de una unidad SUNAT (catálogo 03) para mostrar junto a una cantidad.
 * El API devuelve el código (`KGM`, `NIU`…), pero en pantalla conviven con los kilos
 * que las tarjetas de bobina escriben a mano: sin este mapa, la misma magnitud se ve
 * como `KGM` en una tabla y como `kg` dos centímetros más arriba.
 */
const UNIT_SYMBOL: Record<string, string> = {
  KGM: 'kg',
  NIU: 'u',
  MTR: 'm',
  TNE: 't',
  ZZ: '',
};

export function unitSymbol(unit: string): string {
  return UNIT_SYMBOL[unit] ?? unit;
}

/**
 * Un número con separador de miles y `decimals` decimales, redondeado con `Decimal` (nunca
 * truncando la cadena). Solo para mostrar: lo que viaja al API conserva su escala.
 */
export function formatNumber(value: string | Decimal, decimals: number): string {
  let parsed: Decimal;
  try {
    parsed = new Decimal(typeof value === 'string' ? value.trim() : value);
  } catch {
    // Un texto que no es número (un campo a medio escribir) se muestra tal cual.
    return typeof value === 'string' ? value : value.toString();
  }
  const rounded = parsed.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
  const negative = rounded.startsWith('-') && !/^-0(\.0*)?$/.test(rounded);
  const [intPart = '0', decPart = ''] = rounded.replace('-', '').split('.');
  return `${negative ? '-' : ''}${group(intPart)}${decPart ? `.${decPart}` : ''}`;
}

function withUnit(body: string, unit?: string): string {
  return unit ? `${body} ${unit}` : body;
}

/**
 * cc31: kilos en listas, formularios y reportes, a 2 decimales (`4,027.44 kg`). El kardex y el
 * detalle de bobina, donde el gramo importa, usan `formatKgPrecise`.
 *
 * Una cantidad que no es cero nunca se muestra como `0.00`: «faltan 0.00 kg» cuando faltan
 * 4 gramos dice lo contrario de lo que pasa. Por debajo del centésimo sale con 3 decimales.
 */
export function formatKg(value: string | Decimal, unit: string | null = 'kg'): string {
  const two = formatNumber(value, 2);
  const roundsToZero = /^-?0\.00$/.test(two);
  let nonZero = false;
  try {
    nonZero = !new Decimal(typeof value === 'string' ? value.trim() : value).isZero();
  } catch {
    nonZero = false;
  }
  return withUnit(roundsToZero && nonZero ? formatNumber(value, 3) : two, unit ?? undefined);
}

/** cc31: kilos con sus 3 decimales (kardex y detalle de bobina). */
export function formatKgPrecise(value: string | Decimal, unit: string | null = 'kg'): string {
  return withUnit(formatNumber(value, 3), unit ?? undefined);
}

/**
 * cc31: metros a 2 decimales; el tercero solo cuando no es cero (`12.00 m`, `4.205 m`). Un largo
 * de plancha se corta al milímetro, así que el tercer decimal es dato cuando existe y ruido
 * cuando es cero.
 */
export function formatMeters(value: string | Decimal, unit: string | null = 'm'): string {
  let three: Decimal;
  try {
    three = new Decimal(typeof value === 'string' ? value.trim() : value).toDecimalPlaces(
      3,
      Decimal.ROUND_HALF_UP,
    );
  } catch {
    return withUnit(typeof value === 'string' ? value : value.toString(), unit ?? undefined);
  }
  const decimals = three.times(1000).mod(10).isZero() ? 2 : 3;
  return withUnit(formatNumber(three, decimals), unit ?? undefined);
}

/**
 * Una cantidad con su unidad. Los kilos y los metros siguen las reglas de cc31 (`formatKg`,
 * `formatMeters`); el resto (unidades, milímetros) se muestra con la escala que trae.
 */
export function formatQty(value: string, unit?: string): string {
  if (unit === 'kg') return formatKg(value);
  if (unit === 'm') return formatMeters(value);
  return formatQtyAsIs(value, unit);
}

/**
 * Una cantidad con la escala que trae (`"4500.000"` → `"4,500.000 kg"`). cc31 (D-480): la
 * usan las pantallas de planta y los diálogos de la bobina, que quedan fuera del cambio a 2
 * decimales: ahí se declaran y comparan kilos al gramo.
 */
export function formatQtyAsIs(value: string, unit?: string): string {
  const [intPart = '0', decPart] = value.split('.');
  const body = decPart ? `${group(intPart)}.${decPart}` : group(intPart);
  return withUnit(body, unit);
}

/**
 * Una cantidad con la unidad SUNAT del producto (`KGM`, `MTR`, `NIU`…): kilos y metros con las
 * reglas de cc31 y las unidades sin cambio.
 */
export function formatUnitQty(value: string, sunatUnit: string): string {
  return formatQty(value, unitSymbol(sunatUnit));
}

/** `"2026-08-20"` → `"20/08/2026"`. Sin `Date` para no arrastrar zonas horarias. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/**
 * Fecha de hoy **en Lima**, en `YYYY-MM-DD`, para prellenar formularios.
 *
 * Antes leía los componentes locales del navegador, y eso alcanzaba mientras nadie comparara
 * el valor contra nada. D-124 lo cambió: el API valida las fechas de negocio contra el día de
 * **Lima**, así que un cliente en un huso por delante prellenaba mañana y recibía "la fecha de
 * operación no puede ser futura" en una operación perfectamente normal. Es el mismo desfase de
 * D-112, en el helper que se había quedado afuera de aquella corrección.
 */
export function todayIso(): string {
  return businessToday();
}

/**
 * El **día de Lima** de un instante, en `DD/MM/AAAA`.
 *
 * `formatDate(iso.slice(0, 10))` no sirve para un timestamp: corta en UTC, y Lima va cinco
 * horas detrás, así que todo lo ocurrido después de las 19:00 locales se mostraba con la
 * fecha del día siguiente. Es el mismo desfase que `businessToday` y `queueAgeLabel` ya
 * existen para evitar (D-069).
 */
export function formatTimestampDate(iso: string | null): string {
  if (!iso) return '—';
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return formatDate(day);
}

const DATE_TIME_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * cc31: fecha y hora **de Lima** de un instante, en `DD/MM/AAAA HH:MM` (24 h). Reemplaza las
 * copias que cada vista armaba con su propio `Intl.DateTimeFormat` o con `toLocaleString`, que
 * seguía la zona y el idioma del navegador.
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const parts = Object.fromEntries(
    DATE_TIME_PARTS.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.day ?? ''}/${parts.month ?? ''}/${parts.year ?? ''} ${parts.hour ?? ''}:${parts.minute ?? ''}`;
}

/**
 * Edad en la cola de producción (D-093), en días calendario **de Lima** (D-069) y no en
 * milisegundos: contar por `Date.now() - createdAt` corre el riesgo del mismo desfase que
 * `businessToday` existe para evitar, cerca de la medianoche local.
 */
export function queueAgeLabel(createdAtIso: string): string {
  const createdDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(createdAtIso));
  const days = Math.round(
    (Date.parse(`${businessToday()}T00:00:00.000Z`) - Date.parse(`${createdDay}T00:00:00.000Z`)) /
      86_400_000,
  );
  if (days <= 0) return 'hoy';
  if (days === 1) return '1 día';
  return `${days} días`;
}

/** `true` si la cadena es un decimal válido y positivo, para no mandar basura al API. */
export function isPositiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim()) && new Decimal(value.trim()).gt(0);
}

/**
 * cc36: un decimal **ya escrito** con al menos 2 decimales y sin ceros de más («35.4000» →
 * «35.40», «12.000» → «12.00», «9.8333» queda igual). Solo para mostrar en un campo que no se está
 * editando: no pierde ninguna cifra significativa y lo que se guarda no cambia. Lo que no es un
 * número positivo se devuelve tal cual.
 */
export function displayDecimal(value: string, minDecimals = 2): string {
  if (!isPositiveDecimal(value)) return value;
  const d = new Decimal(value.trim());
  return d.toFixed(Math.max(minDecimals, d.decimalPlaces()));
}

/**
 * cc37: la abreviatura de una unidad **en el formulario de venta** (tablero LineasB): «und» para
 * las unidades (`NIU`) y el símbolo de siempre para el resto. El resto de la app sigue con
 * `unitSymbol` («u») hasta que se decida unificarlo.
 */
export function salesUnitSymbol(unit: string): string {
  return unit === 'NIU' ? 'und' : unitSymbol(unit);
}

/**
 * cc37: una cantidad con su unidad para los textos de estado y disponibilidad del formulario de
 * venta: unidades sin decimales de más («1,120 und», «2.5 und» si hay fracción), kilos y metros con
 * la regla de cc31 (2 decimales).
 */
export function formatSalesQty(value: string | Decimal, unit: string, showUnit = true): string {
  const symbol = showUnit ? salesUnitSymbol(unit) : '';
  if (salesUnitSymbol(unit) === 'kg') return formatKg(value, symbol);
  if (salesUnitSymbol(unit) === 'm') return formatMeters(value, symbol);
  let parsed: Decimal;
  try {
    parsed = new Decimal(typeof value === 'string' ? value.trim() : value);
  } catch {
    return withUnit(typeof value === 'string' ? value : value.toString(), symbol);
  }
  return withUnit(formatNumber(parsed, parsed.decimalPlaces()), symbol);
}
