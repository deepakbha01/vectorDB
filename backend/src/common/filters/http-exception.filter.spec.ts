import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

function makeHost(request: Record<string, unknown> = { method: 'POST', url: '/api/projects' }) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('flattens a NestJS exception thrown with a plain string message to a plain string, not a nested object', () => {
    const { host, response } = makeHost();
    filter.catch(new ForbiddenException("Role 'viewer' is not permitted to perform this action."), host);

    expect(response.status).toHaveBeenCalledWith(403);
    const body = response.json.mock.calls[0][0];
    expect(typeof body.message).toBe('string');
    expect(body.message).toBe("Role 'viewer' is not permitted to perform this action.");
  });

  it('preserves a string[] message from ValidationPipe field errors', () => {
    const { host, response } = makeHost();
    filter.catch(new BadRequestException(['name must be a string', 'name should not be empty']), host);

    const body = response.json.mock.calls[0][0];
    expect(body.message).toEqual(['name must be a string', 'name should not be empty']);
  });

  it('handles a NotFoundException the same way', () => {
    const { host, response } = makeHost();
    filter.catch(new NotFoundException('No Deployment Plan has been submitted for this project yet.'), host);

    const body = response.json.mock.calls[0][0];
    expect(body.message).toBe('No Deployment Plan has been submitted for this project yet.');
  });

  it('falls back to a generic message for a non-HTTP exception, without leaking internals', () => {
    const { host, response } = makeHost();
    filter.catch(new Error('some internal database error with a connection string in it'), host);

    const body = response.json.mock.calls[0][0];
    expect(response.status).toHaveBeenCalledWith(500);
    expect(body.message).toBe('An unexpected error occurred. Please retry or contact an administrator.');
  });

  it('passes through errorCode/details when an exception body includes them, for flows the frontend must react to structurally', () => {
    const { host, response } = makeHost();
    filter.catch(
      new BadRequestException({
        message: 'Selected model dimension (3072) does not match Discovery (768). Confirm this is intentional.',
        errorCode: 'DIMENSION_MISMATCH_CONFIRMATION_REQUIRED',
        details: { discoveryDimension: 768, selectedDimension: 3072 },
      }),
      host,
    );

    const body = response.json.mock.calls[0][0];
    expect(body.errorCode).toBe('DIMENSION_MISMATCH_CONFIRMATION_REQUIRED');
    expect(body.details).toEqual({ discoveryDimension: 768, selectedDimension: 3072 });
    expect(typeof body.message).toBe('string');
  });

  it('omits errorCode/details for every ordinary exception', () => {
    const { host, response } = makeHost();
    filter.catch(new BadRequestException('Plain error.'), host);

    const body = response.json.mock.calls[0][0];
    expect(body.errorCode).toBeUndefined();
    expect(body.details).toBeUndefined();
  });

  it('always includes path and a timestamp', () => {
    const { host, response } = makeHost({ method: 'GET', url: '/api/health' });
    filter.catch(new NotFoundException('not found'), host);

    const body = response.json.mock.calls[0][0];
    expect(body.path).toBe('/api/health');
    expect(typeof body.timestamp).toBe('string');
  });
});
