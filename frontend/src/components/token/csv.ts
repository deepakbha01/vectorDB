/** Minimal CSV export for token / cost summaries (spec §19). Everything is built client-side from what the page already shows. */

type Cell = string | number | boolean | null | undefined;

const esc = (v: Cell) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(sections: Array<{ title: string; headers: string[]; rows: Cell[][] }>): string {
  return sections.map((s) => [s.title, s.headers.map(esc).join(','), ...s.rows.map((r) => r.map(esc).join(','))].join('\n')).join('\n\n');
}

export function download(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
