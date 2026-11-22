// US-only normalization (the brief is ZIP-based). Returns null when the value is not a valid NANP number.
export function normalizePhone(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null; // NANP: area code and exchange start 2-9
  return `+1${d}`;
}

export function normalizeEmail(raw) {
  if (raw == null) return null;
  const e = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254 ? e : null;
}
