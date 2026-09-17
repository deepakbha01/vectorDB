import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Normalizes every thrown error into a single, actionable JSON shape so
 * frontend and API consumers never have to guess the error format.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse: unknown = exception instanceof HttpException ? exception.getResponse() : undefined;

    // Nest's built-in exceptions (BadRequestException, ForbiddenException, ...) return an object
    // shaped like { statusCode, message, error } from getResponse() - not the plain string every
    // caller in this codebase passes in. Unwrap that inner `message` so API consumers always get
    // a string (or a string[] for ValidationPipe's field-level errors), never a nested object -
    // rendering an object directly crashed the frontend (blank page) rather than showing an error.
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : exceptionResponse && typeof exceptionResponse === 'object' && 'message' in exceptionResponse
          ? (exceptionResponse as { message: string | string[] }).message
          : exceptionResponse ?? 'An unexpected error occurred. Please retry or contact an administrator.';

    this.logger.error(
      `${request.method} ${request.url} -> ${status}: ${JSON.stringify(message)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      message,
    });
  }
}
