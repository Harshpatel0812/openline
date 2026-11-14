"use client";

import { useEffect, useState, type FormEvent } from "react";
import { WorkspaceSettingsInputSchema, type WorkspaceSettingsDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useTimeZones } from "@/components/app/contact-form";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  LoadingBlock,
  Select,
  Textarea,
  useToast,
} from "@/components/ui";
import { api, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { zodFieldErrors } from "@/lib/format";
import { useResource } from "@/lib/use-resource";

interface Values {
  name: string;
  mailingAddress: string;
  defaultTimeZone: string;
}

const fromDto = (w: WorkspaceSettingsDto): Values => ({
  name: w.name,
  mailingAddress: w.mailingAddress ?? "",
  defaultTimeZone: w.defaultTimeZone,
});

export default function WorkspaceSettingsPage() {
  const { can, reload: reloadMe } = useMe();
  const { toast } = useToast();
  const canEdit = can("owner", "admin");
  const zones = useTimeZones();
  const { data, error, loading, reload, setData } = useResource<WorkspaceSettingsDto>("/workspace");
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setValues(fromDto(data));
  }, [data]);

  if (loading && !data) return <LoadingBlock label="Loading workspace settings" />;
  if (error || !data || !values) {
    return (
      <div className="max-w-xl space-y-4">
        <PageHeader title="Workspace" />
        <Alert tone="error" title="Couldn't load workspace settings">
          {errorMessage(error)}
        </Alert>
        <Button variant="secondary" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }

  const dirty = JSON.stringify(values) !== JSON.stringify(fromDto(data));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    setFormError(null);
    const parsed = WorkspaceSettingsInputSchema.safeParse({
      name: values.name,
      mailingAddress: values.mailingAddress.trim() === "" ? undefined : values.mailingAddress,
      defaultTimeZone: values.defaultTimeZone,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const updated = await api<WorkspaceSettingsDto>("/workspace", {
        method: "PATCH",
        body: parsed.data,
      });
      setData(() => updated);
      toast("Workspace settings saved");
      // The workspace name also appears in the app header.
      if (updated.name !== data?.name) reloadMe();
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      setFormError(
        Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof Values) => (value: string) =>
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev));
  const disabled = !canEdit || saving;

  return (
    <>
      <PageHeader
        title="Workspace"
        description="Details that appear in every email your team sends."
      />
      <Card className="max-w-2xl">
        <CardHeader title="General" />
        <form onSubmit={onSubmit} noValidate className="space-y-5 p-5">
          {!canEdit ? (
            <Alert tone="info">Only workspace owners and admins can change these settings.</Alert>
          ) : null}
          {!data.mailingAddress ? (
            <Alert tone="warning" title="Mailing address missing">
              Sequences can&apos;t be activated until you add a postal address.
            </Alert>
          ) : null}
          {formError ? <Alert tone="error">{formError}</Alert> : null}

          <Field label="Workspace name" error={errors.name} required>
            {(p) => (
              <Input
                {...p}
                value={values.name}
                onChange={(e) => set("name")(e.target.value)}
                disabled={disabled}
                maxLength={100}
                autoComplete="organization"
              />
            )}
          </Field>

          <Field
            label="Mailing address"
            required
            error={errors.mailingAddress}
            hint={
              <>
                Your physical postal address. The law (CAN-SPAM in the US, CASL in Canada) requires
                it in every commercial email, so Openline adds it to each email&apos;s footer. A
                registered PO box or commercial mail-receiving address is fine.
              </>
            }
          >
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={values.mailingAddress}
                onChange={(e) => set("mailingAddress")(e.target.value)}
                disabled={disabled}
                maxLength={300}
                autoComplete="street-address"
                placeholder={"Acme Inc.\n123 Main Street, Suite 400\nJersey City, NJ 07302, USA"}
              />
            )}
          </Field>

          <Field
            label="Default time zone"
            hint="Used for contacts without their own time zone. Send windows follow each contact's local time."
            error={errors.defaultTimeZone}
          >
            {(p) => (
              <Select
                {...p}
                value={values.defaultTimeZone}
                onChange={(e) => set("defaultTimeZone")(e.target.value)}
                disabled={disabled}
              >
                {!zones.includes(values.defaultTimeZone) ? (
                  <option value={values.defaultTimeZone}>
                    {values.defaultTimeZone.replaceAll("_", " ")}
                  </option>
                ) : null}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {canEdit ? (
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="secondary"
                disabled={!dirty || saving}
                onClick={() => {
                  setValues(fromDto(data));
                  setErrors({});
                  setFormError(null);
                }}
              >
                Discard changes
              </Button>
              <Button type="submit" loading={saving} disabled={!dirty}>
                Save changes
              </Button>
            </div>
          ) : null}
        </form>
      </Card>
    </>
  );
}
