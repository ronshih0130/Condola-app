import type { BrowserConfig, UpstreamSource } from "./third-party-licenses.mjs";

export interface NoticeFile {
  path: string;
  text: string;
  ext?: string;
  whole?: boolean;
}

export interface NoticeResult {
  filesScanned: number;
  filesWithoutNotice: number;
  blocks: { text: string; paths: string[] }[];
}

export const BUILD_INPUTS: [string, string][];
export function commentBlocks(text: string, ext?: string): string[];
export function noticeBlocks(files: NoticeFile[]): NoticeResult;
export function extractionHeader(pin: UpstreamSource): string;
export function formatNotices(result: NoticeResult, pin: UpstreamSource): string;
export function extractLibraryNotices(sourceRoot: string, pin: UpstreamSource): string;
export function holdersFromNotices(notices: string): string;
export function copyrightNotice(sourceRoot: string, pin: UpstreamSource): string;
export function buildReadme(config: BrowserConfig): string;
export function extractUpstream(rootDir: string, archiveDir: string, config: BrowserConfig): string[];
