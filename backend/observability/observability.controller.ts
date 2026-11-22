import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AdminAuthGuard, AdminRoles } from "../admin/admin-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ObservabilityService } from "./observability.service";

@Controller("_panel")
@UseGuards(AdminAuthGuard)
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get("api/observability/overview")
  @AdminRoles("ADMIN", "SUPER_ADMIN")
  overview() { return this.observability.getOverview(); }

  @Get("api/observability/logs")
  @AdminRoles("ADMIN", "SUPER_ADMIN")
  logs(@Query() query: { level?: string; source?: string; search?: string; page?: string; limit?: string }) {
    return this.observability.getLogs({ ...query, page: Number(query.page) || 1, limit: Number(query.limit) || 50 });
  }

  @Get("api/observability/stress-tests")
  @AdminRoles("ADMIN", "SUPER_ADMIN")
  stressTests() { return this.observability.getStressTests(); }

  @Post("api/observability/stress-tests")
  @AdminRoles("SUPER_ADMIN")
  startStressTest(@Body() body: { duration?: number; concurrency?: number; target?: string }, @CurrentUser("sub") adminId: string) {
    return this.observability.startStressTest({ ...body, requestedBy: adminId });
  }
}
