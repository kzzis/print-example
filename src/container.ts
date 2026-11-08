// 組み立て(依存の注入)。インターフェースだけを受け取るので、本番・テストで部品を差し替えられる。
import type { AppControllers } from "./app.ts";
import { LotController } from "./controller/lot-controller.ts";
import { PrintJobController } from "./controller/print-job-controller.ts";
import type { LabelPrinter } from "./gateway/label-printer.ts";
import type { LotRepository } from "./repository/lot-repository.ts";
import type { PrintJobRepository } from "./repository/print-job-repository.ts";
import type { LabelRenderer } from "./renderer/label-renderer.ts";
import { DispatchService } from "./service/dispatch-service.ts";
import { KeyedMutex } from "./service/keyed-mutex.ts";
import { LotService } from "./service/lot-service.ts";
import { MaintenanceService } from "./service/maintenance-service.ts";
import { PrintJobService } from "./service/print-job-service.ts";
import type { Clock, IdGenerator } from "./support/clock.ts";

export interface ContainerDeps {
  lots: LotRepository;
  jobs: PrintJobRepository;
  printer: LabelPrinter;
  renderer: LabelRenderer;
  clock: Clock;
  ids: IdGenerator;
}

export function createContainer(deps: ContainerDeps) {
  const dispatch = new DispatchService({ ...deps, locks: new KeyedMutex() });
  const lotService = new LotService(deps);
  const printJobService = new PrintJobService({ ...deps, dispatch });
  const maintenance = new MaintenanceService(deps);

  const controllers: AppControllers = {
    lots: new LotController(lotService),
    printJobs: new PrintJobController(printJobService, maintenance),
  };
  return { controllers, maintenance, lotService, printJobService };
}
