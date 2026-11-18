"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { CrmOptions, CrmRunDto, MemberDto, PipelineStageDto } from "@openline/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cx,
  Dialog,
  Field,
  Input,
  LoadingBlock,
  Select,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import {
  allowedDirections,
  compatibleTypes,
  CRM_OBJECT_LABELS,
  CRM_OBJECTS,
  CRM_PROVIDER_LABELS,
  customKey,
  DIRECTION_LABELS,
  errorCodeLabel,
  fieldMappingsInput,
  MAX_CUSTOM_MAPPINGS_PER_OBJECT,
  prefillStageMapping,
  previewCounts,
  previewNote,
  DISCONNECT_FORGET_WARNING,
  SOURCE_OF_TRUTH_LABELS,
  stageMappingComplete,
  stageMappingInput,
  validateFieldMappings,
  type CrmConnectionDto,
  type CrmDirection,
  type CrmFieldMappingDto,
  type CrmLocalType,
  type CrmObject,
  type CrmPage,
  type CrmPipelineDto,
  type CrmRemoteFieldDto,
  type CrmSourceOfTruth,
  type CrmStageMappingsDto,
  type FieldMappingRow,
  type StageMappingDraft,
} from "@/lib/crm";
import { useResource } from "@/lib/use-resource";

const STANDARD_FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  title: "Job title",
  phone: "Phone",
  companyId: "Company",
  ownerId: "Owner",
  name: "Name",
  domain: "Domain",
  amount: "Amount and currency",
  stage: "Stage",
  expectedCloseDate: "Close date",
  lostReason: "Lost reason",
  primaryContactId: "Contact",
};

/** The CRM field a standard row maps to by default (PRD standard field map). */
const STANDARD_REMOTE: Record<"hubspot" | "pipedrive", Record<string, string>> = {
  hubspot: {
    "contact:firstName": "firstname",
    "contact:lastName": "lastname",
    "contact:title": "jobtitle",
    "contact:phone": "phone",
    "contact:companyId": "company association",
    "contact:ownerId": "hubspot_owner_id",
    "company:name": "name",
    "company:domain": "domain",
    "deal:name": "dealname",
    "deal:amount": "amount + deal_currency_code",
    "deal:stage": "pipeline + dealstage",
    "deal:expectedCloseDate": "closedate",
    "deal:lostReason": "closed_lost_reason",
    "deal:companyId": "company association",
    "deal:primaryContactId": "contact association",
    "deal:ownerId": "hubspot_owner_id",
  },
  pipedrive: {
    "contact:firstName": "first_name",
    "contact:lastName": "last_name",
    "contact:title": "job title field",
    "contact:phone": "phones",
    "contact:companyId": "org_id",
    "contact:ownerId": "owner_id",
    "company:name": "name",
    "company:domain": "website field",
    "deal:name": "title",
    "deal:amount": "value + currency",
    "deal:stage": "stage_id + status",
    "deal:expectedCloseDate": "expected_close_date",
    "deal:lostReason": "lost_reason",
    "deal:companyId": "org_id",
    "deal:primaryContactId": "person_id",
    "deal:ownerId": "owner_id",
  },
};

function localFieldLabel(field: string): string {
  if (field.startsWith("custom.")) return field.slice(7) || "new custom field";
  return STANDARD_FIELD_LABELS[field] ?? field;
}

// ------------------------------------------------------------------ pipeline + stages

