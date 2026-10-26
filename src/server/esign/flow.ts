import { isIP } from "node:net";
import { PDFDocument } from "pdf-lib";
import { svc } from "../db";
import { sendMail, type MailMessage, type MailResult } from "../mail";
import type { Session } from "../types";
import { EsignDenied, management, requireEsign, requireManagement } from "./access";
import { contractVersionDigest } from "./document";
import { emailCode, matchesEmailCode } from "./email";
import { signaturePng } from "./evidence";
import { EsignRepo, type Connection, type TransactionRunner } from "./repo";
import { recordReviewDelivery, requireReviewDelivery } from "./review";
import { auditView, replacementLine, type Version, type Stroke, type AuditEvent } from "./rules";
import { generateContractPdf, stampSignature } from "./stamp";

export type Candidate = { id: string; name: string; email: string; role: "owner" | "tenant" };
export type VersionView = {
  id: string; caseId: string; status: Version["status"]; effect: Version["effect"];
  halted: boolean; digest: string; pages: number;
  previousId: string | null; replacementText: string | null;
  participants: { role: "owner" | "tenant"; status: string }[];
  own: null | {
    status: string; signedAt: string | null; identityLabel: string | null;
    challenge: boolean; identityFailed: boolean; deadline: string | null; documentCheckPending: boolean;
  };
  audit: ReturnType<typeof auditView>[];
  history: AuditEvent[];
};
export type LeaseView = {
  leaseId: string; company: string; manage: boolean; admin: boolean;
  candidates: Candidate[]; versions: VersionView[];
};
export type Command =
  | { type: "create"; leaseId: string; pdf: Uint8Array; ownerId: string; tenantId: string;
      ownerDocument: boolean; tenantDocument: boolean; order: "parallel" | "sequential"; deadline: string }
  | { type: "consent" | "object" | "email" | "review"; caseId: string; versionId: string }
  | { type: "confirm"; caseId: string; versionId: string; response: string }
  | { type: "sign"; caseId: string; versionId: string; strokes: readonly Stroke[]; digest: string;
      ip: string; userAgent: string }
  | { type: "void"; caseId: string; versionId: string; reason: string }
  | { type: "replace"; caseId: string; versionId: string; body: string; deadline: string }
  | { type: "document"; caseId: string; versionId: string; signerId: string;
      documentType: "passport" | "residence_permit" };

type Dependencies = {
  enabled?: () => boolean;
  run?: TransactionRunner;
  mail?: (message: MailMessage) => Promise<MailResult>;
  font?: () => Promise<Uint8Array>;
  secret?: string;
  now?: () => Date;
};

