/** Request counts as people read them: 950, 8200, 12k, 1.3M. */
export const fmtRequests = (n: number): string => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
