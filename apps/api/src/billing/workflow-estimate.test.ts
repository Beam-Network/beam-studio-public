import assert from "node:assert/strict";
import test from "node:test";
import { ActionNotBillableError } from "./action-gate.js";
import {
  CreditClient,
  parseAvailableCredits,
  parseQuoteCredits,
} from "./credit-client.js";
import { estimateWorkflowCredits } from "./workflow-estimate.js";

type Recorded = {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Headers;
};

/**
 * How `GET /v1/credits/available` answers: a status and body, a network
 * failure, or no answer at all. A Beam without the route answers 404.
 */
type BalanceAnswer =
  | { status: number; json: unknown }
  | "unreachable"
  | "no-answer";

const OLDER_BEAM: BalanceAnswer = { status: 404, json: { error: "Not Found" } };

const rawKey = () => "bm_live_raw_secret";

/**
 * A CreditClient whose HTTP layer answers quotes from the seeded price book:
 * a workflow run is a flat credit, and transfer volume is one credit per GiB
 * with a one-credit minimum.
 */
function pricedClient(
  recorded: Recorded[] = [],
  balance: BalanceAnswer = OLDER_BEAM,
) {
  const GIB = 1_073_741_824n;

  return new CreditClient({
    apiUrl: "https://api.test",
    fetch: (async (input: URL, init: RequestInit) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);

      if (new URL(url).pathname === "/v1/credits/available") {
        recorded.push({ url, method, body: {}, headers });
        if (balance === "unreachable") throw new TypeError("fetch failed");
        if (balance === "no-answer") return new Promise(() => {});
        return {
          ok: balance.status >= 200 && balance.status < 300,
          status: balance.status,
          json: async () => balance.json,
        };
      }

      const body = JSON.parse(String(init.body));
      recorded.push({ url, method, body, headers });

      const usage = body.usage as Array<{ metric: string; quantity: string | number }>;
      const bandwidth = usage.find((record) => record.metric === "bandwidth");
      const credits = bandwidth
        ? Number((BigInt(bandwidth.quantity) + GIB - 1n) / GIB) || 1
        : 1;

      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, credits, quote: { usageCharges: [] } }),
      };
    }) as never,
  });
}

test("pricing a workflow needs the key it would be charged to", async () => {
  // Without a key there is no organization, so there is no price book to read:
  // an arbitrary key's scope would answer with a price nobody pays.
  await assert.rejects(
    () => estimateWorkflowCredits({ apiKeyId: null, transfers: [] }),
    ActionNotBillableError,
  );
});

test("the run itself is priced even when the workflow moves nothing", async () => {
  const estimate = await estimateWorkflowCredits(
    { apiKeyId: "key_1", transfers: [] },
    pricedClient(),
    rawKey,
  );

  assert.equal(estimate.total, 1);
  assert.equal(estimate.atLeast, false);
  assert.deepEqual(
    estimate.lines.map((line) => [line.kind, line.credits]),
    [["workflow-run", 1]],
  );
});

test("a transfer is priced on what it delivers, not on its source size", async () => {
  // Two destinations means the source is delivered twice, and BeamCore settles
  // on delivered bytes. Pricing 10 GiB here would halve the bill.
  const estimate = await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [
        {
          stepId: "step_1",
          label: "Archive to R2",
          sourceBytes: String(10n * 1_073_741_824n),
          destinationCount: 2,
          partial: false,
        },
      ],
    },
    pricedClient(),
    rawKey,
  );

  const transfer = estimate.lines.find((line) => line.kind === "transfer");
  assert.equal(transfer?.bytes, String(20n * 1_073_741_824n));
  assert.equal(transfer?.credits, 20);
  assert.equal(estimate.total, 21);
  assert.equal(estimate.atLeast, false);
});

test("many small transfers cost their minimums, not their pooled volume", async () => {
  // Five 100 MiB transfers are five settlements, each paying the profile
  // minimum. Pooling them into one quote would answer 1 credit for work that
  // bills 5.
  const oneHundredMiB = String(104_857_600n);
  const estimate = await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: Array.from({ length: 5 }, (_, index) => ({
        stepId: `step_${index}`,
        label: `Copy ${index}`,
        sourceBytes: oneHundredMiB,
        destinationCount: 1,
        partial: false,
      })),
    },
    pricedClient(),
    rawKey,
  );

  assert.equal(estimate.total, 6);
});

