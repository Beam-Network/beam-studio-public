# Beam Studio OAuth migration

Beam Studio now authenticates exclusively as the OAuth public client
`beam-studio` with scope `studio:access`.

## Breaking changes

- The Studio proxy routes are now `/studio/auth/device/authorize`,
  `/studio/auth/device/poll`, and `/studio/auth/device/cancel`.
- Beam Auth is called through `/oauth/device/authorize`, `/oauth/token`, and
  `/oauth/revoke`, using form-encoded OAuth fields in `snake_case`.
- Browser callbacks, popup coordination, and message events are no longer part
  of login. Polling is the only approval signal.
- Legacy Studio access-token, device-code, and shared-session cookies are ignored. Logout also
  expires those cookie names so upgrades converge on the new session model.
- Token responses are used only for OAuth credentials. Profile and organization
  data are loaded from Beam API `/api/me` and `/api/organizations`.
- No server table migration or change to `StudioDeviceAuthorization` is needed;
  Beam Auth owns the new `DeviceAuthorization` records.

## Credential storage

Each browser has an independent session. Its access token is process-memory-only
and its rotating refresh token is stored in its own owner-only encrypted vault
file, replaced atomically before the new generation is used. Concurrent requests
for the same session share a refresh promise; other sessions have separate locks.
Logout clears only that browser's session. Device polling requires the cookie
issued when that browser started login.

The default directory is `~/.beam-studio/oauth-session.json.sessions/`. Set
`BEAM_STUDIO_AUTH_STORE_PATH` when the Studio API runs in a container or under a
service account; `.sessions/` is appended to the configured path. The old single
session file is not imported because it cannot be assigned to a browser.
`BEAM_STUDIO_SECRET_KEY` is required in every environment, not only production:
it has no default, and a placeholder published in this repository is refused.
The browser session cookie is signed with a secret derived from it. Mount both
the store directory and the key through the platform's secret facilities.

## Runtime configuration

```text
BEAM_AUTH_URL=https://auth.b1m.ai
BEAM_API_URL=https://api.b1m.ai
```

Do not add an OAuth client secret. After deploying this release, every existing
Studio user must complete a fresh device authorization.
