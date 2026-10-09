import { useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { apiSend } from "@/lib/api-client";

export type InstanceKeyStatus =
  | {
      status: "active";
      credentialId: string;
      name: string;
      prefix: string | null;
      createdAt: string;
      updatedAt: string;
    }
  | { status: "missing" }
  | { status: "disabled" };

type ConsentStart = {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

type PollResult =
  | { status: "authorization_pending"; interval: number; expiresIn: number }
  | { status: "connected"; rotated: boolean };

/**
 * The organization API key this Studio holds for its owner, and the consent
 * that creates or rotates it at Beam Auth.
 *
 * A key is only ever requested by the owner: right after they claim the
 * Studio (`startOnMount`), or with the button here. Opening the page never
 * requests one on its own, so an installation claimed before instance keys
 * existed keeps running on the keys it has until its owner asks.
 */
export function InstanceKeyPanel({
  instanceKey,
  onChanged,
  startOnMount = false,
}: {
  instanceKey: InstanceKeyStatus;
  onChanged(): void;
  startOnMount?: boolean;
}) {
  const [consent, setConsent] = useState<ConsentStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const start = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setConsent(await apiSend<ConsentStart>("POST", "/studio/instance/key"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!startOnMount || started.current || instanceKey.status === "active") {
      return;
    }
    started.current = true;
    void start();
  }, [instanceKey.status, startOnMount]);

  useEffect(() => {
    if (!consent) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (interval: number) => {
      timer = window.setTimeout(async () => {
        try {
          const result = await apiSend<PollResult>(
            "POST",
            "/studio/instance/key/poll",
            { attemptId: consent.attemptId },
          );
          if (cancelled) return;
          if (result.status === "connected") {
            setConsent(null);
            setNotice(
              result.rotated
                ? "The instance key was rotated. Workflows use the new key."
                : "The instance key was created. New workflows and transfers use it.",
            );
            onChangedRef.current();
            return;
          }
          void poll(result.interval);
        } catch (cause) {
          if (cancelled) return;
          setConsent(null);
          setError(messageOf(cause));
        }
      }, interval * 1_000);
    };
    void poll(consent.interval);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [consent]);

  const revoke = async () => {
    await apiSend("DELETE", "/studio/instance/key");
    setNotice("The instance key was revoked.");
    onChanged();
  };

  return (
    <section className="rounded-surface border p-4">
      <h2 className="flex items-center gap-2 text-base font-medium">
        <KeyRound aria-hidden className="size-4 text-muted-foreground" />
        Instance key
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The Beam API key this Studio uses for your organization. New workflows
        and Beam Transfer steps use it, so nobody has to paste a key. It is
        listed as "Studio: …" under API keys in the Beam Console.
      </p>

      {error ? (
        <p
          className="mt-3 rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}

      {consent ? (
        <div className="mt-4 grid gap-3 rounded-control border bg-muted/30 p-4 sm:max-w-md">
          <p className="text-sm">
            Approve the key in Beam Auth. It can run transfers and spend your
            organization's credits.
          </p>
          <strong className="font-mono text-2xl tracking-[0.08em]">
            {consent.userCode}
          </strong>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild>
              <a
                href={consent.verificationUriComplete}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="size-4" />
                Open Beam Auth
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConsent(null)}
            >
              Cancel
            </Button>
          </div>
          <p
            className="flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <LoaderCircle className="size-3.5 animate-spin" />
            Waiting for approval
          </p>
        </div>
      ) : instanceKey.status === "active" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border p-3">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {instanceKey.name}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {instanceKey.prefix ? `${instanceKey.prefix}…` : "b1m_…"} ·
              updated {new Date(instanceKey.updatedAt).toLocaleString()}
            </span>
          </span>
          <span className="flex gap-2">
            <Button
              disabled={busy}
              type="button"
              variant="outline"
              onClick={() => void start()}
            >
              Rotate
            </Button>
            <ConfirmationDialog
              confirmLabel="Revoke key"
              description="Beam stops accepting this key at once. Workflows that use it stop running until another key is selected."
              onConfirm={revoke}
              title="Revoke the instance key?"
              trigger={
                <Button type="button" variant="outline">
                  Revoke
                </Button>
              }
            />
          </span>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-warning/40 bg-warning/5 p-3">
          <span className="text-sm">This Studio has no instance key yet.</span>
          <Button disabled={busy} type="button" onClick={() => void start()}>
            {busy ? "Starting…" : "Create instance key"}
          </Button>
        </div>
      )}
    </section>
  );
}

function messageOf(cause: unknown) {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Something went wrong.";
}