test("an unsized transfer reports the floor and says the volume is unknown", async () => {
  const estimate = await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [
        {
          stepId: "step_1",
          label: "From HuggingFace",
          sourceBytes: null,
          destinationCount: 1,
          partial: false,
        },
      ],
    },
    pricedClient(),
    rawKey,
  );

  const transfer = estimate.lines.find((line) => line.kind === "transfer");
  assert.equal(transfer?.volumeUnknown, true);
  assert.equal(transfer?.bytes, null);
  // The minimum is still a real charge: an unsized transfer is never free.
  assert.equal(transfer?.credits, 1);
  assert.equal(estimate.atLeast, true);
});

test("a truncated listing makes the total a floor", async () => {
  const estimate = await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [
        {
          stepId: "step_1",
          label: "Bucket copy",
          sourceBytes: String(2n * 1_073_741_824n),
          destinationCount: 1,
          partial: true,
        },
      ],
    },
    pricedClient(),
    rawKey,
  );

  assert.equal(estimate.total, 3);
  assert.equal(estimate.atLeast, true);
});

test("identical transfers are priced once", async () => {
  const recorded: Recorded[] = [];
  await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: Array.from({ length: 4 }, (_, index) => ({
        stepId: `step_${index}`,
        label: `Copy ${index}`,
        sourceBytes: String(1_073_741_824n),
        destinationCount: 1,
        partial: false,
      })),
    },
    pricedClient(recorded),
    rawKey,
  );

  const quotes = recorded.filter((call) => call.url.endsWith("/v1/pricing/quote"));
  // One for the run, one for the four identical transfers.
  assert.equal(quotes.length, 2);
});

test("quotes authenticate with the workflow's own key and name no key id", async () => {
  const recorded: Recorded[] = [];
  await estimateWorkflowCredits(
    { apiKeyId: "key_1", transfers: [] },
    pricedClient(recorded),
    rawKey,
  );

  const quotes = recorded.filter(
    (call) => new URL(call.url).pathname === "/v1/pricing/quote",
  );
  assert.equal(quotes.length, 1);
  assert.equal(
    quotes[0]!.headers.get("authorization"),
    "Bearer bm_live_raw_secret",
  );
  assert.deepEqual([...quotes[0]!.headers.keys()].sort(), [
    "authorization",
    "content-type",
  ]);
  assert.deepEqual(quotes[0]!.body, {
    billingProfileId: "beam.workflow.v1",
    usage: [{ metric: "invocation", quantity: 1, unit: "count" }],
  });
});

test("pricing never reserves, settles or releases credit", async () => {
  const recorded: Recorded[] = [];
  await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [
        {
          stepId: "step_1",
          label: "Copy",
          sourceBytes: String(1_073_741_824n),
          destinationCount: 1,
          partial: false,
        },
      ],
    },
    pricedClient(recorded),
    rawKey,
  );

  // Asking a price must not take a hold, move a counter, or reach auto top-up.
  assert.deepEqual(
    recorded.map((call) => new URL(call.url).pathname).filter((path) => path.includes("/usage")),
    [],
  );
});

test("a transfer reports the endpoints it touches, so fan-out can be priced", async () => {
  // beam.transfer.v1 charges per destination connector. Reporting only bandwidth
  // made the estimate blind to fan-out, which is the thing that charge sells.
  const recorded: Recorded[] = [];
  await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [
        {
          stepId: "step_1",
          label: "Distribute",
          sourceBytes: "1073741824",
          destinationCount: 4,
          partial: false,
        },
      ],
    },
    pricedClient(recorded),
    rawKey,
  );

  const transferQuote = recorded.find(
    (entry) => (entry.body.billingProfileId as string) === "beam.transfer.v1",
  );
  assert.ok(transferQuote, "the transfer must be quoted");

  const usage = transferQuote.body.usage as Array<{
    metric: string;
    quantity: number | string;
    unit: string;
    attributes?: Record<string, string>;
  }>;
  const connectors = usage.filter((record) => record.metric === "connector");

  assert.equal(connectors.length, 2, "one source and one destination measure");
  assert.deepEqual(
    connectors.find((record) => record.attributes?.role === "source"),
    { metric: "connector", quantity: 1, unit: "operation", attributes: { role: "source" } },
  );
  // The full count, not count - 1. The allowance that includes the first
  // destination lives in the price book; subtracting here would apply it twice.
  assert.deepEqual(
    connectors.find((record) => record.attributes?.role === "destination"),
    { metric: "connector", quantity: 4, unit: "operation", attributes: { role: "destination" } },
  );
});

