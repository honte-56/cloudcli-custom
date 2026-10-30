import { api } from '@/shared/api';

export type WorkspaceFileInfo = {
  path: string;
  exists: boolean;
  name?: string;
  size?: number;
  mimeType?: string;
};

// Extensions that make a bare file name (no slash) worth asking the server
// about. `user.name` or `foo.bar` in prose are not, and asking about every
// dotted token would send a request per identifier.
const DELIVERABLE_EXTENSIONS = new Set([
  'html', 'htm', 'md', 'txt', 'pdf', 'json', 'csv', 'tsv', 'zip', 'tar', 'gz', 'png', 'jpg', 'jpeg', 'gif',
  'webp', 'svg', 'py', 'js', 'ts', 'tsx', 'jsx', 'css', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'yaml',
  'yml', 'xml', 'log', 'sh', 'sql', 'mp3', 'mp4', 'wav',
]);

const FILE_LIKE = /^[^\s"'`<>|*?:]+\.[A-Za-z0-9]{1,8}$/;

/**
 * Whether inline code reads as a reference to a file the server could serve:
 * a single token that ends in an extension and either names a location (has a
 * slash) or uses an extension people actually hand over.
 */
export function looksLikeFileReference(text: string): boolean {
  const candidate = text.trim();
  if (candidate.length === 0 || candidate.length > 400 || candidate.includes('://')) {
    return false;
  }
  if (!FILE_LIKE.test(candidate) || candidate.endsWith('/') || candidate.endsWith('.')) {
    return false;
  }

  const extension = candidate.slice(candidate.lastIndexOf('.') + 1).toLowerCase();
  return candidate.includes('/') || DELIVERABLE_EXTENSIONS.has(extension);
}

// One answer per project + path for the life of the page. Re-asking on every
// render of a streamed message would be a request per token; a file that appears
// later is picked up on the next page load.
const answers = new Map<string, Promise<WorkspaceFileInfo>>();
const MAX_CACHED_ANSWERS = 500;

/** Resolves what the server knows about a file reference, once per project and path. */
export function lookupWorkspaceFile(projectId: string, filePath: string): Promise<WorkspaceFileInfo> {
  const key = `${projectId}\u0000${filePath}`;
  const cached = answers.get(key);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<WorkspaceFileInfo> => {
    try {
      const response = await api.statFiles(projectId, [filePath]);
      if (!response.ok) {
        return { path: filePath, exists: false };
      }
      const payload = await response.json() as { files?: WorkspaceFileInfo[] };
      return payload.files?.[0] ?? { path: filePath, exists: false };
    } catch {
      answers.delete(key);
      return { path: filePath, exists: false };
    }
  })();

  if (answers.size >= MAX_CACHED_ANSWERS) {
    answers.delete(answers.keys().next().value as string);
  }
  answers.set(key, pending);
  return pending;
}

/** Test seam: forget every cached answer. */
export function resetWorkspaceFileLookups(): void {
  answers.clear();
}

export type FilePreviewKind = 'image' | 'html' | 'pdf' | 'text' | null;

const TEXT_PREVIEW_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'csv', 'tsv', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'css', 'yaml', 'yml', 'xml', 'sh', 'sql',
]);

/** Largest text/HTML file the preview will load; larger ones are download-only. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** How a file can be previewed in the browser, or null when it can only be downloaded. */
export function getFilePreviewKind(name: string): FilePreviewKind {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) return 'image';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'pdf') return 'pdf';
  return TEXT_PREVIEW_EXTENSIONS.has(extension) ? 'text' : null;
}

/** "1.2 KB" style size for the file card. */
export function formatFileBytes(size: number | undefined): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
