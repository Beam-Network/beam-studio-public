import assert from "node:assert/strict";
import test from "node:test";
import { CreditClient } from "./credit-client.js";
import { createTransferPricer, transferUsage } from "./transfer-price.js";
import {
  priceSchedules,
  transferEstimate,
} from "../studio/transfer-estimates.js";
import type {
  ScheduleRecord,
  TransferTemplateRecord,
} from "../studio/store.js";

type QuoteBody = {
  billingProfileId: string;
  usage: Array<{
    metric: string;
    quantity: string | number;
    attributes?: Record<string, string>;
  }>;
};

/** A Beam answering `beam.transfer.v1` at 0.01 credit per GB, no minimum. */
function publishedPrice(options: { fail?: () => boolean } = {}) {
  const requests: QuoteBody[] = [];
  const client = new CreditClient({
    apiUrl: "https://api.test",
    fetch: (async (input: URL, init: RequestInit) => {
      assert.equal(new URL(String(input)).pathname, "/v1/pricing/quote");
      const body = JSON.parse(String(init.body)) as QuoteBody;
      requests.push(body);
      if (options.fail?.())
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: "down" }),
        };
      const bandwidth = body.usage.find(
        (record) => record.metric === "bandwidth",
      );
      const microcredits =
        (BigInt(bandwidth?.quantity ?? 0) * 10_000n + 999_999_999n) /
        1_000_000_000n;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          credits: Number(microcredits) / 1_000_000,
        }),
      };
    }) as never,
  });
  return { client: () => client, requests };
}

const rawKey = (apiKeyId: string) => (apiKeyId === "key_1" ? "b1m_raw" : null);

test("a transfer is priced from the published quote, rounded up to 0.01", async () => {
  const beam = publishedPrice();
  const price = createTransferPricer({
    client: beam.client,
    resolveApiKey: rawKey,
  });

  const input = (deliveredBytes: string) => ({
    apiKeyId: "key_1",
    organizationId: "org_1",
    deliveredBytes,
    destinationCount: 1,
  });
  assert.equal(await price(input(String(1024 ** 3))), 0.02);
  assert.equal(await price(input("100000000000")), 1);
  assert.equal(await price(input("0")), 0);

  assert.equal(beam.requests[0]?.billingProfileId, "beam.transfer.v1");
  assert.deepEqual(
    beam.requests[0]?.usage,
    transferUsage(String(1024 ** 3), 1),
  );
});

test("a quote is reused per key and usage until it expires", async () => {
  const beam = publishedPrice();
  let clock = 0;
  const price = createTransferPricer({
    client: beam.client,
    resolveApiKey: rawKey,
    ttlMs: 1_000,
    now: () => clock,
  });
  const input = {
    apiKeyId: "key_1",
    deliveredBytes: "5000000000",
    destinationCount: 1,
  };

  assert.equal(await price(input), 0.05);
  assert.equal(await price(input), 0.05);
  assert.equal(beam.requests.length, 1);
  assert.equal(await price({ ...input, destinationCount: 2 }), 0.05);
  assert.equal(beam.requests.length, 2);

  clock = 1_000;
  assert.equal(await price(input), 0.05);
  assert.equal(beam.requests.length, 3);
});

test("no price is null, never remembered, and never throws", async () => {
  let down = true;
  const beam = publishedPrice({ fail: () => down });
  const price = createTransferPricer({
    client: beam.client,
    resolveApiKey: rawKey,
  });
  const input = {
    apiKeyId: "key_1",
    deliveredBytes: "1000000000",
    destinationCount: 1,
  };

  assert.equal(await price(input), null);
  down = false;
  assert.equal(await price(input), 0.01);
  assert.equal(beam.requests.length, 2);

  // No key selected, or one Studio cannot read, is unavailable too.
  assert.equal(await price({ ...input, apiKeyId: "" }), null);
  assert.equal(await price({ ...input, apiKeyId: "key_unknown" }), null);
  assert.equal(beam.requests.length, 2);
});

test("a read does not wait on a slow quote beyond its timeout", async () => {
  let answer: (credits: number) => void = () => {};
  const slow = new Promise<number>((resolve) => (answer = resolve));
  const price = createTransferPricer({
    client: () =>
      ({ quote: async () => ({ credits: await slow, charges: [] }) }) as never,
    resolveApiKey: rawKey,
    timeoutMs: 10,
  });
  const input = { apiKeyId: "key_1", deliveredBytes: "1", destinationCount: 1 };

  assert.equal(await price(input), null);
  answer(0.01);
  // The quote kept going and the next read reuses it.
  assert.equal(await price(input), 0.01);
});

test("a schedule's estimate is its transfer's price times its projected runs", async () => {
  const transfer = {
    id: "tt_1",
    apiKeyId: "key_1",
    totalTransferSizeBytes: 2 * 1024 ** 3,
    destinationCount: 2,
  } as TransferTemplateRecord;
  const seen: unknown[] = [];
  const estimate = await transferEstimate(transfer, "org_1", async (input) => {
    seen.push(input);
    return 0.03;
  });
  assert.equal(estimate, 0.03);
  assert.deepEqual(seen, [
    {
      apiKeyId: "key_1",
      organizationId: "org_1",
      deliveredBytes: String(2 * 1024 ** 3),
      destinationCount: 2,
    },
  ]);

  const schedule = (transferTemplateId: string) =>
    ({
      id: `sch_${transferTemplateId}`,
      transferTemplateId,
      estimatedRunCount: 7,
    }) as ScheduleRecord;
  const [priced, unpriced, orphan] = priceSchedules(
    [schedule("tt_1"), schedule("tt_2"), schedule("tt_3")],
    [
      { ...transfer, estimatedCreditCost: 0.07 },
      { ...transfer, id: "tt_2", estimatedCreditCost: null },
    ],
  );
  // 7 x 0.07 is 0.49000000000000005 in floating point.
  assert.equal(priced?.estimatedCreditCost, 0.07);
  assert.equal(priced?.estimatedTotalCreditCost, 0.49);
  assert.equal(unpriced?.estimatedCreditCost, null);
  assert.equal(unpriced?.estimatedTotalCreditCost, null);
  assert.equal(orphan?.estimatedTotalCreditCost, null);
});
