type RandomValuesSource = Pick<Crypto, "getRandomValues">;

export function secureRandomHex(
  byteLength: number,
  cryptoSource: RandomValuesSource | undefined = globalThis.crypto,
) {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new RangeError("byteLength must be a positive integer");
  }
  if (!cryptoSource || typeof cryptoSource.getRandomValues !== "function") {
    throw new Error("Secure random values are unavailable in this browser");
  }

  const bytes = new Uint8Array(byteLength);
  cryptoSource.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
