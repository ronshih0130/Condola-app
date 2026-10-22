import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

/**
 * TODO: wire SQL signatures using QA_RPC_CASES_JSON.
 * Named argument sets MUST select each real overload unambiguously.
 * Do not implement RPC stubs or accept signature-resolution errors as denial.
 *
 * JSON shape:
 * {
 *   "invoiceRecalc": { "name":"fn_invoice_recalc", "args":{...} },
 *   "invoiceLinesChanged": { "name":"fn_invoice_lines_changed", "args":{...} },
 *   "reversals": [
 *     { "name":"post_reversal", "crossOrgArgs":{...}, "missingArgs":{...} },
 *     { "name":"post_reversal", "crossOrgArgs":{...}, "missingArgs":{...} }
 *   ],
 *   "audit": { "name":"audit_event", "crossOrgArgs":{...}, "missingArgs":{...} }
 * }
 * crossOrgArgs target an existing org B QA record. missingArgs use a verified
 * nonexistent ID of the correct SQL type. All other arguments must be valid.
 */
interface Call {
  name: string;
  args: Record<string, unknown>;
}
interface ScopedCall {
  name: string;
  crossOrgArgs: Record<string, unknown>;
  missingArgs: Record<string, unknown>;
}
interface Cases {
  invoiceRecalc: Call;
  invoiceLinesChanged: Call;
  reversals: [ScopedCall, ScopedCall];
  audit: ScopedCall;
}

const enabled = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'QA_ORG_A_JWT', 'QA_RPC_CASES_JSON',
].every(name => Boolean(process.env[name]));

describe.skipIf(!enabled)('RPC permissions against QA database', () => {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };

  function client(authenticated: boolean) {
    return createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        ...options,
        global: authenticated
          ? { headers: { Authorization: `Bearer ${process.env.QA_ORG_A_JWT!}` } }
          : {},
        db: { schema: process.env.QA_RPC_SCHEMA ?? 'app' },
      },
    );
  }

  function cases(): Cases {
    const parsed = JSON.parse(process.env.QA_RPC_CASES_JSON!) as Cases;
    expect(parsed.invoiceRecalc.name).toBe('fn_invoice_recalc');
    expect(parsed.invoiceLinesChanged.name).toBe('fn_invoice_lines_changed');
    expect(parsed.audit.name).toBe('audit_event');
    expect(parsed.reversals).toHaveLength(2);
    for (const item of parsed.reversals) expect(item.name).toBe('post_reversal');
    expect(parsed.reversals[0].crossOrgArgs).not.toEqual(parsed.reversals[1].crossOrgArgs);
    return parsed;
  }

  for (const authenticated of [false, true]) {
    it.each(['invoiceRecalc', 'invoiceLinesChanged'] as const)(
      `${authenticated ? 'authenticated' : 'anon'} cannot EXECUTE %s`,
      async key => {
        const call = cases()[key];
        const { error } = await client(authenticated).rpc(call.name, call.args);
        expect(error).not.toBeNull();
        expect(error?.code).toBe('42501');
        expect(error?.message).toMatch(/permission denied for function/i);
      },
    );
  }

  it.each([0, 1, 2])('anon cannot EXECUTE protected RPC case %i', async index => {
    const fixture = cases();
    const call = [...fixture.reversals, fixture.audit][index]!;
    const { error } = await client(false).rpc(call.name, call.crossOrgArgs);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(/permission denied for function/i);
  });

  it.each([0, 1, 2])('cross-org RPC case %i is rejected with 42501', async index => {
    const fixture = cases();
    const call = [...fixture.reversals, fixture.audit][index]!;
    const { error } = await client(true).rpc(call.name, call.crossOrgArgs);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    // Grants must permit reaching the organization check for org A users.
    expect(error?.message).not.toMatch(/permission denied for function/i);
  });

  it.each([0, 1, 2])('nonexistent record in RPC case %i is not found', async index => {
    const fixture = cases();
    const call = [...fixture.reversals, fixture.audit][index]!;
    const { error } = await client(true).rpc(call.name, call.missingArgs);
    expect(error).not.toBeNull();
    expect(error?.code).not.toBe('42501');
    expect(error?.code).not.toMatch(/^PGRST20[023]$/);
    expect(error?.message).toMatch(/not found|不存在|找不到/i);
  });
});