export function StageMappingCard({
  connection,
  canAct,
  onSaved,
}: {
  connection: CrmConnectionDto;
  canAct: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const crmName = CRM_PROVIDER_LABELS[connection.provider];
  const pipelines = useResource<CrmPipelineDto[]>("/integrations/crm/remote/pipelines");
  const stages = useResource<PipelineStageDto[]>("/pipeline/stages");
  const saved = useResource<CrmStageMappingsDto>("/integrations/crm/stage-mappings");
  const [pipelineId, setPipelineId] = useState<string>(connection.pipelineId ?? "");
  const [mapping, setMapping] = useState<StageMappingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const pipelineSelectId = useId();

  useEffect(() => setPipelineId(connection.pipelineId ?? ""), [connection.pipelineId]);

  const pipelineList = Array.isArray(pipelines.data) ? pipelines.data : [];
  const pipeline = pipelineList.find((p) => p.id === pipelineId);
  const olStages = useMemo(
    () => [...(stages.data ?? [])].sort((a, b) => a.position - b.position),
    [stages.data],
  );

  useEffect(() => {
    if (!pipeline || !stages.data || saved.loading) return;
    const prev = connection.pipelineId === pipeline.id ? saved.data : null;
    setMapping(prefillStageMapping(olStages, pipeline.stages, prev));
  }, [pipeline, olStages, stages.data, saved.data, saved.loading, connection.pipelineId]);

  if ((pipelines.loading && !pipelines.data) || (stages.loading && !stages.data)) {
    return (
      <Card>
        <CardHeader title="Pipeline and stages" />
        <LoadingBlock label="Loading pipelines" />
      </Card>
    );
  }
  const loadError = pipelines.error ?? stages.error;
  if (loadError) {
    return (
      <Card>
        <CardHeader title="Pipeline and stages" />
        <div className="p-5">
          <Alert tone="error" title={`Couldn't load ${crmName} pipelines`}>
            {errorMessage(loadError)}{" "}
            <button
              type="button"
              className="font-medium underline"
              onClick={() => {
                pipelines.reload();
                stages.reload();
              }}
            >
              Try again
            </button>
          </Alert>
        </div>
      </Card>
    );
  }

  const complete = mapping ? stageMappingComplete(mapping) : false;
  const needsAttention =
    !connection.stageMappingComplete &&
    ["active", "paused", "importing"].includes(connection.status);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!mapping || !pipelineId) return;
    if (!complete) {
      setShowErrors(true);
      setError("Map every stage before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (pipelineId !== connection.pipelineId) {
        await api("/integrations/crm", { method: "PATCH", body: { pipelineId } });
      }
      await api("/integrations/crm/stage-mappings", {
        method: "PUT",
        body: stageMappingInput(mapping),
      });
      toast("Stage mapping saved");
      setShowErrors(false);
      saved.reload();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const crmStages = pipeline?.stages ?? [];
  const kindSuffix = (kind: string) => (kind === "open" ? "" : ` (${kind})`);

  return (
    <Card>
      <CardHeader
        title="Pipeline and stages"
        description={`Pick one ${crmName} deal pipeline. Deals in other pipelines are left alone.`}
        actions={needsAttention ? <Badge tone="warning">Needs attention</Badge> : null}
      />
      <form onSubmit={save} noValidate className="space-y-5 p-5">
        {needsAttention ? (
          <Alert tone="warning" title="Stage mapping needs attention">
            A stage was added or archived. Deal sync waits until every stage is mapped again;
            contacts and companies keep syncing.
          </Alert>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="max-w-sm space-y-1.5">
          <label
            htmlFor={pipelineSelectId}
            className="block text-sm font-medium text-slate-800 dark:text-slate-200"
          >
            {crmName} pipeline
          </label>
          <Select
            id={pipelineSelectId}
            value={pipelineId}
            disabled={!canAct || saving}
            onChange={(e) => setPipelineId(e.target.value)}
          >
            <option value="">Choose a pipeline…</option>
            {pipelineList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        {pipeline && mapping ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <fieldset className="min-w-0">
              <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Openline stage → {crmName} stage
              </legend>
              <ul className="mt-2 space-y-2">
                {mapping.toCrm.map((row, i) => {
                  const st = olStages.find((s) => s.id === row.stageId);
                  return (
                    <li key={row.stageId}>
                      <Field
                        label={`${st?.name ?? "Stage"} in Openline`}
                        error={showErrors && !row.remoteStageId ? "Choose a stage" : undefined}
                      >
                        {(p) => (
                          <Select
                            {...p}
                            value={row.remoteStageId ?? ""}
                            disabled={!canAct || saving}
                            onChange={(e) =>
                              setMapping((m) =>
                                m
                                  ? {
                                      ...m,
                                      toCrm: m.toCrm.map((r, j) =>
                                        j === i
                                          ? { ...r, remoteStageId: e.target.value || null }
                                          : r,
                                      ),
                                    }
                                  : m,
                              )
                            }
                          >
                            <option value="">Not mapped</option>
                            {crmStages.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                                {kindSuffix(s.kind)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {crmName} stage → Openline stage
              </legend>
              <ul className="mt-2 space-y-2">
                {mapping.fromCrm.map((row, i) => {
                  const st = crmStages.find((s) => s.id === row.remoteStageId);
                  return (
                    <li key={row.remoteStageId}>
                      <Field
                        label={`${st?.name ?? "Stage"}${st ? kindSuffix(st.kind) : ""} in ${crmName}`}
                        error={showErrors && !row.stageId ? "Choose a stage" : undefined}
                      >
                        {(p) => (
                          <Select
                            {...p}
                            value={row.stageId ?? ""}
                            disabled={!canAct || saving}
                            onChange={(e) =>
                              setMapping((m) =>
                                m
                                  ? {
                                      ...m,
                                      fromCrm: m.fromCrm.map((r, j) =>
                                        j === i ? { ...r, stageId: e.target.value || null } : r,
                                      ),
                                    }
                                  : m,
                              )
                            }
                          >
                            <option value="">Not mapped</option>
                            {olStages.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                    </li>
                  );
                })}
              </ul>
              {connection.provider === "pipedrive" ? (
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                  In Pipedrive, won and lost are deal statuses, not stages. Openline Won and Lost
                  set the status; a lost deal without a reason gets “Not given (from Pipedrive)”.
                </p>
              ) : null}
            </fieldset>
          </div>
        ) : null}

        {canAct ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving} disabled={!pipeline}>
              Save stage mapping
            </Button>
            {pipeline && mapping ? (
              <p className="text-sm text-slate-600 dark:text-slate-400" aria-live="polite">
                {complete ? "Every stage is mapped." : "Some stages aren't mapped yet."}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ fields

const LOCAL_TYPES: CrmLocalType[] = ["text", "number", "date", "boolean"];

function blankCustom(object: CrmObject): FieldMappingRow {
  return {
    object,
    localField: "custom.",
    localType: "text",
    remoteField: null,
    direction: "both",
    sourceOfTruth: "newest",
    standard: false,
  };
}

function FieldRow({
  row,
  index,
  remote,
  crmName,
  provider,
  canAct,
  error,
  onChange,
  onRemove,
}: {
  row: FieldMappingRow;
  index: number;
  remote: CrmRemoteFieldDto[] | undefined;
  crmName: string;
  provider: "hubspot" | "pipedrive";
  canAct: boolean;
  error?: string;
  onChange: (row: FieldMappingRow) => void;
  onRemove: () => void;
}) {
  const errorId = useId();
  const rowName = localFieldLabel(row.localField);
  const remoteField = remote?.find((f) => f.key === row.remoteField);
  const directions: CrmDirection[] =
    remoteField && !row.standard
      ? allowedDirections(remoteField)
      : ["both", "to_crm", "from_crm", "off"];
  const types = compatibleTypes(row.localType ?? "text");
  const candidates = (remote ?? []).filter((f) => types.includes(f.type));
  const described = error ? errorId : undefined;

  return (
    <li
      className={cx(
        "rounded-lg border p-3",
        error ? "border-red-400 dark:border-red-500" : "border-slate-200 dark:border-slate-800",
      )}
      data-testid={`field-row-${row.object}-${row.localField}`}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {row.standard ? (
          <div className="text-sm">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-400">Openline field</p>
            <p className="mt-1 font-medium text-slate-900 dark:text-slate-100">{rowName}</p>
            <p className="text-xs break-words text-slate-600 dark:text-slate-400">
              {crmName}:{" "}
              <code>
                {row.remoteField ??
                  STANDARD_REMOTE[provider][`${row.object}:${row.localField}`] ??
                  "standard field"}
              </code>
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <Field label="Openline custom field" className="min-w-0 flex-1">
                {(p) => (
                  <Input
                    {...p}
                    value={row.localField.replace(/^custom\./, "")}
                    disabled={!canAct}
                    placeholder="region"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby={described ?? p["aria-describedby"]}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) =>
                      onChange({ ...row, localField: `custom.${customKey(e.target.value)}` })
                    }
                  />
                )}
              </Field>
              <Field label="Type" className="w-28 shrink-0">
                {(p) => (
                  <Select
                    {...p}
                    value={row.localType ?? "text"}
                    disabled={!canAct}
                    onChange={(e) =>
                      onChange({
                        ...row,
                        localType: e.target.value as CrmLocalType,
                        remoteField: null,
                      })
                    }
                  >
                    {LOCAL_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label={`${crmName} property`}>
              {(p) => (
                <Select
                  {...p}
                  value={row.remoteField ?? ""}
                  disabled={!canAct}
                  aria-describedby={described ?? p["aria-describedby"]}
                  onChange={(e) => {
                    const f = remote?.find((x) => x.key === e.target.value);
                    const allowed = f ? allowedDirections(f) : null;
                    onChange({
                      ...row,
                      remoteField: e.target.value || null,
                      direction:
                        allowed && !allowed.includes(row.direction)
                          ? (allowed[0] ?? "from_crm")
                          : row.direction,
                    });
                  }}
                >
                  <option value="">Choose…</option>
                  {candidates.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                      {f.readOnly ? " (read-only)" : ""}
                      {f.type === "enumeration" ? " (picklist)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
        <Field label="Direction">
          {(p) => (
            <Select
              {...p}
              aria-label={`Direction for ${rowName}`}
              value={row.direction}
              disabled={!canAct}
              onChange={(e) => onChange({ ...row, direction: e.target.value as CrmDirection })}
            >
              {directions.map((d) => (
                <option key={d} value={d}>
                  {DIRECTION_LABELS[d].replace("CRM", crmName)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="If both sides change">
          {(p) => (
            <Select
              {...p}
              aria-label={`Source of truth for ${rowName}`}
              value={row.sourceOfTruth}
              disabled={!canAct || row.direction !== "both"}
              onChange={(e) =>
                onChange({ ...row, sourceOfTruth: e.target.value as CrmSourceOfTruth })
              }
            >
              {(Object.keys(SOURCE_OF_TRUTH_LABELS) as CrmSourceOfTruth[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_OF_TRUTH_LABELS[s].replace("CRM", crmName)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {error ? (
        <p id={errorId} className="mt-2 text-xs font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {!row.standard && canAct ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 text-red-700 dark:text-red-400"
          onClick={onRemove}
          aria-label={`Remove mapping ${index + 1} (${rowName})`}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}

export function FieldMappingCard({
  connection,
  canAct,
}: {
  connection: CrmConnectionDto;
  canAct: boolean;
}) {
  const { toast } = useToast();
  const crmName = CRM_PROVIDER_LABELS[connection.provider];
  const [object, setObject] = useState<CrmObject>("contact");
  const saved = useResource<CrmFieldMappingDto[]>("/integrations/crm/field-mappings");
  const remote = useResource<CrmRemoteFieldDto[]>("/integrations/crm/remote/fields", { object });
  const [remoteCache, setRemoteCache] = useState<Partial<Record<CrmObject, CrmRemoteFieldDto[]>>>(
    {},
  );
  const [rows, setRows] = useState<FieldMappingRow[] | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tabBase = useId();

  useEffect(() => {
    if (Array.isArray(saved.data)) setRows(saved.data);
  }, [saved.data]);
  useEffect(() => {
    const data = remote.data;
    if (Array.isArray(data)) setRemoteCache((c) => ({ ...c, [object]: data }));
  }, [remote.data, object]);

  async function save() {
    if (!rows) return;
    const problems = validateFieldMappings(rows, remoteCache);
    setErrors(problems);
    if (Object.keys(problems).length) {
      const first = rows[Number(Object.keys(problems)[0])];
      if (first && first.object !== object) setObject(first.object);
      setFormError("Please fix the highlighted mappings.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const next = await api<CrmFieldMappingDto[] | undefined>("/integrations/crm/field-mappings", {
        method: "PUT",
        body: fieldMappingsInput(rows),
      });
      if (Array.isArray(next)) {
        // Keep the custom type the admin picked (the API doesn't store it).
        const types = new Map(rows.map((r) => [`${r.object}:${r.localField}`, r.localType]));
        setRows(next.map((r) => ({ ...r, localType: types.get(`${r.object}:${r.localField}`) })));
      }
      toast("Field mapping saved");
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      const byRow: Record<number, string> = {};
      for (const [k, v] of Object.entries(fe)) {
        const m = /^mappings\.(\d+)/.exec(k);
        if (m) byRow[Number(m[1])] = v;
      }
      setErrors(byRow);
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const visible = (rows ?? [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.object === object);
  const customCount = visible.filter(({ row }) => !row.standard).length;

  return (
    <Card>
      <CardHeader
        title="Field mapping"
        description={`Which fields sync, in which direction, and who wins when Openline and ${crmName} both change a field. Email is the match key and is never overwritten.`}
      />
      <div className="p-5">
        <div
          role="tablist"
          aria-label="Record type"
          className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
        >
          {CRM_OBJECTS.map((o) => (
            <button
              key={o}
              type="button"
              role="tab"
              id={`${tabBase}-${o}`}
              aria-selected={object === o}
              aria-controls={`${tabBase}-panel`}
              tabIndex={object === o ? 0 : -1}
              onClick={() => setObject(o)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                const i = CRM_OBJECTS.indexOf(o);
                const next =
                  CRM_OBJECTS[
                    (i + (e.key === "ArrowRight" ? 1 : -1) + CRM_OBJECTS.length) %
                      CRM_OBJECTS.length
                  ];
                if (next) {
                  setObject(next);
                  document.getElementById(`${tabBase}-${next}`)?.focus();
                }
              }}
              className={cx(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none",
                object === o
                  ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                  : "border-transparent text-slate-700 hover:text-slate-900 dark:text-slate-300",
              )}
            >
              {CRM_OBJECT_LABELS[o]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabBase}-panel`} aria-labelledby={`${tabBase}-${object}`}>
          {formError ? (
            <Alert tone="error" className="mb-4">
              {formError}
            </Alert>
          ) : null}
          {saved.loading && !rows ? (
            <LoadingBlock label="Loading field mapping" />
          ) : saved.error ? (
            <Alert tone="error" title="Couldn't load the field mapping">
              {errorMessage(saved.error)}{" "}
              <button type="button" className="font-medium underline" onClick={saved.reload}>
                Try again
              </button>
            </Alert>
          ) : (
            <>
              <ul className="space-y-3">
                {visible.map(({ row, index }) => (
                  <FieldRow
                    key={row.id ?? `new-${index}`}
                    row={row}
                    index={index}
                    remote={remoteCache[object]}
                    crmName={crmName}
                    provider={connection.provider}
                    canAct={canAct}
                    error={errors[index]}
                    onChange={(next) =>
                      setRows((r) => r?.map((x, j) => (j === index ? next : x)) ?? null)
                    }
                    onRemove={() => {
                      setRows((r) => r?.filter((_, j) => j !== index) ?? null);
                      setErrors({});
                    }}
                  />
                ))}
              </ul>
              {remote.error ? (
                <p className="mt-3 text-sm text-red-700 dark:text-red-400">
                  Couldn&apos;t load {crmName} properties: {errorMessage(remote.error)}
                </p>
              ) : null}
              {canAct ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    disabled={customCount >= MAX_CUSTOM_MAPPINGS_PER_OBJECT}
                    onClick={() => setRows((r) => [...(r ?? []), blankCustom(object)])}
                  >
                    Add field mapping
                  </Button>
                  <Button loading={saving} onClick={() => void save()}>
                    Save field mapping
                  </Button>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {customCount} of {MAX_CUSTOM_MAPPINGS_PER_OBJECT} extra mappings. Picklists and
                    read-only {crmName} properties sync from {crmName} only.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ options

export function OptionsCard({
  connection,
  canAct,
  onSaved,
}: {
  connection: CrmConnectionDto;
  canAct: boolean;
  onSaved: (c: CrmConnectionDto) => void;
}) {
  const { toast } = useToast();
  const crmName = CRM_PROVIDER_LABELS[connection.provider];
  const members = useResource<MemberDto[]>("/members");
  const [options, setOptions] = useState<CrmOptions>(connection.options);
  const [owner, setOwner] = useState(connection.defaultOwnerId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    setOptions(connection.options);
    setOwner(connection.defaultOwnerId ?? "");
  }, [connection.options, connection.defaultOwnerId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        options:
          connection.provider === "pipedrive"
            ? options
            : { contactPush: options.contactPush, activityNotes: options.activityNotes },
      };
      if (owner) body.defaultOwnerId = owner;
      const updated = await api<CrmConnectionDto>("/integrations/crm", { method: "PATCH", body });
      if (updated && typeof updated === "object" && "status" in updated) onSaved(updated);
      toast("Sync options saved");
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const pushChoices: { value: CrmOptions["contactPush"]; title: string; body: string }[] = [
    {
      value: "engaged",
      title: "Only engaged contacts (recommended)",
      body: `On a deal, replied, or in a sequence. Keeps your ${crmName} contact count, and bill, down.`,
    },
    {
      value: "all",
      title: "All contacts",
      body: `Every new Openline contact is created in ${crmName}.`,
    },
    { value: "never", title: "Never", body: `Contacts are only pulled from ${crmName}.` },
  ];

  return (
    <Card>
      <CardHeader title="Sync options" />
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5 p-5">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <fieldset>
          <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Push new Openline contacts to {crmName}
          </legend>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            {pushChoices.map((c) => (
              <label
                key={c.value}
                className={cx(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-indigo-600",
                  options.contactPush === c.value
                    ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
                    : "border-slate-300 dark:border-slate-700",
                )}
              >
                <input
                  type="radio"
                  name={`${formId}-push`}
                  value={c.value}
                  checked={options.contactPush === c.value}
                  disabled={!canAct || saving}
                  onChange={() => setOptions((o) => ({ ...o, contactPush: c.value }))}
                  className="mt-0.5 accent-indigo-600"
                />
                <span>
                  <span className="block font-medium">{c.title}</span>
                  <span className="text-slate-600 dark:text-slate-400">{c.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Checkbox
          label={`Add an activity note in ${crmName} for each sent email and reply`}
          description="Subject line only, never the email body. Off by default."
          checked={options.activityNotes}
          disabled={!canAct || saving}
          onChange={(e) => setOptions((o) => ({ ...o, activityNotes: e.target.checked }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Default owner"
            hint={`Used when a ${crmName} owner has no Openline user with the same email.`}
            error={errors.defaultOwnerId}
          >
            {(p) => (
              <Select
                {...p}
                value={owner}
                disabled={!canAct || saving || !members.data}
                onChange={(e) => setOwner(e.target.value)}
              >
                <option value="">The admin who connected</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {connection.provider === "pipedrive" ? (
            <Field
              label="Daily Pipedrive API budget (tokens)"
              hint={`Pipedrive shares one daily budget across your company's tools. Sync stops for the day at this cap.${connection.budget ? ` Used today: ${connection.budget.spent.toLocaleString()}.` : ""}`}
              error={errors["options.pipedriveDailyCap"]}
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={1000}
                  step={500}
                  value={String(options.pipedriveDailyCap)}
                  disabled={!canAct || saving}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, pipedriveDailyCap: Number(e.target.value) || 0 }))
                  }
                />
              )}
            </Field>
          ) : null}
        </div>
        {canAct ? (
          <Button type="submit" loading={saving}>
            Save options
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ import

function PreviewCountsView({ preview, crmName }: { preview: CrmRunDto; crmName: string }) {
  return (
    <dl className="grid gap-3 md:grid-cols-3" data-testid="preview-counts">
      {CRM_OBJECTS.map((o) => {
        const c = previewCounts(preview.counts[o]);
        const inCrm = c.create + c.link + c.update + c.skipped;
        const line = (n: number, text: string, testId: string) => (
          <li data-testid={`preview-${o}-${testId}`}>
            <span className="font-medium tabular-nums">{n.toLocaleString()}</span> {text}
          </li>
        );
        return (
          <div
            key={o}
            className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800"
            data-testid={`preview-${o}`}
          >
            <dt className="font-semibold text-slate-900 dark:text-slate-100">
              {CRM_OBJECT_LABELS[o]}{" "}
              <span className="font-normal text-slate-600 dark:text-slate-400">
                ({inCrm.toLocaleString()} in {crmName})
              </span>
            </dt>
            <dd>
              <ul className="mt-2 space-y-0.5">
                {line(c.create, "to create in Openline", "create")}
                {line(
                  c.link,
                  `to link to existing${c.matchedByName ? ` (${c.matchedByName} matched by name)` : ""}`,
                  "link",
                )}
                {line(c.update, "to update", "update")}
                {line(
                  c.skipped,
                  `skipped${c.skippedReasons.length ? ` (${c.skippedReasons.map((r) => `${r.count} ${r.label}`).join(", ")})` : ""}`,
                  "skipped",
                )}
                {line(c.onlyInOpenline, "only in Openline", "only")}
              </ul>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function ImportCard({
  connection,
  canAct,
  stagesReady,
  onStarted,
}: {
  connection: CrmConnectionDto;
  canAct: boolean;
  stagesReady: boolean;
  onStarted: () => void;
}) {
  const { toast } = useToast();
  const crmName = CRM_PROVIDER_LABELS[connection.provider];
  const [preview, setPreview] = useState<CrmRunDto | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pushLocalOnly, setPushLocalOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmErrorId = useId();

  // A preview runs in the background: poll its run until it finishes.
  async function waitForRun(runId: string): Promise<CrmRunDto> {
    for (let i = 0; i < 200; i += 1) {
      const run = await api<CrmRunDto>(`/integrations/crm/runs/${runId}`);
      if (run.status !== "running") return run;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error("The preview is taking longer than expected. Check back in a minute.");
  }

  function showPreview(run: CrmRunDto) {
    if (run.status === "failed") {
      setPreview(null);
      setError(
        `The preview didn't finish${run.errorCode ? ` (${errorCodeLabel(run.errorCode)})` : ""}. Please run it again.`,
      );
      return;
    }
    setPreview(run);
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const { runId } = await api<{ runId: string }>("/integrations/crm/import/preview", {
        method: "POST",
      });
      showPreview(await waitForRun(runId));
    } catch (err) {
      setError(
        err instanceof Error && !(err instanceof ApiError) ? err.message : errorMessage(err),
      );
    } finally {
      setPreviewing(false);
    }
  }

  // Coming back to a connection with a preview ready: show the latest one that's still valid.
  const status = connection.status;
  useEffect(() => {
    if (status !== "previewing" || !canAct) return;
    let cancelled = false;
    api<CrmPage<CrmRunDto>>("/integrations/crm/runs", { query: { limit: 5 } })
      .then(async (page) => {
        const latest = page.items.find((r) => r.kind === "preview");
        if (!latest || cancelled) return;
        if (latest.status === "running") {
          setPreviewing(true);
          const done = await waitForRun(latest.id);
          if (!cancelled) showPreview(done);
          setPreviewing(false);
        } else if (
          (latest.status === "succeeded" || latest.status === "partial") &&
          latest.expiresAt &&
          new Date(latest.expiresAt).getTime() > Date.now()
        ) {
          setPreview(latest);
        }
      })
      .catch(() => {
        // Nothing to restore; the admin can run the preview again.
      });
    return () => {
      cancelled = true;
    };
  }, [status, canAct]);

  async function start() {
    if (!preview) return;
    if (!confirm) {
      setConfirmError("Confirm you have a lawful basis to contact these people");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      await api("/integrations/crm/import", {
        method: "POST",
        body: { previewId: preview.id, confirmLawfulBasis: true, pushLocalOnly },
      });
      toast("Import started");
      setPreview(null);
      setConfirm(false);
      onStarted();
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      if (fe.confirmLawfulBasis) setConfirmError(fe.confirmLawfulBasis);
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  const imported = !["needs_setup", "previewing"].includes(connection.status);

  if (imported) {
    return (
      <Card>
        <CardHeader
          title="Import"
          description={
            connection.status === "importing"
              ? `Importing from ${crmName}. You can leave this page; it carries on in the background.`
              : `The first import from ${crmName} is done. Changes now sync both ways.`
          }
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={imported ? "Import" : "Preview and import"}
        description={
          imported
            ? `The first import from ${crmName} is done. Changes now sync both ways.`
            : `See exactly what will happen before anything changes. A preview writes nothing to Openline or ${crmName}.`
        }
      />
      <div className="space-y-4 p-5">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!stagesReady && !imported ? (
          <Alert tone="info">Save a complete stage mapping first.</Alert>
        ) : null}
        {preview ? (
          <>
            {previewNote(preview) ? (
              <Alert tone="warning" title="Partial preview">
                {previewNote(preview)}
              </Alert>
            ) : null}
            <PreviewCountsView preview={preview} crmName={crmName} />
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {preview.expiresAt
                ? `Preview valid until ${new Date(preview.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. `
                : ""}
              Suppressed people stay suppressed; imported contacts start with no consent basis.
            </p>
            <div className="space-y-3">
              <Checkbox
                label="I confirm we have a lawful basis to contact the people imported from the CRM"
                description="Required, as for a CSV import."
                checked={confirm}
                onChange={(e) => {
                  setConfirm(e.target.checked);
                  setConfirmError(null);
                }}
                aria-invalid={confirmError ? true : undefined}
                aria-errormessage={confirmError ? confirmErrorId : undefined}
              />
              {confirmError ? (
                <p
                  id={confirmErrorId}
                  className="text-xs font-medium text-red-700 dark:text-red-400"
                  role="alert"
                >
                  {confirmError}
                </p>
              ) : null}
              <Checkbox
                label={`Also push records that are only in Openline to ${crmName} now`}
                description="Otherwise they're pushed as they change (deals always; contacts by your push rule)."
                checked={pushLocalOnly}
                onChange={(e) => setPushLocalOnly(e.target.checked)}
              />
            </div>
          </>
        ) : null}
        {imported ? null : canAct ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={preview ? "secondary" : "primary"}
              loading={previewing}
              disabled={(!stagesReady && !imported) || connection.status === "importing"}
              onClick={() => void runPreview()}
            >
              {preview ? "Run preview again" : "Run preview"}
            </Button>
            {preview ? (
              <Button loading={starting} onClick={() => void start()}>
                Start import
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Only owners and admins can import.
          </p>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ disconnect

export function DisconnectDialog({
  connection,
  open,
  onClose,
  onDone,
}: {
  connection: CrmConnectionDto;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const crmName = CRM_PROVIDER_LABELS[connection.provider];
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForget(false);
      setError(null);
    }
  }, [open]);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api("/integrations/crm", {
        method: "DELETE",
        query: forget ? { forgetLinks: true } : undefined,
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Disconnect ${crmName}?`}
      description={`Sync stops in both directions and Openline's access to ${crmName} is revoked.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void disconnect()}>
            Disconnect {crmName}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <ul className="list-disc space-y-1 pl-5">
          <li>Nothing is deleted in {crmName} or in Openline.</li>
          <li>
            Openline keeps which records were linked (ids only), so reconnecting the same {crmName}{" "}
            account picks up where it left off without duplicates.
          </li>
          <li>Suppressions pulled from {crmName} stay in place.</li>
        </ul>
        <Checkbox
          label="Disconnect and forget links"
          description="Clears the record links too. A later reconnect matches records again by email, domain and exact deal name."
          checked={forget}
          onChange={(e) => setForget(e.target.checked)}
        />
        {forget ? (
          <Alert tone="warning" title="Before you forget links">
            {DISCONNECT_FORGET_WARNING}
          </Alert>
        ) : null}
        <p>
          <Link
            href="/help/crm-sync#disconnecting"
            className="font-medium text-indigo-700 underline dark:text-indigo-300"
          >
            What disconnecting does
          </Link>
        </p>
      </div>
    </Dialog>
  );
}
