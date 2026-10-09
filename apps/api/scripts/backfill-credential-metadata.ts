/**
 * Re-derives metadata_json and prefix for every stored credential.
 *
 * Credentials written before secret hints were separated from public
 * identifiers carry plaintext in metadata_json, which is not encrypted.
 *
 *   pnpm --filter @beam-studio/api run backfill:credential-metadata
 *   pnpm --filter @beam-studio/api run backfill:credential-metadata -- --execute
 *
 * Dry run by default: it prints what would change and writes nothing.
 */
import { backfillCredentialMetadata } from "../src/studio/store.js";

const execute = process.argv.includes("--execute");

const result = await backfillCredentialMetadata({ dryRun: !execute });

console.log(
  `${execute ? "Rewrote" : "Would rewrite"} ${result.changed.length} of ${result.scanned} credential(s).`,
);

for (const row of result.changed) {
  console.log(`\n  ${row.name} (${row.id})`);
  console.log(`    before: ${row.before}`);
  console.log(`    after:  ${row.after}`);
}

if (result.unreadable) {
  console.warn(
    `\n${result.unreadable} credential(s) could not be decrypted and were left untouched. ` +
      `They were most likely encrypted under a different BEAM_STUDIO_SECRET_KEY.`,
  );
}

if (!execute && result.changed.length) {
  console.log("\nDry run. Re-run with --execute to apply.");
}

process.exit(0);
