import type { DatabaseSync } from "node:sqlite";
import type { LotRepository } from "../lot-repository.ts";
import type { Lot } from "../../model/lot.ts";

interface LotRow {
  lot_no: string;
  item_code: string;
  item_name: string;
  manufactured_on: string;
  expires_on: string | null;
  quantity: number;
}

export class SqliteLotRepository implements LotRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async findByLotNo(lotNo: string): Promise<Lot | undefined> {
    const row = this.#db.prepare("SELECT * FROM lot WHERE lot_no = ?").get(lotNo) as
      | LotRow
      | undefined;
    return row && {
      lotNo: row.lot_no,
      itemCode: row.item_code,
      itemName: row.item_name,
      manufacturedOn: row.manufactured_on,
      expiresOn: row.expires_on,
      quantity: row.quantity,
    };
  }

  async save(lot: Lot): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO lot (lot_no, item_code, item_name, manufactured_on, expires_on, quantity)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lot_no) DO UPDATE SET
           item_code = excluded.item_code, item_name = excluded.item_name,
           manufactured_on = excluded.manufactured_on, expires_on = excluded.expires_on,
           quantity = excluded.quantity`,
      )
      .run(lot.lotNo, lot.itemCode, lot.itemName, lot.manufacturedOn, lot.expiresOn, lot.quantity);
  }
}
