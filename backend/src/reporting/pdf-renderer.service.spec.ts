import { PdfRendererService } from './pdf-renderer.service';
import { ReportDocument } from './report-document.types';

describe('PdfRendererService', () => {
  it('renders a real PDF (starts with the %PDF magic bytes)', async () => {
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

    const buffer = await new PdfRendererService().render(doc);

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('handles a report with no sections without throwing', async () => {
    const doc: ReportDocument = { title: 'Empty', generatedAt: new Date().toISOString(), sections: [] };
    const buffer = await new PdfRendererService().render(doc);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('paginates when many sections are added', async () => {
    const doc: ReportDocument = {
      title: 'Long report',
      generatedAt: new Date().toISOString(),
      sections: Array.from({ length: 40 }, (_, i) => ({ heading: `Section ${i}`, paragraphs: ['x'.repeat(50)] })),
    };
    const buffer = await new PdfRendererService().render(doc);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
