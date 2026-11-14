"use client";

import { useEffect, useState } from "react";
import { ContactCreateSchema, type ContactCreate, type ContactDto } from "@openline/shared";
import { Field, Input, Select } from "@/components/ui";
import { zodFieldErrors } from "@/lib/format";

export const CONTACT_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "title",
  "phone",
  "companyName",
  "companyDomain",
  "timeZone",
  "country",
] as const;
export type ContactFormKey = (typeof CONTACT_FIELDS)[number];
export type ContactFormValues = Record<ContactFormKey, string>;

export const emptyContactValues: ContactFormValues = {
  email: "",
  firstName: "",
  lastName: "",
  title: "",
  phone: "",
  companyName: "",
  companyDomain: "",
  timeZone: "",
  country: "",
};

export function valuesFromContact(c: ContactDto): ContactFormValues {
  return {
    email: c.email,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    title: c.title ?? "",
    phone: c.phone ?? "",
    companyName: c.company?.name ?? "",
    companyDomain: c.company?.domain ?? "",
    timeZone: c.timeZone ?? "",
    country: c.country ?? "",
  };
}

/**
 * Validates the form with the shared schema. Empty optional fields become null.
 * Consent is not edited here: it needs a source and date, so it goes through PUT /consent.
 */
export function parseContactValues(
  values: ContactFormValues,
): { ok: true; data: ContactCreate } | { ok: false; errors: Record<string, string> } {
  const input = {
    ...values,
    country: values.country.trim() === "" ? null : values.country,
    companyDomain: values.companyDomain.trim() === "" ? null : values.companyDomain,
  };
  const parsed = ContactCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error.issues) };
  return { ok: true, data: parsed.data };
}

/** IANA time zones supported by this browser (empty until mounted). */
export function useTimeZones(): string[] {
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => {
    try {
      setZones(Intl.supportedValuesOf("timeZone"));
    } catch {
      setZones([]);
    }
  }, []);
  return zones;
}

export function ContactFields({
  values,
  errors,
  onChange,
  disabled,
}: {
  values: ContactFormValues;
  errors: Record<string, string>;
  onChange: (key: ContactFormKey, value: string) => void;
  disabled?: boolean;
}) {
  const zones = useTimeZones();
  const text = (key: ContactFormKey) => ({
    value: values[key],
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange(key, e.target.value),
  });

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Email" error={errors.email} required className="sm:col-span-2">
        {(p) => <Input {...p} {...text("email")} type="email" autoComplete="off" required />}
      </Field>
      <Field label="First name" error={errors.firstName}>
        {(p) => <Input {...p} {...text("firstName")} autoComplete="off" />}
      </Field>
      <Field label="Last name" error={errors.lastName}>
        {(p) => <Input {...p} {...text("lastName")} autoComplete="off" />}
      </Field>
      <Field label="Job title" error={errors.title}>
        {(p) => <Input {...p} {...text("title")} autoComplete="off" />}
      </Field>
      <Field label="Phone" error={errors.phone}>
        {(p) => <Input {...p} {...text("phone")} type="tel" autoComplete="off" />}
      </Field>
      <Field label="Company name" error={errors.companyName}>
        {(p) => <Input {...p} {...text("companyName")} autoComplete="off" />}
      </Field>
      <Field
        label="Company domain"
        hint="Leave blank to use the email's domain"
        error={errors.companyDomain}
      >
        {(p) => (
          <Input {...p} {...text("companyDomain")} placeholder="acme.com" autoComplete="off" />
        )}
      </Field>
      <Field label="Time zone" hint="Used for local send windows" error={errors.timeZone}>
        {(p) => (
          <Select {...p} {...text("timeZone")}>
            <option value="">Not set</option>
            {values.timeZone && !zones.includes(values.timeZone) ? (
              <option value={values.timeZone}>{values.timeZone}</option>
            ) : null}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Country" hint="2-letter code, e.g. US, CA, GB" error={errors.country}>
        {(p) => (
          <Input
            {...p}
            {...text("country")}
            maxLength={2}
            autoComplete="off"
            className="uppercase"
          />
        )}
      </Field>
    </div>
  );
}
