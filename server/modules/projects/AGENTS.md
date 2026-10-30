# Project authentication

Project GitHub bindings belong to the authenticated user and the database project ID. Clone completion must persist the selected binding before announcing success. Existing projects are configured through the credentials settings API; public responses contain metadata only. Linked worktrees inherit the main repository binding unless explicitly bound. A missing or disabled bound credential is an error, never a reason to select another account.
