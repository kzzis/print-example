export interface Lot {
  lotNo: string;
  itemCode: string;
  itemName: string;
  /** YYYY-MM-DD */
  manufacturedOn: string;
  /** YYYY-MM-DD。期限なしは null */
  expiresOn: string | null;
  quantity: number;
}