test("an unsized transfer still reports its endpoints", async () => {
  // Volume may be unknown while the shape is not: a fan-out to three places is
  // three destinations whether or not the listing completed.
  const recorded: Recorded[] = [];
  await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [
        {
          stepId: "step_1",
          label: "Distribute",
          sourceBytes: null,
          destinationCount: 3,
          partial: true,
        },
      ],
    },
    pricedClient(recorded),
    rawKey,
  );

  const transferQuote = recorded.find(
    (entry) => (entry.body.billingProfileId as string) === "beam.transfer.v1",
  );
  const usage = transferQuote?.body.usage as Array<{
    metric: string;
    quantity: number | string;
    attributes?: Record<string, string>;
  }>;

  assert.equal(
    usage.find((record) => record.attributes?.role === "destination")?.quantity,
    3,
  );
});

const oneTransfer = {
  apiKeyId: "key_1",
  transfers: [
    {
      stepId: "step_1",
      label: "Copy",
      sourceBytes: String(2n * 1_073_741_824n),
      destinationCount: 1,
      partial: false,
    },
  ],
};

test("the estimate reports what the billing key can spend", async () => {
  const recorded: Recorded[] = [];
  const estimate = await estimateWorkflowCredits(
    oneTransfer,
    pricedClient(recorded, {
      status: 200,
      json: { success: true, availableCredits: 2 },
    }),
    rawKey,
  );

  assert.equal(estimate.total, 3);
  assert.equal(estimate.availableCredits, 2);

  // Read with the same key as the quotes, as a plain GET with nothing to say.
  const balanceReads = recorded.filter(
    (call) => new URL(call.url).pathname === "/v1/credits/available",
  );
  assert.equal(balanceReads.length, 1);
  assert.equal(balanceReads[0]!.method, "GET");
  assert.deepEqual([...balanceReads[0]!.headers.entries()], [
    ["authorization", "Bearer bm_live_raw_secret"],
  ]);
});

test("a key no balance bounds reports a null balance", async () => {
  const estimate = await estimateWorkflowCredits(
    oneTransfer,
    pricedClient([], {
      status: 200,
      json: { success: true, availableCredits: null },
    }),
    rawKey,
  );

  assert.equal(estimate.availableCredits, null);
});

test("a balance that cannot be read leaves the estimate without one", async () => {
  const answers: BalanceAnswer[] = [
    OLDER_BEAM,
    { status: 401, json: { success: false, code: "api_key_authentication_required" } },
    { status: 429, json: { success: false } },
    { status: 500, json: null },
    { status: 200, json: { success: true, availableCredits: "2" } },
    { status: 200, json: { success: false, availableCredits: 2 } },
    "unreachable",
  ];

  for (const answer of answers) {
    const estimate = await estimateWorkflowCredits(
      oneTransfer,
      pricedClient([], answer),
      rawKey,
    );
    assert.equal(estimate.total, 3, JSON.stringify(answer));
    assert.equal("availableCredits" in estimate, false, JSON.stringify(answer));
  }
});

test("a balance that does not answer holds the estimate no longer than its timeout", async () => {
  const started = Date.now();
  const estimate = await estimateWorkflowCredits(
    oneTransfer,
    pricedClient([], "no-answer"),
    rawKey,
    20,
  );

  assert.equal(estimate.total, 3);
  assert.equal("availableCredits" in estimate, false);
  assert.ok(Date.now() - started < 1_000);
});

