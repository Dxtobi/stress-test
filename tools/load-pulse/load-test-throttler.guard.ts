import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class LoadTestThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = req.ips?.length ? req.ips[0] : req.ip;
    const whitelist = (process.env.RATE_LIMIT_WHITELIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (whitelist.includes(ip)) {
      return true;
    }
    return super.shouldSkip(context);
  }
}
