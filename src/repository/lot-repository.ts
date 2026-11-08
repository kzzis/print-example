import type { Lot } from "../model/lot.ts";

export interface LotRepository {
  findByLotNo(lotNo: string): Promise<Lot | undefined>;
  save(lot: Lot): Promise<void>;
}
