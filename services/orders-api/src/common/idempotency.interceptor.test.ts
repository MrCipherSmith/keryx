import { BadRequestException, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import type { Repository } from "typeorm";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import type { IdempotencyRecord } from "./idempotency-record.entity";

function contextFor(headers: Record<string, string>): ExecutionContext {
  const req = {
    method: "POST",
    route: { path: "/v1/orders" },
    header: (name: string) => headers[name],
  };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function setup(stored: Partial<IdempotencyRecord> | null) {
  const records = {
    findOneBy: jest.fn().mockResolvedValue(stored),
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const handler: CallHandler = { handle: jest.fn(() => of({ id: "fresh" })) };
  const interceptor = new IdempotencyInterceptor(records as unknown as Repository<IdempotencyRecord>);
  return { records, handler, interceptor };
}

describe("IdempotencyInterceptor", () => {
  it("refuses a request without the header", () => {
    const { interceptor, handler } = setup(null);

    expect(() => interceptor.intercept(contextFor({}), handler)).toThrow(BadRequestException);
  });

  it("refuses a key longer than 64 characters", () => {
    const { interceptor, handler } = setup(null);

    expect(() => interceptor.intercept(contextFor({ "Idempotency-Key": "k".repeat(65) }), handler)).toThrow(BadRequestException);
  });

  it("replays the stored response and does not run the handler again", async () => {
    const { interceptor, handler, records } = setup({ response: { id: "stored" } });

    const result = await firstValueFrom(interceptor.intercept(contextFor({ "Idempotency-Key": "abc" }), handler));

    expect(result).toEqual({ id: "stored" });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(records.insert).not.toHaveBeenCalled();
  });

  it("runs the handler once and stores what it returned", async () => {
    const { interceptor, handler, records } = setup(null);

    const result = await firstValueFrom(interceptor.intercept(contextFor({ "Idempotency-Key": "abc" }), handler));

    expect(result).toEqual({ id: "fresh" });
    expect(records.insert).toHaveBeenCalledWith({ key: "abc", scope: "POST /v1/orders", response: { id: "fresh" } });
  });
});
