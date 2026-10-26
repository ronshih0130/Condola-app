import type { Client } from "pg";
import { svc } from "../db";
import {
  createCase as createDomainCase,
  transition,
  replacementLine,
  type Event,
  type Role,
  type Signer,
  type SigningCase,
  type Version,
} from "./rules";
import type { GeneratedContractProof } from "./stamp";

export type Connection = Pick<Client, "query">;
export type TransactionRunner = <T>(
  actorId: string,
  work: (client: Connection) => Promise<T>,
) => Promise<T>;

/** The implementation must check a single-use challenge bound to this signer/version.
 * Codes are passed only to this interface and are never persisted in e-sign tables.
 * No delivery implementation is installed here.
 */
export interface EmailVerifier {
  check(input: {
    caseId: string;
    versionId: string;
    signerId: string;
    email: string;
    response: string;
  }): Promise<boolean>;
}

export type Actor = { userId: string; orgId: string };
export type SignerInput = {
  id: string;
  role: "owner" | "tenant";
  email: string;
  documentCheckRequired?: boolean;
};

type StoredVersion = {
  id: string;
  state: Version;
  pdf_bytes: Buffer;
  final_pdf_bytes: Buffer | null;
};

type SafeEvent = Exclude<Event, {
  type: "check_identity" | "sign" | "create_version";
}>;
type EventInput<T> = T extends unknown ? Omit<T, "actorId" | "role"> : never;
export type WorkflowEvent = EventInput<SafeEvent>;
export type SignatureInput = Omit<
  Extract<Event, { type: "sign" }>,
  "type" | "actorId" | "role" | "imageRef" | "finalDigest"
> & { imageBytes: Uint8Array; finalPdfBytes?: Uint8Array };

