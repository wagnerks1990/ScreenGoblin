# Hosted Wiki maintenance

The hosted ScreenGoblin Wiki is initialized. `wiki/Home.md` is the approved,
Git-reviewed landing page; the detailed architecture, protocol, release gates,
and operational guidance remain in the repository documentation linked from it.

The `Wiki synchronization` workflow publishes only that landing page from
protected `main`, after it has passed the repository's normal review and merge
requirements. Pull requests and feature-branch manual runs do not receive
`WIKI_TOKEN`. Other Wiki pages, including existing manually written pages, are
preserved. A source change never authorizes publishing student information,
credentials, school-specific infrastructure, or licensed private material.

Before enabling synchronization, configure the `wiki-publication` environment
to allow deployments only from the `main` branch. Move `WIKI_TOKEN` into that
environment and remove the repository-level copy. A repository-level secret
remains available to independently edited feature-branch workflows; the main
condition in this workflow cannot restrict those other workflows. Creating an
unrestricted environment is insufficient. The connected administration API
returned HTTP 403 when this configuration was attempted, so owner setup is a
verified blocker, alongside the current required-check mismatch.

The token needs permission to push this repository's Wiki. The workflow uses a
temporary Git askpass helper;
the value is never placed in a URL, argument, or stored remote configuration.
Checkouts disable credential persistence, temporary files and clones are removed
on exit, and publication uses a normal fast-forward push. Even unchanged runs
verify authenticated write permission with a dry run and compare Home against a
fresh remote clone.

If the Wiki clone fails because the Wiki was deleted or never initialized,
create a Home page through the repository Wiki tab and rerun the workflow from
`main`. If sync is skipped, verify the workflow ran on protected `main`. If push
fails, check the secret's effective Wiki access; never put a credential into a
tracked file or log and never use a force push to resolve divergent Wiki work.

This workflow's final-head PR CI and independent review must pass before merge.
A successful PR run does not establish hosted synchronization or secret access:
verify the first main sync job and the published Home afterward. The existing
required-check mismatch is an administrative blocker; do not bypass it for docs.
