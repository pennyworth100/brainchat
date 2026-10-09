# PostgreSQL image used by CI

CI uses the Docker Official Image for PostgreSQL 16 from its public ECR mirror,
pinned by OCI index digest. No registry credential is required. This is only the
ephemeral CI service; it does not change Railway, production, or staging.

## Verified provenance (2026-10-09)

- Docker Hub: `registry-1.docker.io/v2/library/postgres/manifests/16-alpine`
- Mirror: `public.ecr.aws/v2/docker/library/postgres/manifests/16-alpine`
- Both responses were byte-identical, fetched with normal TLS verification.
- SHA-256 of both response bodies:
  `721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`
- Linux amd64 child manifest:
  `sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`
- Image metadata: `16.15-alpine3.24`, source
  `docker-library/postgres` commit `9d15534160ade17f2b6c455a39ee967c49b1937d`.

The change addresses Docker Hub's unauthenticated pull rate limit. It was
confirmed in [CI attempt 2](https://github.com/pennyworth100/brainchat/actions/runs/37990951346/attempts/2),
job `114025061803`: all three container pulls failed with `toomanyrequests`
before checkout; application checks never ran. One workflow retry did not
resolve it. The mirror changes neither test commands nor service configuration.

## Updating the pin

1. Fetch the OCI index from Docker Hub and ECR over verified TLS, using their
   anonymous pull-token endpoints. Keep those short-lived tokens out of logs.
2. Require identical index bytes and SHA-256 digests; verify the expected
   PostgreSQL major version and Linux amd64 child manifest. If the mirror is
   lagging or differs, stop rather than silently substituting an image.
3. Update the digest in `.github/workflows/ci.yml` and this provenance record.
4. Require the full workflow, including PostgreSQL and crash tests, to pass at
   the exact new commit. A successful manifest fetch alone is not CI success.

Rollback is a one-line service-image revert. Do not bypass the PostgreSQL tests
or add secrets merely to hide an infrastructure failure. The immutable pin
requires deliberate updates to receive newer PostgreSQL image patches.