function status(v: Version): string {
  if (v.status === "completed") return "fully_signed";
  if (v.status === "signing") return "partially_signed";
  return v.status;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Each operation locks the case before reading domain state. The injected runner
 * must provide a service_role transaction and set the authenticated actor claim.
 * Actor IDs and org IDs must come from the authenticated server session.
 */
export class EsignRepo {
  constructor(
    private readonly emailVerifier: EmailVerifier,
    private readonly run: TransactionRunner = svc,
  ) {}

  private async lock(client: Connection, actor: Actor, caseId: string) {
    const result = await client.query(
      `SELECT id FROM esign_cases WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [caseId, actor.orgId],
    );
    requireValue(result.rowCount === 1, "Unknown signing case");
  }

  private async role(
    client: Connection,
    actor: Actor,
    version?: Version,
  ): Promise<Role> {
    const member = await client.query<{ role: string }>(
      `SELECT role::text FROM org_members
       WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [actor.orgId, actor.userId],
    );
    if (member.rows[0]?.role === "admin") return "company_admin";
    if (member.rows[0]?.role === "manager") return "company_staff";
    const signer = version?.signers.find((s) => s.id === actor.userId);
    requireValue(signer, "Actor has no signing permission");
    return signer.role;
  }

  private async admin(client: Connection, actor: Actor) {
    requireValue(await this.role(client, actor) === "company_admin", "Company admin required");
  }

  private async load(client: Connection, caseId: string) {
    const rows = await client.query<StoredVersion>(
      `SELECT id, state, pdf_bytes, final_pdf_bytes FROM esign_versions
       WHERE case_id = $1 ORDER BY created_at, id`,
      [caseId],
    );
    const events = await client.query<{ payload: SigningCase["audit"][number] }>(
      `SELECT payload FROM esign_audit_events
       WHERE case_id = $1 AND event_type = 'domain'
       ORDER BY sequence_no`,
      [caseId],
    );
    return {
      rows: rows.rows,
      state: {
        versions: rows.rows.map((r) => r.state),
        audit: events.rows.map((r) => r.payload),
      } satisfies SigningCase,
    };
  }

  private async insertVersion(
    client: Connection,
    caseId: string,
    version: Version,
    pdf: Uint8Array,
    emails: Map<string, string>,
    effective?: Version,
  ) {
    requireValue(await digest(pdf) === version.documentDigest, "PDF digest mismatch");
    await client.query(
      `INSERT INTO esign_versions
       (id, case_id, body, pdf_bytes, content_digest, previous_version_id,
        supersedes_version_id, replacement_text, state, retention_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'infinity')`,
      [
        version.id, caseId, version.body, Buffer.from(pdf), version.documentDigest,
        version.previous_version_id ?? null, version.supersedes_version_id ?? null,
        effective?.completedAt ? replacementLine(effective.completedAt) : null,
        JSON.stringify(version),
      ],
    );
    for (const signer of version.signers) {
      const email = emails.get(signer.id);
      requireValue(email, "Signer email required");
      await client.query(
        `INSERT INTO esign_signers(version_id, id, party_role, email, state)
         VALUES ($1,$2,$3,$4,$5)`,
        [version.id, signer.id, signer.role, email, JSON.stringify(signer)],
      );
    }
  }

  private async save(
    client: Connection,
    caseId: string,
    before: SigningCase,
    after: SigningCase,
    finalPdf?: Uint8Array,
  ) {
    // Signer rows and image evidence must exist before the version is finalized.
    for (const v of after.versions) {
      const old = before.versions.find((x) => x.id === v.id);
      if (!old || JSON.stringify(old) === JSON.stringify(v)) continue;
      for (const s of v.signers) {
        const prior = old.signers.find((x) => x.id === s.id);
        if (JSON.stringify(prior) === JSON.stringify(s)) continue;
        await client.query(
          `UPDATE esign_signers SET state = $3, email_step_state = $4,
             email_step_at = $5, signed_at = $6 WHERE version_id = $1 AND id = $2`,
          [
            v.id, s.id, JSON.stringify(s), s.identity?.result ?? "pending",
            s.identity?.at ?? null, s.signature?.signedAt ?? null,
          ],
        );
      }
    }

    // Persist the completed replacement before changing its predecessor.
    const changed = after.versions.filter((v) => {
      const old = before.versions.find((x) => x.id === v.id);
      return old && JSON.stringify(old) !== JSON.stringify(v);
    }).sort((a, b) => Number(a.status === "superseded") - Number(b.status === "superseded"));

    for (const v of changed) {
      const old = before.versions.find((x) => x.id === v.id)!;
      const completing = v.status === "completed" && old.status !== "completed";
      if (completing) requireValue(finalPdf, "Final PDF required");
      await client.query(
        `UPDATE esign_versions SET status = $2, state = $3,
          final_pdf_bytes = CASE WHEN $4::boolean THEN $5::bytea ELSE final_pdf_bytes END,
          final_digest = $6, completed_at = $7, void_reason = $8,
          voided_by = $9, voided_at = $10 WHERE id = $1`,
        [
          v.id, status(v), JSON.stringify(v), completing,
          completing ? Buffer.from(finalPdf!) : null,
          v.finalDigest ?? null, v.completedAt ?? null, v.voidReason ?? null,
          v.voided_by ?? null, v.voided_at ?? null,
        ],
      );
    }
    for (const event of after.audit.slice(before.audit.length)) {
      await client.query(
        `INSERT INTO esign_audit_events(case_id, version_id, event_type, payload)
         VALUES ($1,$2,'domain',$3)`,
        [caseId, event.versionId, JSON.stringify(event)],
      );
    }
  }

  async createCase(actor: Actor, input: {
    caseId: string;
    leaseId: string;
    versionId: string;
    body: string;
    pdfBytes: Uint8Array;
    signers: readonly SignerInput[];
    order?: "parallel" | "sequential";
  }): Promise<SigningCase> {
    return this.run(actor.userId, async (client) => {
      await this.admin(client, actor);
      const state = createDomainCase({
        versionId: input.versionId,
        body: input.body,
        documentDigest: await digest(input.pdfBytes),
        signers: input.signers,
        order: input.order,
      });
      await client.query(
        `INSERT INTO esign_cases(id, org_id, lease_id, created_by, retention_until)
         VALUES ($1,$2,$3,$4,'infinity')`,
        [input.caseId, actor.orgId, input.leaseId, actor.userId],
      );
      await this.insertVersion(
        client, input.caseId, state.versions[0], input.pdfBytes,
        new Map(input.signers.map((s) => [s.id, s.email])),
      );
      return state;
    });
  }

  async addSigner(actor: Actor, caseId: string, versionId: string, input: SignerInput) {
    return this.run(actor.userId, async (client) => {
      await this.lock(client, actor, caseId);
      await this.admin(client, actor);
      const loaded = await this.load(client, caseId);
      const v = loaded.state.versions.find((x) => x.id === versionId);
      requireValue(v?.status === "draft", "Only drafts accept signers");
      requireValue(!v.signers.some((s) => s.id === input.id), "Duplicate signer");
      const signer: Signer = {
        id: input.id, role: input.role, status: "pending_consent",
        documentCheckRequired: input.documentCheckRequired === true,
      };
      v.signers.push(signer);
      await client.query(
        `INSERT INTO esign_signers(version_id,id,party_role,email,state)
         VALUES ($1,$2,$3,$4,$5)`,
        [versionId, input.id, input.role, input.email, JSON.stringify(signer)],
      );
      await client.query(`UPDATE esign_versions SET state = $2 WHERE id = $1`,
        [versionId, JSON.stringify(v)]);
    });
  }

  async apply(actor: Actor, caseId: string, event: WorkflowEvent): Promise<SigningCase> {
    return this.run(actor.userId, async (client) => {
      await this.lock(client, actor, caseId);
      const { state } = await this.load(client, caseId);
      const v = state.versions.find((x) => x.id === event.versionId);
      const role = await this.role(client, actor, v);
      // Runtime callers cannot bypass the trusted email/image adapters.
      requireValue(
        ["send","consent","object","issue_identity","check_foreign_document","review","void"]
          .includes(event.type),
        "Use the dedicated adapter",
      );
      const after = transition(state, { ...event, actorId: actor.userId, role } as Event);
      await this.save(client, caseId, state, after);
      return after;
    });
  }

  async recordEmailStep(actor: Actor, caseId: string, input: {
    versionId: string; signerId: string; at: string; response: string;
  }): Promise<SigningCase> {
    return this.run(actor.userId, async (client) => {
      await this.lock(client, actor, caseId);
      const { state } = await this.load(client, caseId);
      const v = state.versions.find((x) => x.id === input.versionId);
      const role = await this.role(client, actor, v);
      requireValue(input.signerId === actor.userId, "Signer may act only for self");
      const row = await client.query<{ email: string }>(
        `SELECT email FROM esign_signers WHERE version_id = $1 AND id = $2`,
        [input.versionId, input.signerId],
      );
      requireValue(row.rows[0], "Unknown signer");
      const codeMatches = await this.emailVerifier.check({
        caseId, versionId: input.versionId, signerId: input.signerId,
        email: row.rows[0].email, response: input.response,
      });
      const after = transition(state, {
        type: "check_identity", versionId: input.versionId,
        signerId: input.signerId, at: input.at,
        actorId: actor.userId, role, method: "email", codeMatches,
      });
      await this.save(client, caseId, state, after);
      return after;
    });
  }

  async recordSignature(actor: Actor, caseId: string, input: SignatureInput) {
    return this.run(actor.userId, async (client) => {
      await this.lock(client, actor, caseId);
      const { state } = await this.load(client, caseId);
      const v = state.versions.find((x) => x.id === input.versionId);
      const role = await this.role(client, actor, v);
      requireValue(input.imageBytes.length >= 8, "Signature image required");
      const after = transition(state, {
        type: "sign",
        versionId: input.versionId, signerId: input.signerId, at: input.at,
        actorId: actor.userId, role, strokes: input.strokes,
        imageRef: `${input.versionId}/${input.signerId}`,
        documentDigest: input.documentDigest,
        ip: input.ip, device: input.device, userAgent: input.userAgent,
        finalDigest: input.finalPdfBytes ? await digest(input.finalPdfBytes) : undefined,
      });
      await client.query(
        `INSERT INTO esign_signature_images
         (version_id,signer_id,image_bytes,image_digest,document_digest,
          signed_at,ip_address,device_id,user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.versionId, input.signerId, Buffer.from(input.imageBytes),
          await digest(input.imageBytes), input.documentDigest, input.at,
          input.ip, input.device, input.userAgent,
        ],
      );
      await this.save(client, caseId, state, after, input.finalPdfBytes);
      return after;
    });
  }

  /** Completion and predecessor supersession occur atomically with the last
   * signature. This method only returns that already-finalized artifact.
   */
  async finalize(actor: Actor, caseId: string, versionId: string) {
    return this.run(actor.userId, async (client) => {
      await this.lock(client, actor, caseId);
      const loaded = await this.load(client, caseId);
      const row = loaded.rows.find((x) => x.id === versionId);
      requireValue(row, "Unknown version");
      await this.role(client, actor, row.state);
      requireValue(row.state.status === "completed" && row.final_pdf_bytes, "Both parties must sign");
      return { bytes: new Uint8Array(row.final_pdf_bytes), digest: row.state.finalDigest! };
    });
  }

  async voidUnsigned(actor: Actor, caseId: string, versionId: string, reason: string, at: string) {
    return this.apply(actor, caseId, { type: "void", versionId, reason, at });
  }

  /** Starts a replacement; the existing effective version stays fully signed. */
  async supersede(actor: Actor, caseId: string, input: {
    previousVersionId: string;
    newVersionId: string;
    body: string;
    pdfBytes: Uint8Array;
    documentProof?: GeneratedContractProof;
    at: string;
  }): Promise<SigningCase> {
    return this.run(actor.userId, async (client) => {
      await this.lock(client, actor, caseId);
      await this.admin(client, actor);
      const { state } = await this.load(client, caseId);
      const after = transition(state, {
        type: "create_version", versionId: input.previousVersionId,
        actorId: actor.userId, role: "company_admin", at: input.at,
        newVersionId: input.newVersionId, body: input.body,
        documentDigest: await digest(input.pdfBytes), documentProof: input.documentProof,
      });
      const fresh = after.versions.find((v) => v.id === input.newVersionId)!;
      const emails = await client.query<{ id: string; email: string }>(
        `SELECT id, email FROM esign_signers WHERE version_id = $1`,
        [input.previousVersionId],
      );
      await this.insertVersion(
        client, caseId, fresh, input.pdfBytes,
        new Map(emails.rows.map((s) => [s.id, s.email])),
        after.versions.find((v) => v.id === fresh.supersedes_version_id),
      );
      await this.save(client, caseId, state, after);
      return after;
    });
  }
}
