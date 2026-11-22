import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PrismaModule } from "../prisma/prisma.module";
import { ObservabilityController } from "./observability.controller";
import { ObservabilityService } from "./observability.service";

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET,
      signOptions: { expiresIn: "8h" },
    }),
  ],
  controllers: [ObservabilityController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
