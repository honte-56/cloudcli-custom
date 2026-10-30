/** Project credentials are exercised through storage, Git and runtime dispatch, using an isolated database. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { closeConnection, getConnection, initializeDatabase, credentialsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getProjectGithubCredential, setProjectGithubCredential, resolveProjectGithubAuthentication, rememberCloneGithubCredential } from '@/modules/github-auth/index.js';

const exec = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-gh-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    getConnection().exec("INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'unused'), (2, 'two', 'unused')");
    await run(root);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}
const token = (user: number, name: string) => Number(credentialsDb.createCredential(user, name, 'github_token', `test-secret-${name}`).id);

test('project selection survives reopening; Git and gh receive only the selected account; public view and prompt contain no secret', () => fixture(async (root) => {
  const project = projectsDb.createProjectPath(root).project!;
  const a = token(1, 'a'); token(1, 'newer');
  setProjectGithubCredential(1, project.project_id, a);
  closeConnection();
  const auth = await resolveProjectGithubAuthentication(1, root);
  assert.equal(auth?.environment.GH_TOKEN, 'test-secret-a');
  assert.match(auth!.instructions, /git.*gh/);
  assert.ok(!auth!.instructions.includes('test-secret'));
  assert.equal(getProjectGithubCredential(1, project.project_id).credentialId, a);
  assert.ok(!JSON.stringify(getProjectGithubCredential(1, project.project_id)).includes('test-secret'));
  const child = spawn('git', ['credential', 'fill'], { env: auth!.environment, stdio: 'pipe' });
  let output = ''; child.stdout.on('data', (data) => { output += data; });
  child.stdin.end('protocol=https\nhost=github.com\n\n');
  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 0); assert.match(output, /password=test-secret-a/);
  const foreign = spawn('git', ['credential', 'fill'], { env: auth!.environment, stdio: 'pipe' });
  let foreignOutput = ''; foreign.stdout.on('data', (data) => { foreignOutput += data; });
  foreign.stdin.end('protocol=https\nhost=example.com\n\n');
  await new Promise((resolve) => foreign.on('close', resolve));
  assert.ok(!foreignOutput.includes('test-secret'));
}));

test('bindings are per project and user, and disabled/deleted tokens fail without falling back', () => fixture(async (root) => {
  const first = projectsDb.createProjectPath(root).project!;
  const second = projectsDb.createProjectPath(path.join(root, 'second')).project!;
  const a = token(1, 'a'), b = token(1, 'b'), other = token(2, 'other');
  assert.throws(() => setProjectGithubCredential(1, first.project_id, other));
  setProjectGithubCredential(1, first.project_id, a); setProjectGithubCredential(1, second.project_id, b);
  const [one, two] = await Promise.all([resolveProjectGithubAuthentication(1, root), resolveProjectGithubAuthentication(1, second.project_path)]);
  assert.equal(one?.environment.GH_TOKEN, 'test-secret-a'); assert.equal(two?.environment.GH_TOKEN, 'test-secret-b');
  assert.equal(await resolveProjectGithubAuthentication(2, root), null);
  credentialsDb.toggleCredential(1, a, false);
  await assert.rejects(resolveProjectGithubAuthentication(1, root), /GitHub.*unavailable/);
  credentialsDb.deleteCredential(1, a);
  await assert.rejects(resolveProjectGithubAuthentication(1, root), /GitHub.*unavailable/);
  assert.equal(getProjectGithubCredential(1, first.project_id).configured, true);
  setProjectGithubCredential(1, first.project_id, null);
  assert.equal(await resolveProjectGithubAuthentication(1, root), null);
}));

test('clone remembers selected and newly entered tokens without duplicating an existing credential', () => fixture(async (root) => {
  const first = projectsDb.createProjectPath(root).project!;
  const a = token(1, 'a');
  rememberCloneGithubCredential(1, root, a, null);
  assert.equal(getProjectGithubCredential(1, first.project_id).credentialId, a);
  assert.equal(credentialsDb.getCredentials(1).length, 1);
  const second = projectsDb.createProjectPath(path.join(root, 'second')).project!;
  rememberCloneGithubCredential(1, second.project_path, null, 'inline-secret');
  assert.equal((await resolveProjectGithubAuthentication(1, second.project_path))?.environment.GH_TOKEN, 'inline-secret');
  assert.equal(credentialsDb.getCredentials(1).length, 2);
}));

test('subdirectories and linked worktrees use their repository binding', () => fixture(async (root) => {
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
  const project = projectsDb.createProjectPath(repo).project!;
  setProjectGithubCredential(1, project.project_id, token(1, 'a'));
  const sub = path.join(repo, 'src'); await mkdir(sub);
  const worktree = path.join(root, 'worktree');
  await exec('git', ['-C', repo, 'worktree', 'add', '-b', 'feature', worktree]);
  assert.equal((await resolveProjectGithubAuthentication(1, sub))?.environment.GH_TOKEN, 'test-secret-a');
  assert.equal((await resolveProjectGithubAuthentication(1, worktree))?.environment.GH_TOKEN, 'test-secret-a');
}));

test('provider dispatch explains authentication only on the first turn and refreshes credentials on every run', () => fixture(async (root) => {
  const { createProviderRuntimeService } = await import('@/modules/providers/services/provider-runtime.service.js');
  const project = projectsDb.createProjectPath(root).project!;
  const firstToken = token(1, 'a');
  const nextToken = token(1, 'b');
  const before = { ...process.env };
  for (const provider of ['claude', 'codex', 'cursor', 'opencode'] as const) {
    setProjectGithubCredential(1, project.project_id, firstToken);
    const calls: { command: string; token: string }[] = [];
    const createService = () => createProviderRuntimeService({ resolveProvider: () => ({
      id: provider, runtime: { async run(command: string, options: any) {
        calls.push({ command, token: options.environment.GH_TOKEN });
        assert.ok(!command.includes('test-secret'));
      } },
    }) as never });
    const service = createService();
    const writer = { userId: 1, send() {} };
    const appId = `app-${provider}`;
    const nativeId = `native-${provider}`;
    await service.run(provider, 'Without session ID', { cwd: root }, writer);
    sessionsDb.createAppSession(appId, provider, root);
    await service.run(provider, 'First turn', { cwd: root, sessionId: appId }, writer);
    sessionsDb.assignProviderSessionId(appId, nativeId);
    await service.run(provider, 'Second turn', { cwd: root, sessionId: appId }, writer);
    setProjectGithubCredential(1, project.project_id, nextToken);
    // Recreating the dispatcher and reopening storage models a server restart.
    closeConnection();
    await createService().run(provider, 'After restart', { cwd: root, sessionId: appId }, writer);
    await service.run(provider, 'Native resume', { cwd: root, sessionId: nativeId }, writer);
    assert.match(calls[0].command, /GitHub authentication configured/);
    assert.match(calls[1].command, /GitHub authentication configured/);
    assert.ok(calls[1].command.endsWith('First turn'));
    assert.deepEqual(calls.slice(2).map((call) => call.command), ['Second turn', 'After restart', 'Native resume']);
    assert.deepEqual(calls.map((call) => call.token), ['test-secret-a', 'test-secret-a', 'test-secret-a', 'test-secret-b', 'test-secret-b']);
  }
  assert.deepEqual({ ...process.env }, before, 'Parent environment must not change');
}));

test('successful clone completes only after its project binding is available to the agent', () => fixture(async (root) => {
  const { EventEmitter } = await import('node:events');
  const { startCloneProject } = await import('@/modules/projects/services/project-clone.service.js');
  const a = token(1, 'clone');
  const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill() {} });
  const operation = await startCloneProject({ workspacePath: root, githubUrl: 'https://github.com/example/cloned', githubTokenId: a, userId: 1 }, {
    onProgress() {},
    onComplete({ project }) { assert.equal(getProjectGithubCredential(1, String(project.projectId)).credentialId, a); },
  }, {
    validatePath: async () => ({ valid: true, resolvedPath: root }),
    spawnGitClone: () => child,
    registerProject: async (projectPath) => ({ project: { projectId: projectsDb.createProjectPath(projectPath).project!.project_id } }),
  });
  child.emit('close', 0);
  await operation.waitForCompletion;
  assert.equal((await resolveProjectGithubAuthentication(1, path.join(root, 'cloned')))?.environment.GH_TOKEN, 'test-secret-clone');
}));

test('settings HTTP API saves only user-owned active credentials and returns metadata', () => fixture(async (root) => {
  const express = (await import('express')).default;
  const { createProjectGithubCredentialRouter } = await import('@/modules/projects/project-github-credential.routes.js');
  const project = projectsDb.createProjectPath(root).project!;
  const a = token(1, 'api'), foreign = token(2, 'foreign');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: Number(req.header('x-user-id')) }; next(); });
  app.use(createProjectGithubCredentialRouter());
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/${project.project_id}/github-credential`;
  const put = (id: unknown) => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user-id': '1' }, body: JSON.stringify({ credentialId: id }) });
  try {
    assert.equal((await put(foreign)).status, 409);
    assert.equal((await put('invalid')).status, 400);
    assert.equal((await put(a)).status, 200);
    const response = await fetch(base, { headers: { 'x-user-id': '1' } });
    const body = await response.json() as any;
    assert.equal(body.credentialId, a); assert.ok(!JSON.stringify(body).includes('test-secret'));
    const other = await fetch(base, { headers: { 'x-user-id': '2' } });
    assert.equal((await other.json() as any).configured, false);
    assert.equal((await put(null)).status, 200);
    assert.equal((await (await fetch(base, { headers: { 'x-user-id': '1' } })).json() as any).configured, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}));

test('cloning with an existing token value reuses its saved identity', () => fixture(async (root) => {
  const project = projectsDb.createProjectPath(root).project!;
  const a = token(1, 'same');
  rememberCloneGithubCredential(1, root, null, 'test-secret-same');
  assert.equal(getProjectGithubCredential(1, project.project_id).credentialId, a);
  assert.equal(credentialsDb.getCredentials(1).length, 1);
}));

test('GitHub SSH remotes use the bound HTTPS token without changing repository configuration', () => fixture(async (root) => {
  await exec('git', ['init', root]);
  const project = projectsDb.createProjectPath(root).project!;
  setProjectGithubCredential(1, project.project_id, token(1, 'ssh'));
  const auth = await resolveProjectGithubAuthentication(1, root);
  for (const remote of ['git@github.com:example/repo.git', 'ssh://git@github.com/example/repo.git']) {
    const { stdout } = await exec('git', ['ls-remote', '--get-url', remote], { cwd: root, env: auth!.environment });
    assert.equal(stdout.trim(), 'https://github.com/example/repo.git');
  }
}));

test('unbound runs ignore an environment supplied in chat options', () => fixture(async (root) => {
  const { createProviderRuntimeService } = await import('@/modules/providers/services/provider-runtime.service.js');
  projectsDb.createProjectPath(root);
  let reached = false;
  const service = createProviderRuntimeService({ resolveProvider: () => ({ id: 'codex', runtime: { async run(_command: string, options: any) {
    reached = true; assert.equal(options.environment, undefined);
  } } }) as never });
  await service.run('codex', 'hello', { cwd: root, environment: { GH_TOKEN: 'untrusted' } }, { userId: 1, send() {} });
  assert.ok(reached);
}));
