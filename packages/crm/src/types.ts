/**
 * The provider interface. CRM-neutral on purpose (ADR 0006: adding a third CRM must not leak
 * HubSpot or Pipedrive concepts into the engine): records carry canonical field keys, and each
 * provider translates to its own properties.
 */
import type { CrmObject, CrmProvider } from "@openline/shared";

/**
 * Canonical field keys a provider understands natively, per object. Custom CRM fields use
 * `custom:<remote key>`. Deal `stage` is the CRM stage id, or `@won` / `@lost` for CRMs where
 * won/lost is a status rather than a stage (Pipedrive).
 */
export const CANONICAL_FIELDS = {
  contact: ["email", "firstName", "lastName", "title", "phone", "companyId", "ownerId"],
  company: ["name", "domain"],
  deal: [
    "name",
    "amount",
    "currency",
    "stage",
    "expectedCloseDate",
    "lostReason",
    "companyId",
    "primaryContactId",
    "ownerId",
  ],
} as const satisfies Record<CrmObject, readonly string[]>;

export const WON = "@won";
export const LOST = "@lost";

export interface RemoteRecord {
  id: string;
  object: CrmObject;
  /** CRM last-modified time (the conflict rule's "their" timestamp). */
  modifiedAt: Date;
  createdAt?: Date;
  /** Canonical and `custom:<key>` values as provider-normalized raw strings (still untrusted). */
  fields: Record<string, string | null>;
  /** Deals: the pipeline the deal is in. */
  pipelineId?: string | null;
  /** Deals: further associated contacts (beyond primaryContactId). */
  contactIds?: string[];
  /** Contacts: opted out of email in the CRM. */
  optedOut?: boolean;
  /** Deleted / archived in the CRM. */
  archived?: boolean;
}

export interface RemotePage {
  records: RemoteRecord[];
  /** Opaque cursor for the next page; undefined = done. */
  next?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  scopes: string[];
}

export interface AccountInfo {
  accountId: string;
  accountName: string | null;
  /** Pipedrive: the company's API domain (validated against the allowlist). */
  apiDomain?: string;
  /** Currencies the CRM can hold on a deal; null = any. */
  currencies: string[] | null;
  defaultCurrency: string | null;
  /** HubSpot portal id, for record links. */
  portalId?: string;
}

export interface RemotePipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; kind: "open" | "won" | "lost" }[];
}

export interface RemoteField {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "enumeration";
  readOnly: boolean;
}

export interface RemoteOwner {
  id: string;
  email: string;
}

export interface CreateAssociations {
  companyId?: string | null;
  contactId?: string | null;
}

export type OptOutResult = "done" | "not_permitted" | "unsupported";

/** Counters for the run log. */
export interface CallMeter {
  calls: number;
  tokens: number;
}

/** Called before each request; throws CrmError("budget") when the daily budget is spent. */
export type SpendHook = (cost: number) => void;

/** An authorized session against one CRM account. */
export interface CrmApi {
  readonly provider: CrmProvider;
  /** Fields the provider maps natively (for which a standard mapping needs no remote key). */
  nativeFields(object: CrmObject): readonly string[];
  account(): Promise<AccountInfo>;
  pipelines(): Promise<RemotePipeline[]>;
  fields(object: CrmObject): Promise<RemoteField[]>;
  owners(): Promise<RemoteOwner[]>;
  /** Initial import: everything, oldest first, paged. `custom` = extra remote keys to read. */
  listAll(object: CrmObject, opts: { after?: string; custom: string[] }): Promise<RemotePage>;
  /** Incremental: modified at or after `since`, ascending by modified time, paged. */
  listChanged(
    object: CrmObject,
    opts: { since: Date; after?: string; custom: string[] },
  ): Promise<RemotePage>;
  /**
   * Reads ids; `missing` = gone (deleted), `merged` = old id → surviving id.
   */
  getMany(
    object: CrmObject,
    ids: string[],
    custom: string[],
  ): Promise<{ found: RemoteRecord[]; missing: string[]; merged: Record<string, string> }>;
  create(
    object: CrmObject,
    fields: Record<string, string | null>,
    assoc: CreateAssociations,
    pipelineId?: string | null,
  ): Promise<RemoteRecord>;
  update(object: CrmObject, id: string, fields: Record<string, string | null>): Promise<void>;
  /** Sets associations (contact→company, deal→company / primary contact). */
  associate(object: CrmObject, id: string, assoc: CreateAssociations): Promise<void>;
  /**
   * Recovery lookups: contact by email, company by domain, deal by exact name in the pipeline
   * created after `createdAfter`.
   */
  findByKey(
    object: CrmObject,
    key: {
      email?: string;
      domain?: string;
      name?: string;
      createdAfter?: Date;
      pipelineId?: string;
    },
  ): Promise<RemoteRecord[]>;
  /** Pushes an opt-out (never a re-subscribe). */
  optOut(contactId: string, email: string): Promise<OptOutResult>;
  /** Append-only activity note on a contact (and its deal). */
  addNote(target: { contactId: string; dealId?: string }, text: string): Promise<void>;
  /** Link to the record in the CRM's UI. */
  recordUrl(object: CrmObject, id: string): string | null;
}

/** OAuth for one provider (client credentials only, no account). */
export interface CrmOAuth {
  readonly provider: CrmProvider;
  readonly supportsPkce: boolean;
  /** Scopes requested at consent. */
  readonly scopes: { required: string[]; optional: string[] };
  authorizeUrl(p: { state: string; redirectUri: string; codeChallenge?: string }): string;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<{
    tokens: TokenSet;
    account: AccountInfo;
  }>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Best effort; the caller never lets a failure block a local disconnect. */
  revoke(tokens: { refreshToken: string; accessToken?: string }): Promise<void>;
  /** A session for API calls. */
  api(p: {
    accessToken: string;
    apiDomain?: string | null;
    portalId?: string | null;
    meter: CallMeter;
    spend?: SpendHook;
    limiterKey: string;
  }): CrmApi;
}

/** Sealed in crm_connections.secret_sealed (AES-256-GCM, workspace id as AAD). */
export interface CrmSecret {
  kind: "oauth";
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
}
