export const cryptoCompatibilityScript = `
(() => {
  const cryptoSource = globalThis.crypto;
  if (
    !cryptoSource ||
    typeof cryptoSource.randomUUID === "function" ||
    typeof cryptoSource.getRandomValues !== "function"
  ) {
    return;
  }

  const randomUUID = () => {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  };

  try {
    Object.defineProperty(cryptoSource, "randomUUID", {
      configurable: true,
      value: randomUUID,
    });
  } catch {
    try {
      cryptoSource.randomUUID = randomUUID;
    } catch {
      // A locked-down browser object cannot be polyfilled.
    }
  }
})();
`;
