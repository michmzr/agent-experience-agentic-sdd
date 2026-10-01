# Build identity and installation alignment

`pnpm build` writes `build-manifest.json`. Its build ID is the SHA-256 digest of a sorted list of shipped JavaScript and skill-file hashes. Package version and source revision are separate metadata; no-manifest artifacts are unknown even when their package version matches.

Inspection reads recognized managed wrappers as data. It never executes them. Reports contain repository IDs, build digests and separate artifact/hook states. Registration lookup uses the local registry read-only.

```sh
ael installation inspect --repository /absolute/repository --json
ael installation inspect --repository-id repository-id --json
```

Create a private plan using the manifest at the selected artifact’s package root. Inspect the plan before applying it; it contains local paths and previous file contents. Planning does not modify hooks. Existing unknown wrappers require explicit migration. A legacy target without a manifest can be inspected but cannot be aligned automatically because its rollback writer cannot be verified.

```sh
ael installation plan --repository /absolute/repository \
  --manifest /absolute/artifact/build-manifest.json --output /private/plan.json
ael installation apply --input /private/plan.json --json
ael installation rollback --input /private/plan.json --json
```

Apply verifies artifact bytes, ownership, repository identity, file hashes and modes. It preserves foreign hook groups. A process-held SQLite transaction serializes alignment. The owned lock file carries a SQLite application ID; a foreign database at that path is rejected without changing its bytes or mode. Process exit automatically releases the mutex, including interruption before the first journal write. A stopped publisher can be retried using the same plan if the recorded generations have not been edited. Unrecognized legacy lock content is preserved; a verified live legacy owner remains protected. Generation journals in `.agents/ael-installation` retain rollback contents. A changed target or incompatible previous writer rejects the operation.

The qualification command invokes the installed executable wrapper with isolated storage and controlled startup/action/result/end/resume fixtures. The result includes `evidence: controlled-fixture`; this does not establish host trust or actual host event delivery. Inspection always remains unqualified.

```sh
ael installation qualify --repository /absolute/repository --json
```

Hook admission retains a bounded build-provenance envelope and enforces the spool writer minimum without opening the primary database. The spool records receipt writer and operation scope, applies bounded retention, and upgrades older receipt columns on open. Historical records do not acquire inferred writer provenance.[^receipt]

[^receipt]: [Capture spool implementation](../../src/capture/spool.ts).
