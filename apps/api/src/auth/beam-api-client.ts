import { webEnv } from "../env.js";
import type { StudioOAuthService } from "./oauth-service.js";

export class BeamApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BeamApiError";
  }
}

/** Central bearer, refresh and one-retry boundary for Beam API calls. */
export class BeamApiClient {
  constructor(
    private readonly options: {
      apiUrl: string;
      fetch: typeof globalThis.fetch;
      oauth: StudioOAuthService;
    },
  ) {}

  async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchResponse(path, {
      method: "GET",
      cache: "no-store",
    });

    if (response.status === 503 || response.status >= 500) {
      throw new BeamApiError(
        "temporary_api_error",
        "Beam API is temporarily unavailable",
        503,
        true,
      );
    }
    if (!response.ok) {
      throw new BeamApiError(
        "beam_api_error",
        `Beam API request failed with ${response.status}`,
        response.status,
        false,
      );
    }
    return (await response.json()) as T;
  }

  async fetchResponse(
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.authenticatedFetch(input, init, false);
  }

  private async authenticatedFetch(
    input: string | URL,
    init: RequestInit,
    refreshed: boolean,
  ): Promise<Response> {
    const apiUrl = new URL(this.options.apiUrl);
    const url = new URL(input, apiUrl);
    if (url.origin !== apiUrl.origin) {
      throw new BeamApiError(
        "invalid_api_url",
        "Beam API credentials cannot be sent to another origin",
        500,
        false,
      );
    }
    const accessToken = await this.options.oauth.getAccessToken({
      forceRefresh: refreshed,
    });
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        ...init,
        headers,
      });
    } catch {
      throw new BeamApiError(
        "temporary_api_error",
        "Beam API is temporarily unavailable",
        503,
        true,
      );
    }

    if (response.status === 401 && !refreshed) {
      return this.authenticatedFetch(input, init, true);
    }
    if (response.status === 401) {
      await this.options.oauth.expireSession();
      throw new BeamApiError(
        "session_expired",
        "The Studio session has expired",
        401,
        false,
      );
    }
    return response;
  }
}

export function createBeamApiClient(
  oauth: StudioOAuthService,
  options: { apiUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  return new BeamApiClient({
    apiUrl: options.apiUrl ?? webEnv.apiUrl,
    fetch: options.fetch ?? globalThis.fetch,
    oauth,
  });
}
