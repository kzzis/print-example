export class DomainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidRequestError extends DomainError {}
export class InvalidTransitionError extends DomainError {}
export class LotNotFoundError extends DomainError {}
export class JobNotFoundError extends DomainError {}
export class UnknownPrinterError extends DomainError {}

/** 印刷前の確認で「今は送れない」と分かった(用紙切れ・カバー開放・接続不可など)。ジョブは未送信 */
export class PrinterNotReadyError extends DomainError {
  readonly reasons: readonly string[];
  constructor(printer: string, reasons: readonly string[]) {
    super(`プリンター ${printer} は未準備です: ${reasons.join(", ")}`);
    this.reasons = reasons;
  }
}

/** プリンターが受け付けなかったことが確実(未印刷)。再送しても二重にならない */
export class DeliveryRejectedError extends DomainError {}

/** 送ったが受理されたか分からない(タイムアウト等)。自動再送してはいけない */
export class DeliveryUncertainError extends DomainError {}
