import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
