/** Minimal text-only PDF writer (A4, Helvetica, auto page breaks). Enough for printable reports with no dependencies. */
const esc = (s: string) => s.replace(/[^\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function textPdf(title: string, lines: string[]): Buffer {
  const perPage = 52;
  const pages: string[][] = [];
  const all = [title, '', ...lines];
  for (let i = 0; i < all.length; i += perPage) pages.push(all.slice(i, i + perPage));
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages placeholder (object 2)
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const pg of pages) {
    const stream = 'BT /F1 10 Tf 40 800 Td 14 TL\n' + pg.map((l) => `(${esc(l.slice(0, 110))}) Tj T*`).join('\n') + '\nET';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
