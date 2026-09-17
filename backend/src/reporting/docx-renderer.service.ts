import { Injectable } from '@nestjs/common';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { ReportDocument } from './report-document.types';

@Injectable()
export class DocxRendererService {
  async render(doc: ReportDocument): Promise<Buffer> {
    const children: Array<Paragraph | Table> = [];

    children.push(new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }));
    if (doc.subtitle) {
      children.push(new Paragraph({ text: doc.subtitle, heading: HeadingLevel.HEADING_3 }));
    }
    children.push(new Paragraph({ children: [new TextRun({ text: `Generated ${doc.generatedAt}`, italics: true, size: 16 })] }));

    for (const section of doc.sections) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));

      for (const paragraph of section.paragraphs ?? []) {
        children.push(new Paragraph({ children: [new TextRun({ text: paragraph, font: 'Courier New', size: 16 })] }));
      }
      for (const field of section.fields ?? []) {
        children.push(new Paragraph({ children: [new TextRun({ text: `${field.label}: `, bold: true }), new TextRun(field.value)] }));
      }
      for (const list of section.lists ?? []) {
        if (list.title) {
          children.push(new Paragraph({ text: list.title, heading: HeadingLevel.HEADING_3 }));
        }
        for (const item of list.items) {
          children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
        }
      }
      for (const table of section.tables ?? []) {
        if (table.title) {
          children.push(new Paragraph({ text: table.title, heading: HeadingLevel.HEADING_3 }));
        }
        children.push(
          new Table({
            rows: [
              new TableRow({
                children: table.headers.map((h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })),
              }),
              ...table.rows.map(
                (row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })) }),
              ),
            ],
          }),
        );
      }
    }

    const document = new Document({ sections: [{ children }] });
    return Packer.toBuffer(document);
  }
}
