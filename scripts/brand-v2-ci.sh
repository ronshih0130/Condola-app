#!/bin/sh
set -u
cd "$(dirname "$0")/.." || exit 1
npx tsx --test src/server/brand-v2.test.ts
