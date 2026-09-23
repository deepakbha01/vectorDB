import { ValidationPipe } from '@nestjs/common';
import { ImpactQueryDto } from './ai-factory.controller';

// Mirrors main.ts's global pipe so query parsing is tested exactly as it runs in the app.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const parse = (query: Record<string, string>) => pipe.transform(query, { type: 'query', metatype: ImpactQueryDto });

describe('ImpactQueryDto (through the global ValidationPipe)', () => {
  it('leaves both versions undefined when omitted (defaults to previous → latest)', async () => {
    expect(await parse({})).toEqual({});
  });

  it('parses version numbers', async () => {
    expect(await parse({ from: '1', to: '3' })).toEqual({ from: 1, to: 3 });
  });

  it.each<Record<string, string>>([{ from: 'abc' }, { to: '0' }, { from: '1.5' }, { other: '1' }])('rejects %p', async (q) => {
    await expect(parse(q)).rejects.toBeDefined();
  });
});