test("any finite number of credits, or null, is read as a balance", () => {
  assert.equal(parseAvailableCredits({ success: true, availableCredits: 2 }), 2);
  assert.equal(parseAvailableCredits({ success: true, availableCredits: 0 }), 0);
  assert.equal(parseAvailableCredits({ success: true, availableCredits: 2.5 }), 2.5);
  // Rounded down to 0.01: a credit that is not there is never claimed.
  assert.equal(
    parseAvailableCredits({ success: true, availableCredits: 0.000001 }),
    0,
  );
  assert.equal(
    parseAvailableCredits({ success: true, availableCredits: 0.1234567 }),
    0.12,
  );
  // An overdrawn pool has nothing to spend: it reads as zero, not a debt.
  assert.equal(parseAvailableCredits({ success: true, availableCredits: -3 }), 0);
  assert.equal(
    parseAvailableCredits({ success: true, availableCredits: -0.25 }),
    0,
  );
  assert.equal(
    parseAvailableCredits({ success: true, availableCredits: null }),
    null,
  );
  for (const body of [
    null,
    "2",
    {},
    { success: true },
    { success: false, availableCredits: 2 },
    { success: true, availableCredits: "2" },
    { success: true, availableCredits: "0.5" },
    { success: true, availableCredits: Number.NaN },
    { success: true, availableCredits: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(parseAvailableCredits(body), undefined, JSON.stringify(body));
  }
});

test("a quote is rounded up to 0.01 and never read as a negative price", () => {
  assert.equal(parseQuoteCredits({ success: true, credits: 1 }), 1);
  assert.equal(parseQuoteCredits({ success: true, credits: 0 }), 0);
  assert.equal(parseQuoteCredits({ success: true, credits: 0.01 }), 0.01);
  assert.equal(parseQuoteCredits({ success: true, credits: 0.010738 }), 0.02);
  assert.equal(parseQuoteCredits({ success: true, credits: 0.000001 }), 0.01);
  for (const body of [
    null,
    {},
    { success: true, credits: "0.01" },
    { success: true, credits: -0.01 },
    { success: true, credits: Number.NaN },
  ]) {
    assert.equal(parseQuoteCredits(body), undefined, JSON.stringify(body));
  }
});

/**
 * A client answering quotes at 0.01 credit per GB with no minimum, and a
 * one-credit workflow run: the fractional price book.
 */
function fractionalClient(availableCredits: unknown = 0.05) {
  return new CreditClient({
    apiUrl: "https://api.test",
    fetch: (async (input: URL, init: RequestInit) => {
      if (new URL(String(input)).pathname === "/v1/credits/available") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, availableCredits }),
        };
      }
      const body = JSON.parse(String(init.body));
      const usage = body.usage as Array<{ metric: string; quantity: string | number }>;
      const bandwidth = usage.find((record) => record.metric === "bandwidth");
      const microcredits = bandwidth
        ? (BigInt(bandwidth.quantity) * 10_000n + 999_999_999n) / 1_000_000_000n
        : 1_000_000n;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          credits: Number(microcredits) / 1_000_000,
          quote: { usageCharges: [] },
        }),
      };
    }) as never,
  });
}

test("fractional transfer quotes total exactly at two decimals", async () => {
  // 0.1 + 0.2 in floating point is 0.30000000000000004; three transfers of
  // 10, 20 and 1 GB must total 0.31 exactly, plus the one-credit run.
  const estimate = await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: [10_000_000_000n, 20_000_000_000n, 1_000_000_000n].map(
        (bytes, index) => ({
          stepId: `step_${index}`,
          label: `Copy ${index}`,
          sourceBytes: String(bytes),
          destinationCount: 1,
          partial: false,
        }),
      ),
    },
    fractionalClient(),
    rawKey,
  );

  assert.deepEqual(
    estimate.lines.map((line) => line.credits),
    [1, 0.1, 0.2, 0.01],
  );
  assert.equal(estimate.total, 1.31);
  assert.equal(estimate.availableCredits, 0.05);
});

test("each transfer is rounded up to 0.01, and a negative balance is none", async () => {
  // 1 byte is one microcredit, 1 GiB is 10,738, 100 GB is exactly 1 credit.
  const estimate = await estimateWorkflowCredits(
    {
      apiKeyId: "key_1",
      transfers: ["1", String(1024 ** 3), "100000000000"].map(
        (sourceBytes, index) => ({
          stepId: `step_${index}`,
          label: `Copy ${index}`,
          sourceBytes,
          destinationCount: 1,
          partial: false,
        }),
      ),
    },
    fractionalClient(-2.5),
    rawKey,
  );

  assert.deepEqual(
    estimate.lines.map((line) => line.credits),
    [1, 0.01, 0.02, 1],
  );
  assert.equal(estimate.total, 2.03);
  assert.equal(estimate.availableCredits, 0);
});

test("a reservation reports credits held rounded up to 0.01", async () => {
  const client = new CreditClient({
    apiUrl: "https://api.test",
    fetch: (async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        operation: { idempotencyKey: "op_1", creditsUsed: 0.002, status: "HELD" },
      }),
    })) as never,
  });

  const reservation = await client.reserve(rawKey(), {
    idempotencyKey: "op_1",
    action: "workflow.run",
    usage: [],
  });
  assert.equal(reservation.creditsUsed, 0.01);
});
