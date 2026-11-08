import { InvalidRequestError, LotNotFoundError } from "../model/errors.ts";
import type { Lot } from "../model/lot.ts";
import type { LotRepository } from "../repository/lot-repository.ts";

const LOT_NO = /^[A-Za-z0-9._-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class LotService {
  readonly #lots: LotRepository;

  constructor(deps: { lots: LotRepository }) {
    this.#lots = deps.lots;
  }

  async get(lotNo: string): Promise<Lot> {
    const lot = await this.#lots.findByLotNo(lotNo);
    if (!lot) throw new LotNotFoundError(`ロット ${lotNo} が見つかりません`);
    return lot;
  }

  /** 登録または更新。印刷済みラベルは当時の内容を保存しているので、更新しても過去の記録は変わらない */
  async save(lot: Lot): Promise<Lot> {
    if (!LOT_NO.test(lot.lotNo)) {
      throw new InvalidRequestError("lotNo は英数字と . _ - の 1〜64 文字で指定してください");
    }
    if (!lot.itemCode.trim() || !lot.itemName.trim()) {
      throw new InvalidRequestError("itemCode と itemName は必須です");
    }
    if (!DATE.test(lot.manufacturedOn) || (lot.expiresOn !== null && !DATE.test(lot.expiresOn))) {
      throw new InvalidRequestError("日付は YYYY-MM-DD 形式で指定してください");
    }
    if (lot.expiresOn !== null && lot.expiresOn < lot.manufacturedOn) {
      throw new InvalidRequestError("期限は製造日以降にしてください");
    }
    if (!Number.isInteger(lot.quantity) || lot.quantity < 1) {
      throw new InvalidRequestError("quantity は 1 以上の整数で指定してください");
    }
    await this.#lots.save(lot);
    return lot;
  }
}
