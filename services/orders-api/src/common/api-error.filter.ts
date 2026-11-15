import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}

/** Turns every thrown error into the ApiError envelope. Unknown errors become a bare 500. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const details = typeof body === "object" ? (body as { message?: unknown }).message : undefined;
      const error: ApiError = { code: codeFor(status), message: exception.message, details, requestId };
      res.status(status).json(error);
      return;
    }

    this.logger.error({ requestId, err: exception });
    const error: ApiError = { code: "INTERNAL", message: "Internal error", requestId };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(error);
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400: return "VALIDATION_FAILED";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    default: return "HTTP_" + status;
  }
}
