/**
 * Credits have at most two decimals: Studio charges, estimates, returns and
 * shows nothing finer than 0.01 credit.
 *
 * Beam prices to the microcredit (one credit is 1,000,000 microcredits), so an
 * amount read from Beam is brought to hundredths in the direction that never
 * understates what is owed: a price or a charge rounds up to the next 0.01 (a
 * 1 GiB transfer quoted at 0.010738 credit is 0.02), a balance rounds down (a
 * credit that is not there is never claimed). Zero stays zero.
 *
 * Anything Studio adds up is summed in whole hundredths, so five 0.1-credit
 * lines total exactly 0.5 and never 0.49999999999999994.
 */
export const HUNDREDTHS_PER_CREDIT = 100;

const MICROCREDITS_PER_CREDIT = 1_000_000;
const MICROCREDITS_PER_HUNDREDTH =
  MICROCREDITS_PER_CREDIT / HUNDREDTHS_PER_CREDIT;

/** Which way an amount finer than 0.01 credit is brought to hundredths. */
export type CreditRounding = "up" | "down";

/** A credit amount of at most two decimals in whole hundredths. */
export function toHundredths(credits: number) {
  return Math.round(credits * HUNDREDTHS_PER_CREDIT);
}

/** Whole hundredths back to a credit amount; never -0. */
export function fromHundredths(hundredths: number) {
  return hundredths / HUNDREDTHS_PER_CREDIT + 0;
}

/**
 * A credit amount at two decimals, rounded up or down to the hundredth.
 *
 * The amount is first taken to the whole microcredit, the finest precision Beam
 * uses, so floating-point noise (0.07 is 7.000000000000001 hundredths) never
 * adds or drops a hundredth.
 */
export function roundCredits(credits: number, rounding: CreditRounding) {
  const hundredths =
    Math.round(credits * MICROCREDITS_PER_CREDIT) / MICROCREDITS_PER_HUNDREDTH;
  return fromHundredths(
    rounding === "up" ? Math.ceil(hundredths) : Math.floor(hundredths),
  );
}

/**
 * A credit amount from a Beam response at two decimals, or undefined when the
 * value is not a finite number. Prices and charges round `up`, balances
 * `down`. Negative amounts are kept: a balance may be overdrawn, and each
 * caller decides what that means.
 */
export function parseCreditAmount(
  value: unknown,
  rounding: CreditRounding,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return roundCredits(value, rounding);
}

/** The exact sum of two-decimal credit amounts. */
export function sumCredits(amounts: readonly number[]) {
  return fromHundredths(
    amounts.reduce((total, amount) => total + toHundredths(amount), 0),
  );
}
