# Git server configuration and DAG credential scope

GitServer configuration supports encrypted token storage, masked reads, updates,
verification and Gitea user/repository/branch discovery. Repository ownership is
configured on a project (`git_server_id`, `git_repository`, `git_branch`), not on
the shared GitServer. Explicit null/empty project bindings clear the selection.
Repository and branch discovery accept `page` and `per_page` (1–100). Upstream
401/403 invalidate verification; errors never return upstream bodies or tokens.
Other registered platform types currently return explicit unsupported responses
for Gitea discovery operations. They are not advertised as working adapters.

A bound project is **not a DAG credential grant**. Current code reads GitServer
secrets in the GitServer HTTP adapter. DAG dispatch and the credential broker
resolve separately declared `credential_ref` bindings through the credential
store. There is no project-to-run grant or automatic publisher authorization.
The existing GitHub broker does not establish native Gitea PR support.

The next bounded implementation should:

1. Resolve a project's GitServer binding in trusted preflight, checking missing,
   inactive and expired credentials before spending model work.
2. Require an explicit grant scoped to the immutable run, repository, node roles,
   permitted actions and credential version. Project association alone must not
   authorize access. Rotation/revocation must invalidate outstanding grants.
3. Supply clone authority only to the trusted checkout operation, and publication
   authority only through the selected Manager broker. Review models receive
   sanitized issue/candidate/review data, never GitServer tokens.
4. Reuse transport fences, durable mutation receipts and idempotency keys. Cover
   wrong project/repository/node, expired grants, revocation, retries and secret
   reflection with negative tests.

Native Gitea PR create/reuse, webhook verification, head-SHA review idempotency
and review writeback are a separate follow-up. No PR is created by GitServer
registration, verification, repository discovery or project binding. Credential
projection and output leakage checks remain enforced.
