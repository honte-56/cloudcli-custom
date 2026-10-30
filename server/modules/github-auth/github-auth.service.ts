/** Bind projects to user-owned GitHub credentials and prepare run-local authentication. No secrets enter repository files or prompt text. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { credentialsDb, githubTokensDb, projectGithubCredentialsDb, projectsDb, getConnection } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const exec = promisify(execFile);
function requireProject(projectId: string) {
  const project = projectsDb.getProjectById(projectId);
  if (!project) throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  return project;
}

/** Used by Projects settings routes; the response deliberately contains only credential metadata. */
export function getProjectGithubCredential(userId: number, projectId: string) {
  requireProject(projectId);
  const binding = projectGithubCredentialsDb.get(userId, projectId);
  return { configured: Boolean(binding), credentialId: binding?.credential_id ?? null, name: binding?.credential_name ?? null, isActive: Boolean(binding?.is_active) };
}

/** Used by Projects settings and clone completion to select an active credential belonging to the authenticated user. */
export function setProjectGithubCredential(userId: number, projectId: string, credentialId: number | null): void {
  requireProject(projectId);
  if (credentialId !== null && !githubTokensDb.getGithubTokenById(userId, credentialId)) {
    throw new AppError('GitHub credential is unavailable. Select an active token in Settings.', { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE', statusCode: 409 });
  }
  projectGithubCredentialsDb.set(userId, projectId, credentialId);
}

/** Used by the clone service after project registration. Inline credentials are saved once for subsequent runs. */
export function rememberCloneGithubCredential(userId: number, projectPath: string, credentialId: number | null, inlineToken: string | null): void {
  if (credentialId === null && !inlineToken) return;
  const project = projectsDb.getProjectPath(projectPath)!;
  getConnection().transaction(() => {
    const selectedId = credentialId ?? githubTokensDb.findActiveTokenId(userId, inlineToken!) ?? Number(credentialsDb.createCredential(userId, path.basename(projectPath), 'github_token', inlineToken!).id);
    setProjectGithubCredential(userId, project.project_id, selectedId);
  })();
}

/** Used by Providers before each run. Linked worktrees inherit the main repository binding unless explicitly bound themselves. */
export async function resolveProjectGithubAuthentication(userId: number, projectPath: string) {
  const project = projectsDb.getProjectPath(projectPath);
  let binding = project ? projectGithubCredentialsDb.get(userId, project.project_id) : null;
  if (!binding) {
    // Git owns the mapping from a subdirectory/worktree to the shared repository;
    // path-prefix matching would incorrectly cross nested repository boundaries.
    try {
      const { stdout } = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: projectPath });
      const mainProject = projectsDb.getProjectPath(path.dirname(stdout.trim()));
      binding = mainProject ? projectGithubCredentialsDb.get(userId, mainProject.project_id) : null;
    } catch (error) {
      const gitError = error as { code?: string | number };
      if (gitError.code === 'ENOENT' || gitError.code === 128) return null;
      throw error;
    }
  }
  if (!binding) return null;
  if (!binding.is_active || !binding.credential_value) {
    throw new AppError('GitHub credential is unavailable. Select an active token in Settings.', { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE', statusCode: 409 });
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GH_TOKEN: binding.credential_value,
    CLOUDCLI_GITHUB_TOKEN: binding.credential_value,
    GIT_TERMINAL_PROMPT: '0',
  };
  // Append to inherited config so unrelated process-local Git settings survive.
  // Reset helpers at both scopes: a host-specific machine helper must not win.
  const entries = [
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    ['credential.helper', ''],
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', '!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$CLOUDCLI_GITHUB_TOKEN"; fi; }; f'],
  ];
  const start = Number(environment.GIT_CONFIG_COUNT || 0);
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${start + index}`] = key;
    environment[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  environment.GIT_CONFIG_COUNT = String(start + entries.length);
  return {
    environment,
    instructions: 'This project has GitHub authentication configured for git over HTTPS and gh. Use git and gh directly; do not log in, read, print, or copy credentials. GitHub SSH remotes are mapped to HTTPS for this run. Commit and push only as requested by the user. Git author identity comes from the existing Git configuration.',
  };
}
