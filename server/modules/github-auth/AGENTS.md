# GitHub authentication boundary

This module owns project-to-credential selection and run-local authentication. It depends on Database and Shared only; Projects, Agent API and Providers consume its public barrel. Keeping this outside Projects avoids a Projects/Providers dependency cycle. Public settings responses and instructions never include secret values. A deleted or disabled bound token must fail rather than switch accounts. Worktrees resolve through Git's common directory, not path-prefix guessing.
