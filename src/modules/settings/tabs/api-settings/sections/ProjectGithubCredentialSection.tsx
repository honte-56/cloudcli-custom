/** Settings for the user's project-to-token bindings. Only metadata crosses the browser API. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';
import type { AgentSettingsProject, GithubCredentialItem } from '@/shared/types';
import { Button } from '@/shared/ui';

type Props = { projects: AgentSettingsProject[]; credentials: GithubCredentialItem[] };
const selectClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

function ProjectBinding({ projectId, credentials }: { projectId: string; credentials: GithubCredentialItem[] }) {
  const { t } = useTranslation('settings');
  // Retain the user's pending selection until it is explicitly saved.
  const [credentialId, setCredentialId] = useState('');
  // Block writes until the stored binding has loaded and while a save is pending.
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'load-error'>('loading');
  // Surface transport failures without treating an unsaved selection as persisted.
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await api.projectGithubCredential(projectId);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('projectGithub.loadError'));
        if (active) { setCredentialId(data.credentialId === null ? '' : String(data.credentialId)); setStatus('ready'); }
      } catch (err) {
        if (active) { setError(err instanceof Error ? err.message : t('projectGithub.loadError')); setStatus('load-error'); }
      }
    })();
    return () => { active = false; };
  }, [projectId, t]);
  const selected = credentials.find((item) => String(item.id) === credentialId);
  const unavailable = Boolean(credentialId) && !selected?.is_active;
  const save = async () => {
    setStatus('saving'); setError('');
    try {
      const response = await api.setProjectGithubCredential(projectId, credentialId ? Number(credentialId) : null);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('projectGithub.saveError'));
      setStatus('saved');
    } catch (err) { setError(err instanceof Error ? err.message : t('projectGithub.saveError')); setStatus('ready'); }
  };
  return <div className="space-y-3">
    <label className="block space-y-1 text-sm">
      <span>{t('projectGithub.token')}</span>
      <select className={selectClass} value={credentialId} disabled={status === 'loading' || status === 'saving' || status === 'load-error'} onChange={(event) => { setCredentialId(event.target.value); setStatus('ready'); setError(''); }}>
        <option value="">{t('projectGithub.none')}</option>
        {credentials.map((item) => <option key={item.id} value={String(item.id)} disabled={!item.is_active}>{item.credential_name}</option>)}
        {credentialId && !selected && <option value={credentialId} disabled>{t('projectGithub.deleted')}</option>}
      </select>
    </label>
    {unavailable && <p role="alert" className="text-sm text-destructive">{t('projectGithub.unavailable')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button onClick={save} disabled={status === 'loading' || status === 'saving' || status === 'load-error' || unavailable}>{t('projectGithub.save')}</Button>
    {status === 'saved' && <p role="status" className="text-sm text-muted-foreground">{t('projectGithub.saved')}</p>}
  </div>;
}

/** Used by the credentials settings tab for existing projects and clone-created bindings. */
export default function ProjectGithubCredentialSection({ projects, credentials }: Props) {
  const { t } = useTranslation('settings');
  // Keep the project being edited independent of the currently open chat.
  const [selectedProject, setSelectedProject] = useState(projects[0]?.name || '');
  const projectId = projects.some((project) => project.name === selectedProject) ? selectedProject : projects[0]?.name;
  return <section className="space-y-4">
    <div><h3 className="text-lg font-medium">{t('projectGithub.title')}</h3><p className="text-sm text-muted-foreground">{t('projectGithub.description')}</p></div>
    {!projectId ? <p className="text-sm text-muted-foreground">{t('projectGithub.noProjects')}</p> : <>
      <label className="block space-y-1 text-sm"><span>{t('projectGithub.project')}</span>
        <select className={selectClass} value={projectId} onChange={(event) => setSelectedProject(event.target.value)}>
          {projects.map((project) => <option key={project.name} value={project.name}>{project.displayName || project.fullPath || project.name}</option>)}
        </select>
      </label>
      <ProjectBinding key={projectId} projectId={projectId} credentials={credentials} />
    </>}
  </section>;
}
