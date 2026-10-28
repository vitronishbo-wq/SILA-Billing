const UNIDADES = [
  '', 'Um', 'Dois', 'Três', 'Quatro', 'Cinco', 'Seis', 'Sete', 'Oito', 'Nove',
  'Dez', 'Onze', 'Doze', 'Treze', 'Quatorze', 'Quinze', 'Dezasseis', 'Dezassete', 'Dezoito', 'Dezanove'
];

const DEZENAS = [
  '', '', 'Vinte', 'Trinta', 'Quarenta', 'Cinquenta', 'Sessenta', 'Setenta', 'Oitenta', 'Noventa'
];

const CENTENAS = [
  '', 'Cento', 'Duzentos', 'Trezentos', 'Quatrocentos', 'Quinhentos', 'Seiscentos', 'Setecentos', 'Oitocentos', 'Novecentos'
];

function convertGroupBelow1000(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'Cem';

  const parts: string[] = [];
  const c = Math.floor(n / 100);
  const rem = n % 100;

  if (c > 0) {
    parts.push(CENTENAS[c]);
  }

  if (rem > 0) {
    if (rem < 20) {
      parts.push(UNIDADES[rem]);
    } else {
      const d = Math.floor(rem / 10);
      const u = rem % 10;
      if (d > 0) parts.push(DEZENAS[d]);
      if (u > 0) parts.push(UNIDADES[u]);
    }
  }

  return parts.join(' e ');
}

function convertIntegerToPt(num: number): string {
  if (num === 0) return 'Zero';

  const billions = Math.floor(num / 1_000_000_000);
  const millions = Math.floor((num % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((num % 1_000_000) / 1_000);
  const remainder = num % 1_000;

  const segments: string[] = [];

  if (billions > 0) {
    segments.push(
      billions === 1
        ? 'Um Milhão de Milhar'
        : `${convertGroupBelow1000(billions)} Milhões de Milhar`
    );
  }

  if (millions > 0) {
    segments.push(
      millions === 1
        ? 'Um Milhão'
        : `${convertGroupBelow1000(millions)} Milhões`
    );
  }

  if (thousands > 0) {
    segments.push(
      thousands === 1
        ? 'Mil'
        : `${convertGroupBelow1000(thousands)} Mil`
    );
  }

  if (remainder > 0) {
    segments.push(convertGroupBelow1000(remainder));
  }

  if (segments.length === 1) return segments[0];

  const last = segments.pop()!;
  const needsE = remainder > 0 && (remainder < 100 || remainder % 100 === 0);
  return needsE
    ? `${segments.join(', ')} e ${last}`
    : `${segments.join(', ')} ${last}`;
}

/**
 * Converte um valor numérico em Kwanzas para extenso formal angolano.
 * Ex: 7802.40 -> "Sete Mil, Oitocentos e Dois Kwanzas e Quarenta Cêntimos"
 */
export function kwanzaToWords(amount: number): string {
  const safe = Math.max(0, Math.round(amount * 100) / 100);
  const integerPart = Math.floor(safe);
  const centsPart = Math.round((safe - integerPart) * 100);

  const kwanzasText =
    integerPart === 1
      ? 'Um Kwanza'
      : `${convertIntegerToPt(integerPart)} Kwanzas`;

  if (centsPart === 0) {
    return kwanzasText;
  }

  const centsText =
    centsPart === 1
      ? 'Um Cêntimo'
      : `${convertGroupBelow1000(centsPart)} Cêntimos`;

  return `${kwanzasText} e ${centsText}`;
}
