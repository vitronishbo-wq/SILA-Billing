/**
 * Identidade visual geométrica/técnica minimalista do SILA-Billing.
 * 100% SVG inline e CSS — zero dependências, zero requisições externas, 100% offline e isolada da impressão.
 */

export function renderSilaGeometricMark(className = 'w-4 h-4'): string {
  return `<svg class="${className} shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 2.5h10L21.5 7v10L17 21.5H7L2.5 17V7L7 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.88" />
    <path d="M12 5.25 18.75 12 12 18.75 5.25 12 12 5.25Z" stroke="#2563EB" stroke-width="1.5" stroke-linejoin="round" />
    <path d="M12 8.75v6.5M8.75 12h6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.92" />
  </svg>`;
}

export function renderGeometricWatermarkLayer(
  theme: 'dark' | 'light',
  variant: 'center' | 'corner' = 'center'
): string {
  const strokeMain = theme === 'dark' ? '#94A3B8' : '#0F172A';
  const strokeAccent = theme === 'dark' ? '#3B82F6' : '#2563EB';
  const sealOpacity = theme === 'dark' ? (variant === 'center' ? '0.065' : '0.05') : variant === 'center' ? '0.05' : '0.04';
  const tickOpacity = theme === 'dark' ? '0.14' : '0.09';

  const sealSvg = `<svg viewBox="0 0 320 320" fill="none" class="${
    variant === 'center'
      ? 'w-[340px] h-[340px] sm:w-[460px] sm:h-[460px]'
      : 'w-[280px] h-[280px] sm:w-[380px] sm:h-[380px]'
  }" style="opacity: ${sealOpacity};">
    <g stroke="${strokeMain}" stroke-width="1">
      <circle cx="160" cy="160" r="136" stroke-dasharray="4 6" />
      <circle cx="160" cy="160" r="108" />
      <path d="M96 28h128L292 96v128l-68 68H96l-68-68V96L96 28Z" />
      <path d="M160 12v40M160 268v40M12 160h40M268 160h40" />
      <path d="M55 55l26 26M239 239l26 26M265 55l-26 26M81 239l-26 26" />
    </g>
    <g stroke="${strokeAccent}" stroke-width="1.25">
      <path d="M160 56 264 160 160 264 56 160 160 56Z" />
      <rect x="114" y="114" width="92" height="92" rx="4" />
      <path d="M160 92v136M92 160h136" stroke-dasharray="3 4" />
    </g>
    <circle cx="160" cy="160" r="18" stroke="${strokeMain}" stroke-width="1.25" />
    <circle cx="160" cy="160" r="4" fill="${strokeAccent}" />
  </svg>`;

  const cornerTicks = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" class="absolute inset-0 w-full h-full" style="opacity: ${tickOpacity};">
    <path d="M3 6V3h3M94 3h3v3M3 94v3h3M97 94v3h-3" stroke="${strokeMain}" stroke-width="0.35" vector-effect="non-scaling-stroke" />
  </svg>`;

  if (variant === 'corner') {
    return `<div class="no-print sila-watermark-layer pointer-events-none select-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      ${cornerTicks}
      <div class="absolute -right-14 -bottom-14 sm:-right-10 sm:-bottom-10">
        ${sealSvg}
      </div>
    </div>`;
  }

  return `<div class="no-print sila-watermark-layer pointer-events-none select-none absolute inset-0 z-0 overflow-hidden flex items-center justify-center" aria-hidden="true">
    ${cornerTicks}
    ${sealSvg}
  </div>`;
}
