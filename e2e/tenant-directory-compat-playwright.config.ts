import {defineConfig} from '@playwright/test';
import base from './tenant-directory-edit-playwright.config';
export default defineConfig({...base,testMatch:['b015-directory-local.spec.ts','existing-tenant.spec.ts']});
