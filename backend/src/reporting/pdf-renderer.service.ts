import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { ReportDocument } from './report-document.types';

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
        if (pdf.y > 700) {
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
          pdf.font('Helvetica-Bold').text(table.headers.join('  |  ')).font('Helvetica');
          for (const row of table.rows) {
            pdf.text(row.join('  |  '));
          }
        }
        pdf.moveDown();
      }

      pdf.end();
    });
  }
}
