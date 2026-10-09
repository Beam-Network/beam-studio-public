import { fromHundredths, toHundredths } from "../billing/credit-amount.js";
import {
  priceTransfer,
  type TransferPricer,
} from "../billing/transfer-price.js";
import type { ScheduleRecord, TransferTemplateRecord } from "./store.js";

export type PricedTransfer = TransferTemplateRecord & {
  /**
   * Credits one run costs at the published price, rounded up to 0.01, or null
   * when no price could be had ("estimate unavailable").
   */
  estimatedCreditCost: number | null;
};

export type PricedSchedule = ScheduleRecord & {
  /** Its transfer's `estimatedCreditCost`: per run, or null when unavailable. */
  estimatedCreditCost: number | null;
  /** The per-run estimate times the projected runs, or null when unavailable. */
  estimatedTotalCreditCost: number | null;
};

/**
 * What one run of a transfer costs, priced from the published price book under
 * the key the run is charged to, or null when it cannot be priced.
 *
 * Only byte totals are stored with a transfer; the price is asked here, when
 * the transfer is read, so a save never waits on or fails because of pricing.
 */
export function transferEstimate(
  transfer: TransferTemplateRecord,
  organizationId: string | null | undefined,
  pricer: TransferPricer = priceTransfer,
): Promise<number | null> {
  return pricer({
    apiKeyId: transfer.apiKeyId,
    organizationId,
    deliveredBytes: wholeBytes(transfer.totalTransferSizeBytes),
    destinationCount: transfer.destinationCount,
  });
}

/** Transfers with their `transferEstimate`, priced in parallel. */
export function priceTransfers(
  transfers: TransferTemplateRecord[],
  organizationId: string | null | undefined,
  pricer: TransferPricer = priceTransfer,
): Promise<PricedTransfer[]> {
  return Promise.all(
    transfers.map(async (transfer) => ({
      ...transfer,
      estimatedCreditCost: await transferEstimate(
        transfer,
        organizationId,
        pricer,
      ),
    })),
  );
}

/**
 * Schedules with their transfer's per-run estimate and its projection over the
 * schedule's projected runs, exact at two decimals. A schedule whose transfer
 * has no price has no estimate either: it is never shown as free.
 */
export function priceSchedules(
  schedules: ScheduleRecord[],
  transfers: PricedTransfer[],
): PricedSchedule[] {
  const perRun = new Map(
    transfers.map((transfer) => [transfer.id, transfer.estimatedCreditCost]),
  );
  return schedules.map((schedule) => {
    const estimatedCreditCost = perRun.get(schedule.transferTemplateId) ?? null;
    return {
      ...schedule,
      estimatedCreditCost,
      estimatedTotalCreditCost:
        estimatedCreditCost === null
          ? null
          : fromHundredths(
              schedule.estimatedRunCount * toHundredths(estimatedCreditCost),
            ),
    };
  });
}

function wholeBytes(bytes: number) {
  return Number.isFinite(bytes)
    ? BigInt(Math.max(0, Math.trunc(bytes))).toString()
    : "0";
}