function ensure(value: unknown, message = "Unavailable"): asserts value {
  if (!value) throw new EsignDenied(message);
}
function uuid(value: string) {
  ensure(typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
  return value;
}

async function defaultFont() {
  const origin = new URL(process.env.ESIGN_ASSET_ORIGIN ?? "");
  ensure(origin.protocol === "https:" ||
    (process.env.NODE_ENV !== "production" && origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)));
  const response = await fetch(new URL("/fonts/DroidSansFallback-subset.ttf", origin), { redirect: "error" });
  ensure(response.ok, "Font unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  ensure(bytes.length <= 4 * 1024 * 1024, "Font too large");
  return bytes;
}

/** Only session evidence enters this boundary. No actor, org, role, clock or
 * trusted identity result comes from an action's payload.
 */
export class EsignFlow {
  private run: TransactionRunner;
  constructor(private deps: Dependencies = {}) { this.run = deps.run ?? svc; }

  private entry(session: Session) {
    requireEsign(session, this.deps.enabled?.());
  }
  private async company(c: Connection, session: Session, admin = false) {
    requireManagement(session, admin);
    const row = await c.query<{ role: string }>(
      "SELECT role::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'",
      [session.orgId, session.userId],
    );
    ensure(row.rows[0]?.role === session.role, "Membership changed");
  }
  private async candidates(c: Connection, session: Session, leaseId: string) {
    const rows = await c.query<Candidate>(
      `SELECT DISTINCT c.user_id::text AS id, c.display_name AS name, c.email::text AS email, 'tenant'::text AS role
       FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
       WHERE lp.lease_id=$1 AND lp.org_id=$2 AND c.user_id IS NOT NULL AND c.archived_at IS NULL
       UNION
       SELECT DISTINCT c.user_id::text, c.display_name, c.email::text, 'owner'::text
       FROM leases l JOIN property_owners po ON po.property_id=l.property_id AND po.org_id=l.org_id
       JOIN contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
       WHERE l.id=$1 AND l.org_id=$2 AND c.user_id IS NOT NULL AND c.archived_at IS NULL`,
      [leaseId, session.orgId],
    );
    return rows.rows.filter((r) => r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
  }
  private async load(c: Connection, session: Session, caseId: string, versionId: string) {
    const row = await c.query<{ lease_id: string }>(
      "SELECT lease_id::text FROM esign_cases WHERE id=$1 AND org_id=$2 FOR UPDATE",
      [uuid(caseId), session.orgId],
    );
    ensure(row.rows[0]);
    const versions = await c.query<{ state: Version; pdf_bytes: Buffer; final_pdf_bytes: Buffer | null }>(
      "SELECT state,pdf_bytes,final_pdf_bytes FROM esign_versions WHERE case_id=$1 AND id=$2",
      [caseId, uuid(versionId)],
    );
    const v = versions.rows[0];
    ensure(v);
    if (management(session)) await this.company(c, session);
    else {
      ensure(session.kind === "owner" || session.kind === "tenant");
      ensure(v.state.signers.some((s) => s.id === session.userId && s.role === session.kind));
      // Mixed staff/portal identities must not let repo.role pick a company role
      // for a signer action. The active persona is always authoritative here.
      const member = await c.query("SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','manager')", [session.orgId, session.userId]);
      ensure(!member.rowCount, "Use a separate signer account");
    }
    return { ...v, leaseId: row.rows[0].lease_id };
  }
  private deadline(raw: string, at: string) {
    const date = new Date(raw);
    ensure(Number.isFinite(date.getTime()) && date.getTime() > Date.parse(at), "Future notice deadline required");
    return date.toISOString();
  }
  private async invite(c: Connection, versionId: string, leaseId: string) {
    const rows = await c.query<{ email: string; party_role: string }>("SELECT email,party_role FROM esign_signers WHERE version_id=$1", [versionId]);
    for (const row of rows.rows) {
      const path = row.party_role === "owner" ? "/o/leases/" + leaseId + "/esign" : "/t/lease";
      const result = await (this.deps.mail ?? sendMail)({
        to: row.email, subject: "Condola｜電子簽約通知",
        text: "請登入 Condola 租約頁面閱讀電子形式同意須知及契約。您可向公司表示反對。 " + path,
        html: "<p>請登入 Condola 租約頁面閱讀電子形式同意須知及契約。您可向公司表示反對。</p><p>" + path + "</p>",
      });
      ensure(result.ok, "Email delivery failed");
    }
  }

  async execute(session: Session, command: Command) {
    this.entry(session);
    return this.run(session.userId, async (c) => {
      const at = (this.deps.now?.() ?? new Date()).toISOString();
      const actor = { userId: session.userId, orgId: session.orgId };
      const repo = new EsignRepo({
        check: async (input) => {
          const row = await c.query<{ state: Version }>("SELECT state FROM esign_versions WHERE id=$1", [input.versionId]);
          const challenge = row.rows[0]?.state.signers.find((s) => s.id === input.signerId)?.emailChallenge;
          if (!challenge || Date.parse(challenge.expiresAt) <= Date.parse(at)) return false;
          const expected = await emailCode({
            caseId: input.caseId, versionId: input.versionId, signerId: input.signerId,
            email: input.email, issuedAt: challenge.issuedAt,
          }, this.deps.secret);
          return matchesEmailCode(expected, input.response);
        },
      }, async (_actorId, work) => work(c));

      if (command.type === "create") {
        await this.company(c, session);
        const leaseId = uuid(command.leaseId);
        const lease = await c.query("SELECT id FROM leases WHERE id=$1 AND org_id=$2 FOR UPDATE", [leaseId, session.orgId]);
        ensure(lease.rowCount === 1);
        ensure((await c.query("SELECT id FROM esign_cases WHERE lease_id=$1", [leaseId])).rowCount === 0, "Use a replacement version");
        ensure(command.order === "parallel" || command.order === "sequential");
        ensure(command.pdf.length > 0 && command.pdf.length <= 7 * 1024 * 1024, "PDF size");
        ensure(new TextDecoder().decode(command.pdf.slice(0, 5)) === "%PDF-", "PDF required");
        const pdf = await PDFDocument.load(command.pdf);
        ensure(pdf.getPageCount() > 0 && pdf.getPageCount() <= 100, "PDF page limit");
        const choices = await this.candidates(c, session, leaseId);
        const owner = choices.find((x) => x.id === command.ownerId && x.role === "owner");
        const tenant = choices.find((x) => x.id === command.tenantId && x.role === "tenant");
        ensure(owner && tenant && owner.id !== tenant.id, "Linked signers required");
        const caseId = crypto.randomUUID(), versionId = crypto.randomUUID();
        await repo.createCase(actor, {
          caseId, leaseId, versionId, body: "Uploaded contract PDF", pdfBytes: command.pdf,
          order: command.order, signers: [
            { ...owner, documentCheckRequired: command.ownerDocument === true },
            { ...tenant, documentCheckRequired: command.tenantDocument === true },
          ],
        });
        await repo.apply(actor, caseId, { type: "send", versionId, at,
          termsVersion: "esign-explicit-v1", presumedConsentDeadline: this.deadline(command.deadline, at) });
        await this.invite(c, versionId, leaseId);
        return { leaseId };
      }

      const loaded = await this.load(c, session, command.caseId, command.versionId);
      const versionId = command.versionId, caseId = command.caseId;
      const signer = loaded.state.signers.find((s) => s.id === session.userId && s.role === session.kind);
      const self = () => {
        ensure(session.kind !== "staff" && signer, "Only the signer may act");
        return session.userId;
      };
      switch (command.type) {
        case "consent":
          await repo.apply(actor, caseId, { type: "consent", kind: "explicit", versionId, signerId: self(), at });
          break;
        case "object":
          await repo.apply(actor, caseId, { type: "object", versionId, signerId: self(), at });
          break;
        case "email": {
          const signerId = self();
          ensure(!loaded.state.halted && signer?.status === "pending_identity", "Identity out of order");
          let challenge = signer.emailChallenge;
          if (!challenge) {
            await repo.apply(actor, caseId, { type: "issue_identity", versionId, signerId, at,
              method: "email", expiresAt: new Date(Date.parse(at) + 10 * 60 * 1000).toISOString(), attemptCap: 5 });
            challenge = { issuedAt: at, expiresAt: new Date(Date.parse(at) + 600000).toISOString(), attempts: 0, attemptCap: 5 };
          } else {
            ensure(Date.parse(challenge.expiresAt) > Date.parse(at), "Challenge expired; contact company");
            // Idempotent request: no resend loop or new attempt budget.
            return { leaseId: loaded.leaseId };
          }
          const row = await c.query<{ email: string }>("SELECT email FROM esign_signers WHERE version_id=$1 AND id=$2", [versionId, signerId]);
          const email = row.rows[0].email;
          const code = await emailCode({ caseId, versionId, signerId, email, issuedAt: challenge.issuedAt }, this.deps.secret);
          const result = await (this.deps.mail ?? sendMail)({
            to: email, subject: "Condola｜Email 身分確認步驟",
            text: "請於 10 分鐘內在簽約頁面輸入：" + code,
            html: "<p>請於 10 分鐘內在簽約頁面輸入：</p><p>" + code + "</p>",
          });
          ensure(result.ok, "Email delivery failed");
          break;
        }
        case "confirm":
          ensure(typeof command.response === "string" && command.response.length <= 128);
          await repo.recordEmailStep(actor, caseId, { versionId, signerId: self(), response: command.response, at });
          break;
        case "review": {
          const signerId = self();
          ensure(!loaded.state.halted && signer?.status === "pending_review", "Review out of order");
          await requireReviewDelivery(c, {
            caseId, versionId, signerId, digest: loaded.state.documentDigest,
          }, (await PDFDocument.load(loaded.pdf_bytes)).getPageCount());
          // The acknowledgement requires durable delivery evidence. The browser
          // additionally gates this command on scrolling; neither proves reading.
          await repo.apply(actor, caseId, { type: "review", versionId, signerId, scrolledToEnd: true, at });
          break;
        }
        case "document":
          await this.company(c, session);
          await repo.apply(actor, caseId, { type: "check_foreign_document", versionId, at,
            signerId: uuid(command.signerId), documentType: command.documentType });
          break;
        case "void":
          await this.company(c, session, true);
          ensure(typeof command.reason === "string" && command.reason.trim().length > 0 && command.reason.length <= 2000);
          await repo.voidUnsigned(actor, caseId, versionId, command.reason, at);
          break;
        case "replace": {
          await this.company(c, session);
          ensure(typeof command.body === "string" && command.body.trim().length > 0 && command.body.length <= 50000);
          let body = command.body;
          const effectiveId = loaded.state.effect === "effective" ? versionId : loaded.state.supersedes_version_id;
          if (effectiveId) {
            const old = await c.query<{ state: Version }>("SELECT state FROM esign_versions WHERE id=$1 AND case_id=$2", [effectiveId, caseId]);
            ensure(old.rows[0]?.state.completedAt);
            body += "\n" + replacementLine(old.rows[0].state.completedAt);
          }
          const generated = await generateContractPdf(body, await (this.deps.font ?? defaultFont)());
          const newVersionId = crypto.randomUUID();
          await repo.supersede(actor, caseId, { previousVersionId: versionId, newVersionId,
            body, pdfBytes: generated.bytes, documentProof: generated.proof, at });
          await repo.apply(actor, caseId, { type: "send", versionId: newVersionId, at,
            termsVersion: "esign-explicit-v1", presumedConsentDeadline: this.deadline(command.deadline, at) });
          await this.invite(c, newVersionId, loaded.leaseId);
          break;
        }
        case "sign": {
          const signerId = self();
          ensure(isIP(command.ip) !== 0 && command.userAgent.length > 0 && command.userAgent.length <= 1000, "Request audit missing");
          ensure(command.digest === loaded.state.documentDigest, "Document changed");
          const imageBytes = signaturePng(command.strokes);
          let finalPdfBytes: Uint8Array | undefined;
          if (loaded.state.signers.every((s) => s.id === signerId || s.status === "completed")) {
            const rows = await c.query<{ signer_id: string; image_bytes: Buffer; signed_at: Date | string; name: string }>(
              `SELECT i.signer_id::text,i.image_bytes,i.signed_at,coalesce(nullif(p.display_name,''),i.signer_id::text) AS name
               FROM esign_signature_images i LEFT JOIN profiles p ON p.id=i.signer_id WHERE i.version_id=$1`, [versionId],
            );
            const name = await c.query<{ name: string }>("SELECT coalesce(nullif(display_name,''),id::text) AS name FROM profiles WHERE id=$1", [signerId]);
            const stamps = loaded.state.signers.map((s) => s.id === signerId
              ? { bytes: imageBytes, at, name: name.rows[0]?.name ?? signerId }
              : (() => {
                  const row = rows.rows.find((r) => r.signer_id === s.id);
                  ensure(row, "Signature evidence missing");
                  return { bytes: new Uint8Array(row.image_bytes), at: new Date(row.signed_at).toISOString(), name: row.name };
                })());
            let bytes = new Uint8Array(loaded.pdf_bytes);
            const fontBytes = await (this.deps.font ?? defaultFont)();
            for (const stamp of stamps) {
              bytes = new Uint8Array((await stampSignature(bytes, stamp.bytes, {
                signerDisplayName: stamp.name, signedAt: stamp.at,
                documentDigest: await contractVersionDigest(bytes), fontBytes,
              })).bytes);
            }
            finalPdfBytes = bytes;
          }
          await repo.recordSignature(actor, caseId, { versionId, signerId, at, strokes: command.strokes,
            imageBytes, documentDigest: command.digest, ip: command.ip, userAgent: command.userAgent,
            device: "session:" + session.sessionId, finalPdfBytes });
          break;
        }
      }
      return { leaseId: loaded.leaseId };
    });
  }

  async list(session: Session, leaseId: string): Promise<LeaseView> {
    this.entry(session);
    return this.run(session.userId, async (c) => {
      uuid(leaseId);
      if (management(session)) {
        await this.company(c, session);
        ensure((await c.query("SELECT id FROM leases WHERE id=$1 AND org_id=$2", [leaseId, session.orgId])).rowCount === 1);
      } else ensure(session.kind === "owner" || session.kind === "tenant");
      const cases = await c.query<{ id: string; company: string }>(
        `SELECT e.id::text, o.name AS company FROM esign_cases e JOIN organizations o ON o.id=e.org_id
         WHERE e.lease_id=$1 AND e.org_id=$2 AND ($3::boolean OR EXISTS (
           SELECT 1 FROM esign_versions v JOIN esign_signers s ON s.version_id=v.id
           WHERE v.case_id=e.id AND s.id=$4 AND s.party_role=$5)) ORDER BY e.created_at`,
        [leaseId, session.orgId, management(session), session.userId, session.kind],
      );
      if (!management(session) && !cases.rowCount) throw new EsignDenied("No signing case");
      const versions: VersionView[] = [];
      for (const item of cases.rows) {
        const rows = await c.query<{ state: Version; pdf_bytes: Buffer; replacement_text: string | null }>(
          "SELECT state,pdf_bytes,replacement_text FROM esign_versions WHERE case_id=$1 ORDER BY created_at,id", [item.id],
        );
        for (const row of rows.rows) {
          const v = row.state;
          const own = v.signers.find((s) => s.id === session.userId && s.role === session.kind);
          if (!management(session) && !own) continue;
          const viewer = { id: session.userId, role: management(session)
            ? (session.role === "admin" ? "company_admin" : "company_staff") as "company_admin" | "company_staff"
            : session.kind as "owner" | "tenant" };
          versions.push({
            id: v.id, caseId: item.id, status: v.status, effect: v.effect, halted: !!v.halted,
            digest: v.finalDigest ?? v.documentDigest,
            pages: (await PDFDocument.load(row.pdf_bytes)).getPageCount(),
            previousId: v.previous_version_id ?? null, replacementText: row.replacement_text,
            participants: v.signers.map((s) => ({ role: s.role, status: s.status })),
            own: own ? {
              status: own.status, signedAt: own.signature?.signedAt ?? null,
              identityLabel: own.identity?.result === "completed" ? "已完成 Email 身分確認步驟" : null,
              challenge: !!own.emailChallenge, identityFailed: own.identity?.result === "failed", deadline: own.notice?.presumedConsentDeadline ?? null,
              documentCheckPending: own.documentCheckRequired && !own.foreignDocumentCheck,
            } : null,
            history: management(session) ? (await c.query<{ payload: AuditEvent }>(
              "SELECT payload FROM esign_audit_events WHERE case_id=$1 AND version_id=$2 AND event_type='domain' ORDER BY sequence_no",
              [item.id, v.id],
            )).rows.map((r) => r.payload) : [],
            audit: (management(session) ? v.signers : own ? [own] : []).map((s) => auditView(v, s.id, viewer)),
          });
        }
      }
      return { leaseId, company: cases.rows[0]?.company ?? "Condola", manage: management(session),
        admin: management(session) && session.role === "admin",
        candidates: management(session) ? await this.candidates(c, session, leaseId) : [], versions };
    });
  }

  async pdf(session: Session, caseId: string, versionId: string, final: boolean, page?: number) {
    this.entry(session);
    return this.run(session.userId, async (c) => {
      const loaded = await this.load(c, session, caseId, versionId);
      if (final) ensure(["completed", "superseded"].includes(loaded.state.status) && loaded.final_pdf_bytes, "Not completed");
      const bytes = new Uint8Array(final ? loaded.final_pdf_bytes! : loaded.pdf_bytes);
      const digest = final ? loaded.state.finalDigest! : loaded.state.documentDigest;
      ensure(await contractVersionDigest(bytes) === digest, "Document digest mismatch");
      let responseBytes = bytes;
      if (page !== undefined) {
        const source = await PDFDocument.load(bytes);
        ensure(Number.isInteger(page) && page >= 1 && page <= source.getPageCount());
        const one = await PDFDocument.create();
        one.addPage((await one.copyPages(source, [page - 1]))[0]);
        responseBytes = new Uint8Array(await one.save());
      }
      const signer = loaded.state.signers.find((s) => s.id === session.userId && s.role === session.kind);
      if (!final && !loaded.state.halted && signer?.status === "pending_review") {
        await recordReviewDelivery(c, {
          caseId, versionId, signerId: session.userId, digest,
        }, page ?? null);
      }
      return { bytes: responseBytes, digest };
    });
  }
}

export const esignFlow = new EsignFlow();
