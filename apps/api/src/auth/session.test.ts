import assert from "node:assert/strict";
import { test } from "node:test";
import { studioSessionFromMe } from "./session.js";

test("maps the Studio session exclusively from the Beam API me payload", () => {
  assert.deepEqual(
    studioSessionFromMe({
      user: {
        id: "user_123",
        name: "Beam User",
        email: "user@example.com",
        platformRole: "USER",
      },
    }),
    {
      type: "account",
      userId: "user_123",
      name: "Beam User",
      email: "user@example.com",
      image: null,
      provider: null,
      platformRole: "USER",
      accountType: "user",
      exp: null,
    },
  );
});

test("rejects a me payload without a user identifier", () => {
  assert.equal(studioSessionFromMe({ email: "user@example.com" }), null);
});
