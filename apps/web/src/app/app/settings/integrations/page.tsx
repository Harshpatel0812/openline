"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/app/app-shell";
import {
  DisconnectDialog,
  FieldMappingCard,
  ImportCard,
  OptionsCard,
  StageMappingCard,
} from "@/components/app/crm-setup";
import { useMe } from "@/components/app/me-context";
import { Alert, Badge, Button, buttonClasses, Card, LoadingBlock, useToast } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  CRM_PROVIDER_LABELS,
  CRM_PROVIDERS,
  CRM_STATUS_LABELS,
  CRM_STATUS_TONES,
  crmCallbackErrorMessage,
  crmPlanNote,
  relativeTime,
  type CrmConnectionDto,
  type CrmProvider,
  type CrmStageMappingsDto,
  type CrmStatusDto,
} from "@/lib/crm";
import { formatDate } from "@/lib/format";
import { BILLING_PATH } from "@/lib/plan-flow";
import { useResource } from "@/lib/use-resource";

const PROVIDER_BLURBS: Record<CrmProvider, string> = {
  hubspot: "Two-way sync of contacts, companies and deals with HubSpot.",
  pipedrive: "Two-way sync of persons, organizations and deals with Pipedrive.",
};

/** Poll faster while an import or preview is running. */
function pollInterval(status: CrmConnectionDto["status"] | undefined): number | null {
  if (status === "importing" || status === "previewing") return 3_000;
  if (status === "active" || status === "paused" || status === "error") return 30_000;
  return null;
}

function statusSentence(c: CrmConnectionDto): string {
  const name = CRM_PROVIDER_LABELS[c.provider];
  switch (c.status) {
    case "needs_setup":
      return `Connected to ${name}. Finish the setup below to start syncing.`;
    case "previewing":
      return "Preview ready. Review the counts and start the import.";
    case "importing":
      return `Importing from ${name}…`;
    case "active":
      return `Syncing with ${name}.`;
    case "paused":
      return c.resumesAt
        ? `Paused until ${new Date(c.resumesAt).toLocaleString()}.`
        : "Sync is paused. Nothing syncs in either direction until you resume.";
    case "error":
      return `${name} needs to be reconnected.`;
    case "disconnected":
      return `Disconnected from ${name}.`;
  }
}

