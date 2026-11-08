import { Hono } from "hono";
import type { LotService } from "../service/lot-service.ts";
import { int, readJsonObject, str, strOrNull } from "./validation.ts";

export class LotController {
  readonly #lots: LotService;

  constructor(lots: LotService) {
    this.#lots = lots;
  }

  routes(): Hono {
    const r = new Hono();

    // ロットの登録・更新
    r.put("/:lotNo", async (c) => {
      const b = await readJsonObject(c);
      const lot = await this.#lots.save({
        lotNo: c.req.param("lotNo"),
        itemCode: str(b, "itemCode"),
        itemName: str(b, "itemName"),
        manufacturedOn: str(b, "manufacturedOn"),
        expiresOn: strOrNull(b, "expiresOn"),
        quantity: int(b, "quantity"),
      });
      return c.json(lot);
    });

    r.get("/:lotNo", async (c) => c.json(await this.#lots.get(c.req.param("lotNo"))));

    return r;
  }
}
