import { parseCsv, parseUpload, MAX_UPLOAD_EVENTS, TEMPLATE_COLUMNS } from './usage-upload';

const PROJECT = '5bcb3de7-45f3-4ed6-b8be-31ea34eff490';
const ok = (content: string, file = 'run.csv') => {
  const r = parseUpload(content, file, PROJECT);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('parseCsv', () => {
  it('handles quoted fields, doubled quotes, CRLF and a missing final newline', () => {
    expect(parseCsv('a,b,c\r\n"x, y","he said ""hi""",3\n1,,2')).toEqual({
      rows: [
        ['a', 'b', 'c'],
        ['x, y', 'he said "hi"', '3'],
        ['1', '', '2'],
      ],
    });
  });

  it('reports an unterminated quote', () => {
    expect(parseCsv('a\n"oops')).toEqual({ error: 'The CSV has an unterminated quoted field.' });
  });
});

describe('parseUpload', () => {
  const header = 'event_id,timestamp,provider,model,operation_type,input_tokens,output_tokens,service_id';

  it('reads CSV with the spec §10 column names and converts numbers', () => {
    const r = ok(`${header}\ne1,2026-09-25T10:00:00Z,managed_api_tier,mid,chat,1200,300,claims-api\n\ne2,2026-09-25T10:01:00Z,openai,emb,embeddings,40,,claims-api\n`);
    expect(r.format).toBe('csv');
    expect(r.received).toBe(2); // the blank line is skipped
    expect(r.rejections).toEqual([]);
    expect(r.events[0]).toEqual(expect.objectContaining({ eventId: 'e1', inputTokens: 1200, outputTokens: 300, serviceId: 'claims-api' }));
    expect(r.events[1].outputTokens).toBeUndefined();
    expect(r.eventRows).toEqual([1, 2]);
  });

  it('reads JSON as an array or { events }, with either naming style', () => {
    const e = { eventId: 'e1', timestamp: '2026-09-25T10:00:00Z', provider: 'p', model: 'm', operation_type: 'chat', input_tokens: 5 };
    expect(ok(JSON.stringify([e]), 'run.json').events[0]).toEqual(expect.objectContaining({ operationType: 'chat', inputTokens: 5 }));
    expect(ok(JSON.stringify({ events: [e] }), 'run.json').format).toBe('json');
  });

  it('rejects rows individually, with their row number and the reason', () => {
    const r = ok(
      [
        header,
        'e1,2026-09-25T10:00:00Z,p,m,chat,10,1,claims-api',
        'e2,not-a-date,p,m,chat,10,1,claims-api',
        'e3,2026-09-25T10:00:00Z,p,m,chat,ten,1,claims-api',
        'e4,2026-09-25T10:00:00Z,p,m,chat,10,1,patient John asked about his diagnosis',
      ].join('\n'),
    );
    expect(r.events.map((e) => e.eventId)).toEqual(['e1']);
    expect(r.rejections.map((x) => [x.row, x.eventId])).toEqual([
      [2, 'e2'],
      [3, 'e3'],
      [4, 'e4'],
    ]);
    expect(r.rejections[0].reason).toMatch(/timestamp/);
    expect(r.rejections[1].reason).toBe('input_tokens is not a number');
    expect(r.rejections[2].reason).toMatch(/^service_id must be an identifier/);
  });

  it('refuses raw prompt or response columns (spec §18)', () => {
    const r = ok(`${header},prompt\ne1,2026-09-25T10:00:00Z,p,m,chat,10,1,svc,What is my diagnosis?`);
    expect(r.events).toEqual([]);
    expect(r.rejections[0].reason).toMatch(/prompt should not exist/);
  });

  it('ignores server-set columns (cost, source) and refuses rows for another project', () => {
    const r = ok(`${header},estimated_total_cost,telemetry_source,project_id\ne1,2026-09-25T10:00:00Z,p,m,chat,10,1,svc,999,live,${PROJECT}\ne2,2026-09-25T10:00:00Z,p,m,chat,10,1,svc,,,other-project`);
    expect(r.events.map((e) => e.eventId)).toEqual(['e1']);
    expect(r.ignoredFields.sort()).toEqual(['estimated_total_cost', 'project_id', 'telemetry_source']);
    expect(r.rejections).toEqual([{ row: 2, eventId: 'e2', reason: 'project_id other-project is not this project' }]);
  });

  it.each([
    ['invalid JSON', '{"events": [', 'run.json', /Not valid JSON/],
    ['a JSON object without events', '{"x": 1}', 'run.json', /array of events/],
    ['an empty CSV', '', 'run.csv', /no header|no events/],
    ['a header with no rows', 'event_id,timestamp\n', 'run.csv', /no events/],
  ])('refuses %s as a whole', (_, content, file, msg) => {
    const r = parseUpload(content, file, PROJECT);
    expect('error' in r && r.error).toMatch(msg);
  });

  it('caps the number of events per upload', () => {
    const rows = Array.from({ length: MAX_UPLOAD_EVENTS + 1 }, () => ({}));
    expect((parseUpload(JSON.stringify(rows), 'big.json', PROJECT) as { error: string }).error).toMatch(/limit is 100,000/);
  });

  it('provides a template whose every column parses', () => {
    const r = ok(`${TEMPLATE_COLUMNS.join(',')}\n`.replace(/\n$/, '\ne1,2026-09-25T10:00:00Z' + ',' .repeat(TEMPLATE_COLUMNS.length - 2)));
    // Only the required columns are empty, so the row is rejected - but no column is unknown.
    expect(r.rejections[0].reason).not.toMatch(/should not exist/);
  });
});
