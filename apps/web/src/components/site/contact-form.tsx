"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  CONTACT_FORM_TEAM_SIZES,
  ContactFormInputSchema,
  type ContactFormResponse,
} from "@openline/shared";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError, fieldErrorsFrom } from "@/lib/api";

type FieldName = "name" | "email" | "company" | "teamSize" | "message";

const FIELD_ORDER: FieldName[] = ["name", "email", "company", "teamSize", "message"];

const empty = { name: "", email: "", company: "", teamSize: "", message: "", website: "" };

export function ContactForm() {
  const [values, setValues] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const successRef = useRef<HTMLDivElement>(null);

  const set = (key: keyof typeof empty) => (value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  const focusFirstError = (errs: Partial<Record<FieldName, string>>) => {
    const first = FIELD_ORDER.find((f) => errs[f]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    const parsed = ContactFormInputSchema.safeParse(values);
    if (!parsed.success) {
      const errs: Partial<Record<FieldName, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && (FIELD_ORDER as string[]).includes(key)) {
          const field = key as FieldName;
          errs[field] ??= issue.message;
        }
      }
      setErrors(errs);
      focusFirstError(errs);
      return;
    }

    setErrors({});
    setSending(true);
    try {
      await api<ContactFormResponse>("/public/contact", {
        method: "POST",
        body: parsed.data,
        redirectOn401: false,
      });
      setSent(true);
      setValues(empty);
      requestAnimationFrame(() => successRef.current?.focus());
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const apiErrors = fieldErrorsFrom(err);
        const errs: Partial<Record<FieldName, string>> = {};
        for (const f of FIELD_ORDER) if (apiErrors[f]) errs[f] = apiErrors[f];
        setErrors(errs);
        if (Object.keys(errs).length > 0) focusFirstError(errs);
        else setFormError(err.message);
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError(
          "You've sent several messages in a short time. Please wait a few minutes and try again, or email us directly.",
        );
      } else {
        setFormError("We couldn't send your message. Please try again, or email us directly.");
      }
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div ref={successRef} tabIndex={-1} className="focus:outline-none">
        <Alert tone="success" title="Thanks — your message is on its way">
          A person on our team will reply to the work email you gave us.
        </Alert>
        <Button variant="secondary" className="mt-4" onClick={() => setSent(false)}>
          Send another message
        </Button>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      className="space-y-5"
      aria-label="Contact us"
    >
      {formError ? (
        <Alert tone="error" title="Message not sent">
          {formError}
        </Alert>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" required error={errors.name}>
          {(p) => (
            <Input
              {...p}
              name="name"
              autoComplete="name"
              required
              value={values.name}
              onChange={(e) => set("name")(e.target.value)}
            />
          )}
        </Field>
        <Field label="Work email" required error={errors.email}>
          {(p) => (
            <Input
              {...p}
              name="email"
              type="email"
              autoComplete="email"
              required
              value={values.email}
              onChange={(e) => set("email")(e.target.value)}
            />
          )}
        </Field>
        <Field label="Company" error={errors.company}>
          {(p) => (
            <Input
              {...p}
              name="company"
              autoComplete="organization"
              value={values.company}
              onChange={(e) => set("company")(e.target.value)}
            />
          )}
        </Field>
        <Field label="Team size" error={errors.teamSize}>
          {(p) => (
            <Select
              {...p}
              name="teamSize"
              value={values.teamSize}
              onChange={(e) => set("teamSize")(e.target.value)}
            >
              <option value="">Choose…</option>
              {CONTACT_FORM_TEAM_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size === "1" ? "Just me" : `${size} people`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field
        label="Message"
        required
        error={errors.message}
        hint="What would you like to know? Please don't include passwords or other sensitive details."
      >
        {(p) => (
          <Textarea
            {...p}
            name="message"
            rows={6}
            required
            value={values.message}
            onChange={(e) => set("message")(e.target.value)}
          />
        )}
      </Field>
      {/* Honeypot for bots: hidden from people and assistive technology. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="contact-website">Leave this field empty</label>
        <input
          id="contact-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(e) => set("website")(e.target.value)}
        />
      </div>
      <Button type="submit" size="lg" loading={sending}>
        {sending ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}
