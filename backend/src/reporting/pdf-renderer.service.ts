import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { ReportDocument, ReportTable } from './report-document.types';

const TABLE_FONT_SIZE = 8;
const CELL_PADDING = 4;
const MIN_COLUMN_WIDTH = 40;
const HEADER_FILL = '#e8edf3';
const GRID_COLOR = '#9aa5b1';

/**
 * Column widths proportional to each column's longest cell (capped), so short
 * columns stay narrow and prose columns get room - but never narrower than the
 * column's longest single word, so words are not split mid-word.
 */
function columnWidths(pdf: PDFKit.PDFDocument, table: ReportTable, totalWidth: number): number[] {
  const cells = (i: number) => [table.headers[i], ...table.rows.map((row) => row[i] ?? '')];
  const weights = table.headers.map((_, i) => Math.min(150, Math.max(4, ...cells(i).map((c) => c.length))));
  const minimums = table.headers.map((_, i) => {
    pdf.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
    const words = cells(i).flatMap((c) => c.split(/\s+/)).filter((w) => w.length <= 20);
    return Math.max(MIN_COLUMN_WIDTH, ...words.map((w) => pdf.widthOfString(w) + CELL_PADDING * 2 + 1));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w, i) => Math.max(minimums[i], (w / sum) * totalWidth));
  // Take any overflow from columns that have room above their minimum, widest first.
  const overflow = raw.reduce((a, b) => a + b, 0) - totalWidth;
  const slack = raw.map((w, i) => w - minimums[i]);
  const totalSlack = slack.reduce((a, b) => a + b, 0);
  const fitted = overflow > 0 && totalSlack > 0 ? raw.map((w, i) => w - (slack[i] / totalSlack) * Math.min(overflow, totalSlack)) : raw;
  // Last resort (minimums alone exceed the page) or underflow: scale to fill exactly.
  const scale = totalWidth / fitted.reduce((a, b) => a + b, 0);
  return fitted.map((w) => w * scale);
}

/** Bordered grid with a shaded header row; wraps cell text and repeats the header after a page break. */
function drawTable(pdf: PDFKit.PDFDocument, table: ReportTable): void {
  const left = pdf.page.margins.left;
  const totalWidth = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const widths = columnWidths(pdf, table, totalWidth);
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;

  const rowHeight = (cells: string[], font: string) => {
    pdf.font(font).fontSize(TABLE_FONT_SIZE);
    return Math.max(...widths.map((w, i) => pdf.heightOfString(cells[i] ?? '', { width: w - CELL_PADDING * 2 }))) + CELL_PADDING * 2;
  };

  const drawRow = (cells: string[], header: boolean) => {
    const font = header ? 'Helvetica-Bold' : 'Helvetica';
    const height = rowHeight(cells, font);
    const top = pdf.y;
    let x = left;
    widths.forEach((w, i) => {
      if (header) pdf.rect(x, top, w, height).fillColor(HEADER_FILL).fill();
      pdf.rect(x, top, w, height).lineWidth(0.5).strokeColor(GRID_COLOR).stroke();
      pdf.fillColor('black').font(font).fontSize(TABLE_FONT_SIZE).text(cells[i] ?? '', x + CELL_PADDING, top + CELL_PADDING, { width: w - CELL_PADDING * 2 });
      x += w;
    });
    pdf.x = left;
    pdf.y = top + height;
  };

  if (pdf.y + rowHeight(table.headers, 'Helvetica-Bold') * 2 > bottom()) pdf.addPage();
  drawRow(table.headers, true);
  for (const row of table.rows) {
    if (pdf.y + rowHeight(row, 'Helvetica') > bottom()) {
      pdf.addPage();
      drawRow(table.headers, true);
    }
    drawRow(row, false);
  }
  pdf.x = left;
  if (table.footnote) {
    pdf.moveDown(0.3).font('Helvetica-Oblique').fontSize(7.5).fillColor('#4a5563').text(table.footnote, left, pdf.y, { width: totalWidth });
  }
  pdf.font('Helvetica').fontSize(10).fillColor('black');
  pdf.x = left;
  pdf.moveDown(0.5);
}

@Injectable()
export class PdfRendererService {
  async render(doc: ReportDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const pdf = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      pdf.on('data', (chunk) => chunks.push(chunk));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);

      pdf.fontSize(20).fillColor('black').text(doc.title);
      if (doc.subtitle) {
        pdf.fontSize(12).fillColor('gray').text(doc.subtitle);
      }
      pdf.fontSize(8).fillColor('gray').text(`Generated ${doc.generatedAt}`);
      pdf.fillColor('black').moveDown();

      for (const section of doc.sections) {
        // Keep a heading with the start of its content instead of stranding it at the foot of a page.
        if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 110) {
          pdf.addPage();
        }
        pdf.fontSize(14).text(section.heading, { underline: true });
        pdf.moveDown(0.3);
        pdf.fontSize(10);

        for (const paragraph of section.paragraphs ?? []) {
          pdf.font('Courier').fontSize(8).text(paragraph, { width: 500 });
          pdf.font('Helvetica').fontSize(10).moveDown(0.3);
        }
        for (const field of section.fields ?? []) {
          pdf.text(`${field.label}: ${field.value}`);
        }
        for (const list of section.lists ?? []) {
          if (list.title) {
            pdf.font('Helvetica-Bold').text(list.title).font('Helvetica');
          }
          for (const item of list.items) {
            pdf.text(`• ${item}`, { indent: 10 });
          }
        }
        for (const table of section.tables ?? []) {
          if (table.title) {
            pdf.font('Helvetica-Bold').text(table.title).font('Helvetica');
          }
          drawTable(pdf, table);
        }
        pdf.moveDown();
      }

      pdf.end();
    });
  }
}
