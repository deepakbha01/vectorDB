import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePerformanceAssessmentDto } from './create-performance-assessment.dto';

// Mirrors main.ts's global pipe so the body is validated exactly as it is in the app.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const parse = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreatePerformanceAssessmentDto });

describe('CreatePerformanceAssessmentDto (through the global ValidationPipe)', () => {
  it('accepts a measurement with its source', async () => {
    const dto = await parse({ measurements: [{ metric: 'ttft_p95', value: 650, source: 'vLLM benchmark_serving', measuredAt: '2026-09-01' }] });
    expect(dto.measurements[0]).toMatchObject({ metric: 'ttft_p95', value: 650 });
  });

  it.each([
    ['no source - no evidence, no measurement', { metric: 'ttft_p95', value: 650 }],
    ['an unknown metric', { metric: 'vibes', value: 1, source: 'gut feel' }],
    ['a non-numeric value', { metric: 'qps', value: 'fast', source: 'load test' }],
    ['an invalid date', { metric: 'qps', value: 100, source: 'load test', measuredAt: 'last week' }],
    ['an unexpected field', { metric: 'qps', value: 100, source: 'load test', passed: true }],
  ])('rejects %s', async (_n, m) => {
    await expect(parse({ measurements: [m] })).rejects.toBeInstanceOf(BadRequestException);
  });
});
