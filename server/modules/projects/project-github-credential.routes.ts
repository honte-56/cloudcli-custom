import express from 'express';
import { getProjectGithubCredential, setProjectGithubCredential } from '@/modules/github-auth/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';

/** Mounted by Projects for authenticated, per-user project credential settings. */
export function createProjectGithubCredentialRouter() {
  const router = express.Router();
  const userId = (req: express.Request) => {
    const id = Number((req as express.Request & { user?: { id: number | string } }).user?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('Authentication required', { code: 'UNAUTHORIZED', statusCode: 401 });
    return id;
  };
  router.get('/:projectId/github-credential', asyncHandler(async (req, res) => {
    res.json(getProjectGithubCredential(userId(req), String(req.params.projectId)));
  }));
  router.put('/:projectId/github-credential', asyncHandler(async (req, res) => {
    const credentialId = req.body?.credentialId;
    if (credentialId !== null && (!Number.isSafeInteger(credentialId) || credentialId <= 0)) {
      throw new AppError('credentialId must be a positive integer or null', { code: 'INVALID_CREDENTIAL_ID', statusCode: 400 });
    }
    const id = userId(req);
    const projectId = String(req.params.projectId);
    setProjectGithubCredential(id, projectId, credentialId);
    res.json(getProjectGithubCredential(id, projectId));
  }));
  return router;
}
