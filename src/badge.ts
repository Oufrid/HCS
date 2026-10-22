// A README badge for a verified score: only ever drawn from a certificate that is current and signed by a trusted key.

export interface BadgeInput {
  fidelity: number;
  model: string;
  /** Optional: confidence interval, shown when given. */
  ci95?: [number, number];
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough text width for the 11px Verdana used by shields-style badges. */
const width = (s: string) => Math.round(s.length * 6.6 + 10);

export function badgeSvg(b: BadgeInput): string {
  const label = "HCS fidelity";
  const value = `${(b.fidelity * 100).toFixed(1)}%${b.ci95 ? ` [${(b.ci95[0] * 100).toFixed(0)}-${(b.ci95[1] * 100).toFixed(0)}]` : ""} · ${b.model}`;
  const lw = width(label);
  const vw = width(value);
  const color = b.fidelity >= 0.8 ? "#4c1" : b.fidelity >= 0.5 ? "#dfb317" : "#e05d44";
  const title = `${label}: ${value} (signed, current certificate)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${escape(title)}">
<title>${escape(title)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + vw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${lw + vw}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${escape(label)}</text><text x="${lw + vw / 2}" y="14">${escape(value)}</text>
</g>
</svg>
`;
}
