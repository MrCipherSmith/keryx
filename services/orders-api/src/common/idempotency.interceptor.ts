import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Request } from "express";
import { from, Observable, of, switchMap } from "rxjs";
import { Repository } from "typeorm";
import { IdempotencyRecord } from "./idempotency-record.entity";

/** Replays the stored response when the same Idempotency-Key arrives again for the same route. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@InjectRepository(IdempotencyRecord) private readonly records: Repository<IdempotencyRecord>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.header("Idempotency-Key");
    if (!key || key.length > 64) throw new BadRequestException("Idempotency-Key header is required");
    const scope = req.method + " " + req.route.path;

    return from(this.records.findOneBy({ key, scope })).pipe(
      switchMap((hit) => {
        if (hit) return of(hit.response);
        return next.handle().pipe(
          switchMap((response) => from(this.records.insert({ key, scope, response }).then(() => response))),
        );
      }),
    );
  }
}