function ConnectionCard({
  connection,
  canAct,
  canSeeLog,
  planAllowed,
  onChange,
  onDisconnect,
  onConnect,
  connecting,
}: {
  connection: CrmConnectionDto;
  canAct: boolean;
  canSeeLog: boolean;
  /** False after a move to a plan without CRM sync: only pause and disconnect remain. */
  planAllowed: boolean;
  onChange: (c: CrmConnectionDto | null) => void;
  onDisconnect: () => void;
  onConnect: (p: CrmProvider) => void;
  connecting: CrmProvider | null;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const name = CRM_PROVIDER_LABELS[connection.provider];

  async function control(action: "pause" | "resume" | "sync-now") {
    setBusy(action);
    try {
      const updated = await api<CrmConnectionDto | undefined>(`/integrations/crm/${action}`, {
        method: "POST",
      });
      if (updated && typeof updated === "object" && "status" in updated) onChange(updated);
      else onChange(null);
      toast(
        action === "pause"
          ? `Sync with ${name} paused`
          : action === "resume"
            ? `Sync with ${name} resumed`
            : "Sync started",
      );
    } catch (err) {
      toast(
        err instanceof ApiError && err.status === 429
          ? "Sync now can be used 6 times an hour. Try again later."
          : errorMessage(err),
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  const syncing = ["active", "paused", "error", "importing"].includes(connection.status);
  // The opt-out warning has its own explanation above; stage mapping shows in its card.
  const otherWarnings = [...new Set(connection.warnings)].filter(
    (w) => !/^Opt-outs are not being sent/.test(w) && !/^Stage mapping/.test(w),
  );
  const stageWarning =
    syncing && connection.warnings.some((w) => /^Stage mapping/.test(w))
      ? "Stage mapping needs attention: deal sync waits until every stage is mapped. Contacts and companies keep syncing."
      : null;

  return (
    <Card data-testid={`crm-card-${connection.provider}`}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{name}</h2>
          <Badge tone={CRM_STATUS_TONES[connection.status]}>
            <span data-testid="crm-status">{CRM_STATUS_LABELS[connection.status]}</span>
          </Badge>
        </div>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Connected to{" "}
          <strong className="font-medium">{connection.accountName ?? "your account"}</strong>
          {connection.accountId && !connection.accountName?.includes(connection.accountId)
            ? ` (${connection.provider === "hubspot" ? "portal" : "company"} ${connection.accountId})`
            : ""}
          {connection.connectedBy ? ` by ${connection.connectedBy.name}` : ""} on{" "}
          {formatDate(connection.connectedAt)}.
        </p>
        <p className="text-sm text-slate-700 dark:text-slate-300">{statusSentence(connection)}</p>

        {!planAllowed ? (
          <Alert tone="warning" title="Sync has stopped: your plan doesn't include CRM sync">
            {crmPlanNote(true)}{" "}
            <Link href={BILLING_PATH} className="font-medium underline">
              See Plan &amp; billing
            </Link>
          </Alert>
        ) : null}
        {connection.status === "error" && planAllowed ? (
          <Alert tone="error" title="Reconnect needed">
            {connection.lastError ??
              `Openline can no longer reach ${name}. Reconnect to resume syncing.`}
            {canAct ? (
              <div className="mt-2">
                <Button
                  size="sm"
                  loading={connecting === connection.provider}
                  onClick={() => onConnect(connection.provider)}
                >
                  Reconnect {name}
                </Button>
              </div>
            ) : null}
          </Alert>
        ) : null}
        {connection.provider === "hubspot" && !connection.canPushOptOuts ? (
          <Alert tone="warning" title="Opt-outs are not being sent to HubSpot">
            The optional permission to update subscriptions wasn&apos;t granted. People who
            unsubscribe in Openline stay mailable from HubSpot. Reconnect and allow it to fix this.
          </Alert>
        ) : null}
        {stageWarning ? <Alert tone="warning">{stageWarning}</Alert> : null}
        {otherWarnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">Last sync</dt>
            <dd className="mt-0.5" data-testid="crm-last-sync">
              {connection.lastSyncAt ? relativeTime(connection.lastSyncAt) : "Not yet"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">Next sync</dt>
            <dd className="mt-0.5">
              {connection.status === "paused"
                ? "Paused"
                : connection.nextSyncAt
                  ? relativeTime(connection.nextSyncAt)
                  : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">Open errors</dt>
            <dd className="mt-0.5" data-testid="crm-error-count">
              {canSeeLog ? (
                <Link
                  href="/app/settings/integrations/log"
                  className="font-medium text-indigo-700 underline dark:text-indigo-300"
                >
                  {connection.openErrors.toLocaleString()}
                  <span className="sr-only"> open sync errors, view the sync log</span>
                </Link>
              ) : (
                connection.openErrors.toLocaleString()
              )}
            </dd>
          </div>
        </dl>

        {canAct ? (
          <div className="flex flex-wrap gap-2">
            {syncing && connection.status !== "error" ? (
              <>
                {planAllowed ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === "sync-now"}
                    disabled={connection.status !== "active"}
                    onClick={() => void control("sync-now")}
                  >
                    Sync now
                  </Button>
                ) : null}
                {connection.status === "paused" ? (
                  planAllowed ? (
                    <Button
                      size="sm"
                      loading={busy === "resume"}
                      onClick={() => void control("resume")}
                    >
                      Resume sync
                    </Button>
                  ) : null
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === "pause"}
                    disabled={connection.status === "importing"}
                    onClick={() => void control("pause")}
                  >
                    Pause sync
                  </Button>
                )}
              </>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="text-red-700 dark:text-red-400"
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ProviderCard({
  provider,
  configured,
  blocked,
  canAct,
  planAllowed,
  connecting,
  onConnect,
}: {
  provider: CrmProvider;
  configured: boolean;
  /** Another CRM is connected (one per workspace). */
  blocked: string | null;
  canAct: boolean;
  planAllowed: boolean;
  connecting: CrmProvider | null;
  onConnect: (p: CrmProvider) => void;
}) {
  const name = CRM_PROVIDER_LABELS[provider];
  const noteId = `crm-note-${provider}`;
  const note = !planAllowed
    ? "Available on the Team plan and up."
    : blocked
      ? `This workspace is connected to ${blocked}. One CRM per workspace: disconnect it first.`
      : !configured
        ? `${name} connection isn't set up on this server yet.`
        : !canAct
          ? "Only owners and admins can connect a CRM."
          : null;
  return (
    <Card data-testid={`crm-card-${provider}`}>
      <div className="flex h-full flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{name}</h2>
          <Badge>Not connected</Badge>
        </div>
        <p className="text-sm text-slate-700 dark:text-slate-300">{PROVIDER_BLURBS[provider]}</p>
        {note ? (
          <p id={noteId} className="text-sm text-slate-600 dark:text-slate-400">
            {note}
          </p>
        ) : null}
        <div className="mt-auto">
          <Button
            onClick={() => onConnect(provider)}
            loading={connecting === provider}
            disabled={Boolean(note) || connecting !== null}
            aria-describedby={note ? noteId : undefined}
          >
            Connect {name}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function IntegrationsView() {
  const { can } = useMe();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const canAct = can("owner", "admin");
  const canSeeLog = can("owner", "admin", "manager");
  const status = useResource<CrmStatusDto>("/integrations/crm");
  const conn = status.data?.connection ?? null;
  const stageMap = useResource<CrmStageMappingsDto>(
    canAct && conn && conn.status !== "disconnected" ? "/integrations/crm/stage-mappings" : null,
  );
  const [connecting, setConnecting] = useState<CrmProvider | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastStatus = useRef<string | null>(null);

  // ?connected=<provider> / ?error=<code> come back from the OAuth callback.
  useEffect(() => {
    const connected = params.get("connected");
    const err = params.get("error");
    if (!connected && !err) return;
    if (connected && connected in CRM_PROVIDER_LABELS) {
      toast(`${CRM_PROVIDER_LABELS[connected as CrmProvider]} connected`);
    }
    if (err) setCallbackError(crmCallbackErrorMessage(err));
    router.replace(pathname, { scroll: false });
  }, [params, pathname, router, toast]);

  // Announce status changes (import finished, paused, reconnect needed) to screen readers.
  useEffect(() => {
    const key = conn ? `${conn.provider}:${conn.status}` : "none";
    if (lastStatus.current !== null && lastStatus.current !== key) {
      setAnnouncement(conn ? statusSentence(conn) : "No CRM connected.");
    }
    lastStatus.current = key;
  }, [conn]);

  const interval = pollInterval(conn?.status);
  const { reload } = status;
  useEffect(() => {
    if (!interval) return;
    const t = setInterval(reload, interval);
    return () => clearInterval(t);
  }, [interval, reload]);

  async function connect(provider: CrmProvider) {
    setConnecting(provider);
    setConnectError(null);
    try {
      const { url } = await api<{ url: string }>(`/integrations/crm/${provider}/authorize`);
      window.location.assign(url);
    } catch (err) {
      setConnecting(null);
      setConnectError(
        err instanceof ApiError ? crmCallbackErrorMessage(err.code) : errorMessage(err),
      );
    }
  }

  const planAllowed = status.data?.entitled ?? true;
  const configured = (p: CrmProvider) => status.data?.available.includes(p) ?? true;
  const active = conn && conn.status !== "disconnected" ? conn : null;
  const stagesReady = Boolean(stageMap.data?.complete ?? active?.stageMappingComplete);

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Keep Openline and your CRM in step: contacts, companies and deals, both ways."
        actions={
          canSeeLog && active ? (
            <Link href="/app/settings/integrations/log" className={buttonClasses("secondary")}>
              Sync log
            </Link>
          ) : null
        }
      />
      <p className="sr-only" aria-live="polite" data-testid="crm-announcer">
        {announcement}
      </p>

      <div className="space-y-6">
        {callbackError ? (
          <Alert tone="error" title="The CRM wasn't connected">
            {callbackError}
          </Alert>
        ) : null}
        {connectError ? <Alert tone="error">{connectError}</Alert> : null}
        {!planAllowed && !active ? (
          <Alert tone="info" title="CRM sync is on the Team plan and up">
            {crmPlanNote(false)}{" "}
            <Link href={BILLING_PATH} className="font-medium underline">
              See Plan &amp; billing
            </Link>
          </Alert>
        ) : null}
        {!canAct ? (
          <Alert tone="info">
            Only owners and admins can connect, map, import, pause or disconnect.
            {canSeeLog ? " You can see the status and the sync log." : ""}
          </Alert>
        ) : null}

        {status.loading && !status.data ? (
          <LoadingBlock label="Loading integrations" />
        ) : status.error ? (
          <Alert tone="error" title="Couldn't load integrations">
            {errorMessage(status.error)}{" "}
            <button type="button" className="font-medium underline" onClick={status.reload}>
              Try again
            </button>
          </Alert>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              {CRM_PROVIDERS.map((p) =>
                active && active.provider === p ? (
                  <div key={p} className="md:col-span-2">
                    <ConnectionCard
                      connection={active}
                      canAct={canAct}
                      canSeeLog={canSeeLog}
                      planAllowed={planAllowed}
                      connecting={connecting}
                      onConnect={(x) => void connect(x)}
                      onChange={(c) =>
                        c
                          ? status.setData((d) => (d ? { ...d, connection: c } : d))
                          : status.reload()
                      }
                      onDisconnect={() => setDisconnecting(true)}
                    />
                  </div>
                ) : (
                  <ProviderCard
                    key={p}
                    provider={p}
                    configured={configured(p)}
                    blocked={active ? CRM_PROVIDER_LABELS[active.provider] : null}
                    canAct={canAct}
                    planAllowed={planAllowed}
                    connecting={connecting}
                    onConnect={(x) => void connect(x)}
                  />
                ),
              )}
            </div>

            {active && canAct && planAllowed ? (
              <section aria-labelledby="crm-setup-title" className="space-y-6">
                <h2
                  id="crm-setup-title"
                  className="text-lg font-semibold text-slate-900 dark:text-white"
                >
                  {active.status === "needs_setup" || active.status === "previewing"
                    ? "Set up the sync"
                    : "Sync settings"}
                </h2>
                {active.status === "needs_setup" || active.status === "previewing" ? (
                  <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
                    <li>1. Pipeline and stages</li>
                    <li>2. Fields</li>
                    <li>3. Options</li>
                    <li>4. Preview and import</li>
                  </ol>
                ) : null}
                <StageMappingCard
                  connection={active}
                  canAct={canAct}
                  onSaved={() => {
                    stageMap.reload();
                    status.reload();
                  }}
                />
                <FieldMappingCard connection={active} canAct={canAct} />
                <OptionsCard
                  connection={active}
                  canAct={canAct}
                  onSaved={(c) => status.setData((d) => (d ? { ...d, connection: c } : d))}
                />
                <ImportCard
                  connection={active}
                  canAct={canAct}
                  stagesReady={stagesReady}
                  onStarted={status.reload}
                />
              </section>
            ) : null}
            <p className="text-sm text-slate-600 dark:text-slate-400">
              <Link
                href="/help/crm-sync"
                className="font-medium text-indigo-700 underline dark:text-indigo-300"
              >
                How CRM sync works
              </Link>{" "}
              — what syncs which way, conflicts, opt-outs and disconnecting.
            </p>
          </>
        )}
      </div>

      {active ? (
        <DisconnectDialog
          connection={active}
          open={disconnecting}
          onClose={() => setDisconnecting(false)}
          onDone={() => {
            setDisconnecting(false);
            toast(`Disconnected ${CRM_PROVIDER_LABELS[active.provider]}`);
            status.reload();
          }}
        />
      ) : null}
    </>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading integrations" />}>
      <IntegrationsView />
    </Suspense>
  );
}
