import assert from "node:assert/strict";
import test from "node:test";
import {
  isStorageListAccessDenied,
  storageListError,
} from "./storage-browser.js";

test("recognizes S3 and R2 list-access denials", () => {
  assert.equal(isStorageListAccessDenied({ name: "AccessDenied" }), true);
  assert.equal(isStorageListAccessDenied({ code: "Access Denied" }), true);
  assert.equal(isStorageListAccessDenied({ Code: "Forbidden" }), true);
  assert.equal(isStorageListAccessDenied(new Error("Access Denied")), true);
});

test("does not hide unrelated storage errors", () => {
  const error = new Error("Network timeout");

  assert.equal(isStorageListAccessDenied(error), false);
  assert.equal(storageListError(error, "bucket-a"), error);
});

test("maps list-access denials to a specific API error", () => {
  const error = storageListError(
    Object.assign(new Error("Access Denied"), { name: "AccessDenied" }),
    "bucket-a",
  ) as Error & {
    code: string;
    statusCode: number;
    action: string;
    details: { bucket: string };
  };

  assert.equal(error.name, "StorageListAccessDeniedError");
  assert.equal(error.code, "storage_list_access_denied");
  assert.equal(error.statusCode, 403);
  assert.equal(error.details.bucket, "bucket-a");
  assert.match(error.message, /can still be saved/i);
  assert.match(error.action, /permission to list/i);
});

test("maps known bucket and authentication failures without provider details", () => {
  for (const [providerCode, code, statusCode] of [
    ["InvalidBucketName", "storage_bucket_name_invalid", 400],
    ["NoSuchBucket", "storage_bucket_not_found", 404],
    ["InvalidAccessKeyId", "storage_credential_rejected", 403],
    ["SignatureDoesNotMatch", "storage_credential_rejected", 403],
    ["ExpiredToken", "storage_credential_rejected", 403],
    ["InvalidToken", "storage_credential_rejected", 403],
  ] as const) {
    for (const field of ["name", "code", "Code"]) {
      const error = storageListError(
        {
          [field]: providerCode,
          message: "https://provider.invalid/?signature=secret",
          request: "secret",
        },
        "test_bucket",
      ) as Error & {
        code: string;
        statusCode: number;
        details: { bucket: string };
        action: string;
        retryable: boolean;
      };
      assert.equal(error.code, code);
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.details.bucket, "test_bucket");
      assert.equal(error.retryable, false);
      assert.ok(error.action);
      assert.doesNotMatch(
        error.message + JSON.stringify(error),
        /signature|secret|provider\.invalid/,
      );
    }
  }
});
