import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, EyeIcon, FileIcon, Loader2 } from 'lucide-react';

import { api } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import {
  formatFileBytes,
  getFilePreviewKind,
  lookupWorkspaceFile,
  MAX_PREVIEW_BYTES,
  type WorkspaceFileInfo,
} from '@/modules/chat/utils/workspaceFileReference';

type MarkdownFileCardProps = {
  projectId: string;
  filePath: string;
  /** What to show while the server is asked, and when the path is not a readable file. */
  fallback: ReactNode;
};

type PreviewContent =
  | { kind: 'image' | 'pdf'; url: string }
  | { kind: 'html' | 'text'; text: string };

// Blob#text is missing in older browsers; FileReader reads the same bytes.
function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function fetchFileBlob(projectId: string, filePath: string): Promise<Blob | null> {
  const response = await api.readFileBlob(projectId, filePath);
  return response.ok ? response.blob() : null;
}

/**
 * Inline code in a transcript that names a file the server can read, shown as a
 * card with download and (for web-viewable types) preview. Anything that is not
 * such a file keeps rendering as the plain `fallback` code span.
 */
export default function MarkdownFileCard({ projectId, filePath, fallback }: MarkdownFileCardProps) {
  const { t } = useTranslation('chat');
  const [info, setInfo] = useState<WorkspaceFileInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewContent | 'loading' | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    void lookupWorkspaceFile(projectId, filePath).then((answer) => {
      if (!cancelled) {
        setInfo(answer);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath]);

  const previewUrl = preview && typeof preview === 'object' && 'url' in preview ? preview.url : null;
  useEffect(() => () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
  }, [previewUrl]);

  const name = info?.name ?? filePath.split('/').pop() ?? filePath;
  const previewKind = info?.exists ? getFilePreviewKind(name) : null;
  const canPreview = previewKind !== null
    && (previewKind === 'image' || previewKind === 'pdf' || (info?.size ?? 0) <= MAX_PREVIEW_BYTES);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await fetchFileBlob(projectId, filePath);
      if (!blob) return;
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (error) {
      console.error(`Failed to download "${name}":`, error);
    } finally {
      setDownloading(false);
    }
  }, [downloading, filePath, name, projectId]);

  const openPreview = useCallback(async () => {
    if (!previewKind) return;
    setPreviewOpen(true);
    setPreview('loading');
    try {
      const blob = await fetchFileBlob(projectId, filePath);
      if (!blob) {
        setPreview('failed');
        return;
      }
      if (previewKind === 'image' || previewKind === 'pdf') {
        const typed = previewKind === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob;
        setPreview({ kind: previewKind, url: URL.createObjectURL(typed) });
        return;
      }
      setPreview({ kind: previewKind, text: await readBlobText(blob) });
    } catch {
      setPreview('failed');
    }
  }, [filePath, previewKind, projectId]);

  if (!info?.exists) {
    return <>{fallback}</>;
  }

  const size = formatFileBytes(info.size);

  return (
    <>
      <span className="my-0.5 inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-card px-2 py-1 align-middle shadow-sm">
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium text-foreground" title={filePath}>{name}</span>
        {size && <span className="shrink-0 text-xs text-muted-foreground">{size}</span>}
        {canPreview && (
          <button
            type="button"
            onClick={() => void openPreview()}
            aria-label={t('fileCard.preview', { name })}
            title={t('fileCard.preview', { name })}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <EyeIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading}
          aria-label={t('fileCard.download', { name })}
          title={t('fileCard.download', { name })}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />}
        </button>
      </span>

      <Dialog open={previewOpen} onOpenChange={(open) => !open && setPreviewOpen(false)}>
        <DialogContent className="flex h-[min(90dvh,48rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden rounded-2xl border-border/80 bg-popover p-0 shadow-2xl sm:w-[min(94vw,64rem)]">
          <DialogTitle>{name}</DialogTitle>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 pr-12">
            <span className="min-w-0 truncate text-sm font-medium text-foreground" title={filePath}>{name}</span>
            <button
              type="button"
              onClick={() => void download()}
              disabled={downloading}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              {t('fileCard.downloadLabel')}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-background">
            {preview === 'loading' && (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-label={t('fileCard.loading')} />
              </div>
            )}
            {preview === 'failed' && (
              <p className="p-6 text-sm text-muted-foreground">{t('fileCard.previewFailed')}</p>
            )}
            {preview && typeof preview === 'object' && preview.kind === 'image' && (
              <div className="grid min-h-full place-items-center p-4">
                <img src={preview.url} alt={name} className="max-h-full max-w-full object-contain" />
              </div>
            )}
            {preview && typeof preview === 'object' && preview.kind === 'pdf' && (
              <iframe title={name} src={preview.url} className="h-full w-full border-0" />
            )}
            {preview && typeof preview === 'object' && preview.kind === 'html' && (
              // Scripts may run (a delivered page usually needs them) but the
              // opaque origin keeps them away from this app's storage and token.
              <iframe title={name} srcDoc={preview.text} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />
            )}
            {preview && typeof preview === 'object' && preview.kind === 'text' && (
              <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground">{preview.text}</pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
