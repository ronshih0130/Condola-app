-- B-123 / C-plan-2 (Ron 2026-11-18 20:37 PST).
-- Additive only: no backfill (no UPDATE), default change, flag change, or grant/RLS change.
-- PG ≥12: safe in the single-transaction runner because this file does not use the new value.
-- DB keeps 'pro' for Premium (C-plan-3).
ALTER TYPE public.plan_tier ADD VALUE IF NOT EXISTS 'standard';
