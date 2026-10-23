# Documentation deployment

Production docs are served by GitHub Pages at <https://mkalo.github.io/snowtyped/>.
Pull request previews are optional and use Cloudflare Pages. The maintainer owns
both: the Pages settings, the `github-pages` and `docs-preview` environments, and
the Cloudflare project and token.

## Production

**Deploy docs** (`.github/workflows/docs.yml`) publishes one release tag. It runs
on main only, requires the tag to point at a commit on main whose `package.json`
version matches the tag, runs `pnpm check` in `website/` at that commit, and
deploys only if every step passes. The version badge, API reference, and source
links therefore describe exactly the released package. **Release package →
finalize** calls it with `v<version>` after the Git tag exists; nothing deploys
from ordinary pushes to main.

To restore an earlier site, or to deploy after a failed run, dispatch **Deploy
docs** on main with the last good tag. Each run rebuilds that tag from source, so
recovery does not depend on retained artifacts. A failing build leaves the
current deployment in place.

One-time setup, which requires the repository to stay public (or a plan that
allows Pages for private repositories):
1. In **Settings → Pages**, set **Source** to **GitHub Actions**. GitHub then
   creates the `github-pages` environment.
2. Restrict the environment to main, as recorded in
   [github-pages.json](../.github/environments/github-pages.json):

   ```sh
   gh api repos/Mkalo/snowtyped/environments/github-pages --method PUT --input .github/environments/github-pages.json
   gh api repos/Mkalo/snowtyped/environments/github-pages/deployment-branch-policies -f name=main -f type=branch
   ```

   Add yourself as a required reviewer if every production deployment should
   wait for approval.
3. After the first release is finalized, or by dispatching **Deploy docs** with
   an existing tag, confirm the deployment URL, search, and a missing page (which
   must render the site's 404 page).

GitHub Pages caches responses for up to ten minutes. Astro and Pagefind assets
use content-hashed file names, so a new deployment never mixes old and new
assets; only HTML may be briefly stale. There are no redirects to maintain yet.
When a page moves, add its old path to `redirects` in `website/astro.config.mjs`;
the static build then emits a redirect page at the old URL.

To use a custom domain, configure it under **Settings → Pages** and set the
repository variable `DOCS_URL` to the full site URL, such as
`https://docs.example.com/`. The site's `site` and `base` come from that URL
(default `https://mkalo.github.io/snowtyped/`). Content links stay root-relative,
such as `/guides/queries/`; the build adds the base path and fails on links that
do not resolve under it.

## Pull request previews

The CI `Docs` job uploads the built site as the `docs-site` artifact for every
run, so any pull request, including one from a fork, can be inspected by
downloading it. Serve it under the base path, for example by copying it into a
`snowtyped/` directory and running a static server from the parent directory.

**Docs preview** (`.github/workflows/docs-preview.yml`) publishes hosted previews
for pull requests from branches of this repository. It runs from main after CI
succeeds, never checks out pull request code, and uploads only the static files
from the `docs-site` artifact. Fork pull requests get no hosted preview. The
Cloudflare token lives only in the `docs-preview` environment, which is limited
to main; package, npm, and Snowflake credentials are never available to it.
Each preview is served at `https://pr-<number>.<project>.pages.dev/` under the
production base path, with a `noindex` header, and is linked from the pull
request as the `Docs preview` commit status. A daily scheduled run, which can
also be dispatched manually, deletes the previews of pull requests that are no
longer open.

The workflow does nothing until `CLOUDFLARE_ACCOUNT_ID` is set. One-time setup:
1. Create the project: `npx wrangler pages project create snowtyped-docs --production-branch main`.
   Only preview branches are deployed to it.
2. Create a Cloudflare API token with the **Account → Cloudflare Pages → Edit**
   permission for that account.
3. Create the `docs-preview` environment limited to main, as recorded in
   [docs-preview.json](../.github/environments/docs-preview.json), and add the
   token as its `CLOUDFLARE_API_TOKEN` secret:

   ```sh
   gh api repos/Mkalo/snowtyped/environments/docs-preview --method PUT --input .github/environments/docs-preview.json
   gh api repos/Mkalo/snowtyped/environments/docs-preview/deployment-branch-policies -f name=main -f type=branch
   gh secret set CLOUDFLARE_API_TOKEN --env docs-preview
   ```

4. Set the repository variable `CLOUDFLARE_ACCOUNT_ID`, and
   `CLOUDFLARE_PAGES_PROJECT` if the project is not named `snowtyped-docs`.

Rotate the token by replacing the environment secret. To disable previews,
delete the `CLOUDFLARE_ACCOUNT_ID` variable.
