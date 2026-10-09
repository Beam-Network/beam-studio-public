import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend, apiUrlForPath } from "@/lib/api-client";
import { STUDIO_API_UNREACHABLE } from "@/lib/api-errors";

type DeviceAuthorization = {
  attempt_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type PollResult =
  | { status: "authorization_pending"; interval: number; expires_in: number }
  | { status: "slow_down"; interval: number; expires_in: number }
  | { status: "network_error"; interval: number; expires_in: number }
  | { status: "connected" };

type AuthStatus =
  | "idle"
  | "starting"
  | "waiting"
  | "slow_down"
  | "loading_profile"
  | "connected"
  | "denied"
  | "expired"
  | "network_error"
  | "cancelled"
  | "private"
  | "join_pending"
  | "error";

type SessionPayload = { session?: { userId?: string } | null };

export const Route: any = createFileRoute("/auth")({
  component: AuthPage,
});

function AuthPage() {
  const [authorization, setAuthorization] =
    useState<DeviceAuthorization | null>(null);
  const [status, setStatus] = useState<AuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [copied, setCopied] = useState<"code" | "url" | null>(null);
  const [authorizationApproved, setAuthorizationApproved] = useState(false);
  const pollingTimerRef = useRef<number | null>(null);
  const pollingControllerRef = useRef<AbortController | null>(null);
  const pollIntervalRef = useRef(5);
  const activeAttemptRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  const callbackPath = getCallbackPath();

  useEffect(() => {
    if (!expiresAt) return;
    const updateRemaining = () => {
      const next = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
      setRemainingSeconds(next);
      if (!next && activeAttemptRef.current) {
        stopPolling();
        setStatus("expired");
        setError(
          "The connection request expired. Generate a new code to continue.",
        );
      }
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    const cancelOnClose = () => {
      if (connectedRef.current) return;
      const attemptId = activeAttemptRef.current;
      if (!attemptId) return;
      void fetch(apiUrlForPath("/studio/auth/device/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt_id: attemptId }),
        credentials: "include",
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", cancelOnClose);
    return () => {
      window.removeEventListener("beforeunload", cancelOnClose);
      cancelOnClose();
      stopPolling();
    };
  }, []);

  const startLogin = async () => {
    await cancelActiveAttempt(false);
    setStatus("starting");
    setError(null);
    setAuthorization(null);
    setAuthorizationApproved(false);
    connectedRef.current = false;

    try {
      const next = await apiSend<DeviceAuthorization>(
        "POST",
        "/studio/auth/device/authorize",
      );
      activeAttemptRef.current = next.attempt_id;
      setAuthorization(next);
      setExpiresAt(Date.now() + next.expires_in * 1_000);
      setRemainingSeconds(next.expires_in);
      setStatus("waiting");
      schedulePoll(next.attempt_id, next.interval);
    } catch (startError) {
      setError(messageForError(startError, "Unable to start sign in."));
      setStatus(isTemporaryError(startError) ? "network_error" : "error");
    }
  };

  const schedulePoll = (attemptId: string, interval: number) => {
    clearPollingTimer();
    pollIntervalRef.current = interval;
    pollingTimerRef.current = window.setTimeout(
      () => void poll(attemptId),
      Math.max(1, interval) * 1_000,
    );
  };

  const poll = async (attemptId: string) => {
    if (activeAttemptRef.current !== attemptId) return;
    pollingControllerRef.current = new AbortController();
    try {
      const result = await apiSend<PollResult>(
        "POST",
        "/studio/auth/device/poll",
        { attempt_id: attemptId },
        { signal: pollingControllerRef.current.signal },
      );
      if (activeAttemptRef.current !== attemptId) return;
      if (result.status === "connected") {
        connectedRef.current = true;
        activeAttemptRef.current = null;
        setAuthorizationApproved(true);
        setAuthorization(null);
        setExpiresAt(0);
        setRemainingSeconds(0);
        await loadProfile();
        return;
      }
      setStatus(
        result.status === "slow_down"
          ? "slow_down"
          : result.status === "network_error"
            ? "network_error"
            : "waiting",
      );
      setError(
        result.status === "network_error"
          ? "Beam Auth is temporarily unavailable. Studio will keep trying."
          : null,
      );
      schedulePoll(attemptId, result.interval);
    } catch (pollError) {
      if (activeAttemptRef.current !== attemptId) return;
      const code = pollError instanceof ApiError ? pollError.code : "";
      if (code === STUDIO_API_UNREACHABLE) {
        // The code is still valid at Beam Auth; keep asking until Studio's
        // API answers again or the code expires.
        setStatus("network_error");
        setError(messageForError(pollError, "Studio can't reach its API."));
        schedulePoll(attemptId, pollIntervalRef.current);
        return;
      }
      activeAttemptRef.current = null;
      if (code === "access_denied") {
        setStatus("denied");
        setError("The connection request was denied.");
      } else if (code === "expired_token") {
        setStatus("expired");
        setError(
          "The connection request expired. Generate a new code to continue.",
        );
      } else if (code === "invalid_grant") {
        setStatus("error");
        setError("This connection attempt is no longer valid.");
      } else if (code === "instance_private") {
        // Signed in to Beam successfully; this installation simply does not
        // serve them. Restarting the device flow would not change that.
        setStatus("private");
        setError(messageForError(pollError, "This Studio is private."));
      } else if (code === "instance_organization_revoked") {
        setStatus("private");
        setError(
          messageForError(
            pollError,
            "Your organization's access to this Studio was revoked.",
          ),
        );
      } else if (code === "instance_join_pending") {
        setStatus("join_pending");
        setError(
          messageForError(
            pollError,
            "Your organization has asked to join this Studio.",
          ),
        );
      } else {
        setStatus(isTemporaryError(pollError) ? "network_error" : "error");
        setError(messageForError(pollError, "Unable to complete sign in."));
      }
    } finally {
      pollingControllerRef.current = null;
    }
  };

  const cancelActiveAttempt = async (showCancelled = true) => {
    const attemptId = activeAttemptRef.current;
    activeAttemptRef.current = null;
    stopPolling();
    if (attemptId) {
      await apiSend("POST", "/studio/auth/device/cancel", {
        attempt_id: attemptId,
      }).catch(() => undefined);
    }
    if (showCancelled) {
      setAuthorization(null);
      setExpiresAt(0);
      setRemainingSeconds(0);
      setError(null);
      setStatus("cancelled");
    }
  };

  const loadProfile = async () => {
    setStatus("loading_profile");
    setError(null);
    try {
      const [session] = await Promise.all([
        apiGet<SessionPayload>("/studio/session"),
        apiGet("/studio/organizations"),
      ]);
      if (!session.session?.userId) {
        throw new Error("Beam API returned an invalid profile.");
      }
      setStatus("connected");
      window.location.assign(callbackPath);
    } catch (profileError) {
      const temporary = isTemporaryError(profileError);
      setStatus(temporary ? "network_error" : "error");
      setError(
        profileError instanceof ApiError &&
          profileError.code === STUDIO_API_UNREACHABLE
          ? profileError.message
          : temporary
            ? "Authorization succeeded, but Beam API is temporarily unavailable. Your session is preserved."
            : messageForError(
                profileError,
                "Unable to load your Beam profile.",
              ),
      );
      if (!temporary) {
        connectedRef.current = false;
        setAuthorizationApproved(false);
      }
    }
  };

  const copy = async (kind: "code" | "url", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1_500);
  };

  const busy = status === "starting" || status === "loading_profile";
  const canRestart = ["cancelled", "denied", "expired", "error"].includes(
    status,
  );

  return (
    <div className="min-h-screen bg-white text-[rgb(17,17,17)]">
      <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center px-6 py-12">
        <div className="mb-9 text-center">
          <a href="/" aria-label="Beam home">
            <img
              alt="Beam"
              className="mx-auto mb-7 size-8"
              src="/beam-logo-black.svg"
            />
          </a>
          <h1 className="text-[22px] font-semibold leading-[1.08]">
            Beam Studio
          </h1>
          <p className="mx-auto mt-1 max-w-[300px] text-[21px] font-semibold leading-[1.08] text-[#64635D]">
            Connect securely with Beam Auth
          </p>
        </div>

        {error ? (
          <div
            className={`mb-4 rounded-control border px-3 py-2 text-sm ${
              status === "network_error"
                ? "border-[#E7D9A8] bg-[#FFFBEB] text-[#795B16]"
                : "border-[#F1C8C1] bg-[#FFF6F4] text-[#A33A2B]"
            }`}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {!authorization ? (
          <button
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-control bg-[rgb(17,17,17)] px-4 text-sm font-medium text-white transition hover:bg-[#2A2A2A] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onClick={authorizationApproved ? loadProfile : startLogin}
            type="button"
          >
            {status === "starting" || status === "loading_profile" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : authorizationApproved || canRestart ? (
              <RefreshCw className="h-4 w-4" />
            ) : (
              <LogIn className="h-4 w-4" />
            )}
            {status === "starting"
              ? "Generating a secure code"
              : status === "loading_profile"
                ? "Loading your Beam profile"
                : authorizationApproved
                  ? "Retry loading your profile"
                  : canRestart
                    ? "Generate a new code"
                    : "Continue with Beam Auth"}
          </button>
        ) : (
          <section className="rounded-surface border border-[#DEDDD7] bg-[#FAFAFA] px-4 py-4 text-center">
            <div className="flex items-center justify-between text-xs font-medium uppercase text-[#64635D]">
              <span>Studio code</span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock3 className="h-3.5 w-3.5" />
                {formatRemaining(remainingSeconds)}
              </span>
            </div>
            <strong className="mt-3 block font-mono text-3xl font-semibold tracking-[0.08em]">
              {authorization.user_code}
            </strong>
            <button
              className="mt-2 text-xs font-medium text-[#64635D] underline-offset-2 hover:underline"
              onClick={() => copy("code", authorization.user_code)}
              type="button"
            >
              {copied === "code" ? "Code copied" : "Copy code"}
            </button>

            <a
              className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-control bg-[rgb(17,17,17)] px-4 text-sm font-medium text-white transition hover:bg-[#2A2A2A]"
              href={authorization.verification_uri_complete}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-4 w-4" />
              Open Beam Auth
            </a>
            <button
              className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-control border border-[#DEDDD7] bg-white px-3 text-xs font-medium transition hover:bg-[#F7F7F4]"
              onClick={() =>
                copy("url", authorization.verification_uri_complete)
              }
              type="button"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied === "url" ? "URL copied" : "Copy verification URL"}
            </button>

            <div
              className="mt-4 flex items-center justify-center gap-2 text-sm text-[#77766F]"
              role="status"
            >
              {status === "connected" ? (
                <CheckCircle2 className="h-4 w-4 text-[#64635D]" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {statusLabel(status)}
            </div>
            {canRestart ? (
              <button
                className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 px-3 text-xs font-medium hover:underline"
                onClick={startLogin}
                type="button"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Generate a new code
              </button>
            ) : (
              <button
                className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 px-3 text-xs font-medium text-[#7B3328] hover:underline"
                onClick={() => void cancelActiveAttempt()}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
                Cancel sign in
              </button>
            )}
          </section>
        )}
      </main>
    </div>
  );

  function stopPolling() {
    clearPollingTimer();
    pollingControllerRef.current?.abort();
    pollingControllerRef.current = null;
  }

  function clearPollingTimer() {
    if (pollingTimerRef.current !== null) {
      window.clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }
}

function getCallbackPath() {
  if (typeof window === "undefined") return "/dashboard";
  const callbackUrl = new URLSearchParams(window.location.search).get(
    "callbackUrl",
  );
  return callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")
    ? callbackUrl
    : "/dashboard";
}

function formatRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function isTemporaryError(error: unknown) {
  return (
    error instanceof ApiError && (error.retryable || error.statusCode === 503)
  );
}

function messageForError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusLabel(status: AuthStatus) {
  switch (status) {
    case "slow_down":
      return "Beam Auth requested slower checks";
    case "network_error":
      return "Temporary network issue — retrying";
    case "loading_profile":
      return "Approved — loading your profile";
    case "connected":
      return "Connected";
    case "denied":
      return "Connection denied";
    case "expired":
      return "Code expired";
    case "private":
      return "This Studio is private";
    case "join_pending":
      return "Waiting for the owner to admit your organization";
    case "error":
      return "Connection could not be completed";
    default:
      return "Waiting for approval";
  }
}
