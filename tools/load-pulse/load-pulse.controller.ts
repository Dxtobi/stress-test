import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { join } from "path";

@Controller("load-pulse")
export class LoadPulseController {
  @Get()
  getPage(@Res() res: Response) {
    res.sendFile(join(process.cwd(), "public", "load-pulse.html"));
  }
}
