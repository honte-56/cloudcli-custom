/** Store per-user project credential references. Deleted credentials leave a binding so runs fail instead of switching accounts. */
import { getConnection } from '@/modules/database/connection.js';

type Binding = { credential_id: number; credential_name: string | null; credential_value: string | null; is_active: number | null };

/** Used by Projects to persist bindings and resolve credentials without exposing secrets in project views. */
export const projectGithubCredentialsDb = {
  get(userId: number, projectId: string): Binding | null {
    return getConnection().prepare(`SELECT b.credential_id, c.credential_name, c.credential_value, c.is_active
      FROM project_github_credentials b LEFT JOIN user_credentials c
      ON c.id = b.credential_id AND c.user_id = b.user_id AND c.credential_type = 'github_token'
      WHERE b.user_id = ? AND b.project_id = ?`).get(userId, projectId) as Binding | undefined ?? null;
  },
  set(userId: number, projectId: string, credentialId: number | null): void {
    const db = getConnection();
    if (credentialId === null) {
      db.prepare('DELETE FROM project_github_credentials WHERE user_id = ? AND project_id = ?').run(userId, projectId);
    } else {
      db.prepare(`INSERT INTO project_github_credentials (user_id, project_id, credential_id) VALUES (?, ?, ?)
        ON CONFLICT(user_id, project_id) DO UPDATE SET credential_id = excluded.credential_id`).run(userId, projectId, credentialId);
    }
  },
};
