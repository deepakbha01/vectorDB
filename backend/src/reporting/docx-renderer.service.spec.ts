import { DocxRendererService } from './docx-renderer.service';
import { ReportDocument } from './report-document.types';

describe('DocxRendererService', () => {
  it('renders a real DOCX (a ZIP archive - starts with the PK magic bytes)', async () => {
    const doc: ReportDocument = {
      title: 'Test Report',
      subtitle: 'A subtitle',
      generatedAt: new Date().toISOString(),
      sections: [
        {
          heading: 'Section 1',
          paragraphs: ['Some paragraph text.'],
          fields: [{ label: 'Key', value: 'Value' }],
          lists: [{ title: 'A list', items: ['item 1', 'item 2'] }],
          tables: [{ headers: ['A', 'B'], rows: [['1', '2']] }],
        },
      ],
    };

    const buffer = await new DocxRendererService().render(doc);

    expect(buffer[0]).toBe(0x50); // 'P'
    expect(buffer[1]).toBe(0x4b); // 'K'
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('handles a report with no sections without throwing', async () => {
    const doc: ReportDocument = { title: 'Empty', generatedAt: new Date().toISOString(), sections: [] };
    const buffer = await new DocxRendererService().render(doc);
    expect(buffer[0]).toBe(0x50);
  });
});
