// Small strict CSV: quotes, escaped quotes, CRLF, BOM. Errors carry the line number so a person can fix the file.

export class CsvError extends Error {}

export function parseCsv(text, { maxRows = 20000 } = {}) {
  const src = String(text).replace(/^﻿/, "");
  const records = [];
  let row = [], cell = "", inQuotes = false, line = 1, startLine = 1, i = 0;
  const pushRow = () => { row.push(cell); cell = ""; if (!(row.length === 1 && row[0] === "")) records.push({ cells: row, line: startLine }); row = []; startLine = line + 1; };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (ch === "\n") line++;
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushRow(); line++; startLine = line; i++; continue; }
    cell += ch; i++;
  }
  if (inQuotes) throw new CsvError(`Unterminated quote starting near line ${startLine}`);
  if (cell !== "" || row.length) pushRow();
  if (!records.length) throw new CsvError("The CSV is empty");
  const header = records[0].cells.map((h) => h.trim());
  if (new Set(header).size !== header.length) throw new CsvError("The header has duplicate column names");
  if (records.length - 1 > maxRows) throw new CsvError(`Too many rows (limit ${maxRows})`);
  const rows = records.slice(1).map((r) => {
    if (r.cells.length !== header.length) throw new CsvError(`Line ${r.line}: expected ${header.length} columns, found ${r.cells.length}`);
    return { line: r.line, ...Object.fromEntries(header.map((h, k) => [h, r.cells[k].trim()])) };
  });
  return { header, rows };
}

// Cells that start with = + - @ are prefixed so a spreadsheet never runs them as formulas (plain numbers are left alone).
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const cellOut = (v) => {
  let s = v == null ? "" : String(v);
  if (FORMULA.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (columns, rows) => [columns.join(","), ...rows.map((r) => columns.map((c) => cellOut(r[c])).join(","))].join("\n") + "\n";
