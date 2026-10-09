/**
 * Credits have at most two decimals: Studio shows, estimates and compares
 * nothing finer than 0.01 credit. Amounts arrive from the Studio API already at
 * two decimals (estimates rounded up, balances rounded down); this module only
 * shows and compares them.
 */
const HUNDREDTHS_PER_CREDIT = 100;

const CREDIT_AMOUNT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/**
 * A credit amount in whole hundredths, for exact comparison and sums: 0.1 + 0.2
 * is 30 hundredths, like 0.3.
 */
export function toHundredths(credits: number) {
  return Math.round(credits * HUNDREDTHS_PER_CREDIT);
}

/**
 * A credit amount as a number: grouped thousands, at most two decimals,
 * trailing zeros trimmed. 0.05 is "0.05", 1234.5 is "1,234.5", 3 is "3", and an
 * overdrawn balance of -0.5 is "-0.5". A value that is not a finite number
 * reads as "0", and nothing reads as "-0".
 */
export function formatCreditAmount(credits: number) {
  const hundredths = Number.isFinite(credits) ? toHundredths(credits) : 0;
  return CREDIT_AMOUNT.format(
    hundredths === 0 ? 0 : hundredths / HUNDREDTHS_PER_CREDIT,
  );
}

/** A credit amount with its unit: "1 credit", "0.2 credits", "12 credits". */
export function formatCredits(credits: number) {
  const amount = formatCreditAmount(credits);
  return `${amount} ${amount === "1" ? "credit" : "credits"}`;
}
