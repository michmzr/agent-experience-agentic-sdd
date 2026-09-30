# AEL build identity and installation alignment

## Status

Approved for implementation by the user request “Implement ABI specs”, 2026-09-29. Change ID: `ABI`. Priority: P0. Dependencies: None for the baseline stage.

Implementation authorization and user acceptance of the verified ABI core on 2026-09-29 are recorded in the delivery index. This acceptance covers controlled-fixture qualification and does not record live-host qualification or rollout. Full ABI acceptance remains pending until the ARC receipt provenance integration is verified.

## Problem

The five registered projects invoke different AEL artifacts. Three wrappers target a package without the automatic analysis worker, while all inspected manifests report version 0.0.0. Static hook readiness does not verify the actual CLI target. The checked-in Codex startup matcher excludes resume.

## Evidence

F01: installation inventory on 2026-09-29. Three older installed targets, one other installed target and one checkout build were observed. This does not establish the cause of every historical capture gap.[^sources]

## Goals

Identify the artifact actually invoked by each managed integration and align a selected installation through a reviewable, reversible operation. Separate artifact compatibility from a live end-to-end qualification.

## Non-goals

Registry publication, an automatic updater, replacing unmanaged hooks, executing a discovered wrapper during inspection, and changing production databases during an installation inventory.

## User-visible behavior

Implemented commands:

```text
ael installation inspect [--repository <path>|--repository-id <id>] [--json]
ael installation plan --repository <path> --manifest <build-manifest.json> --output <plan.json>
ael installation apply --input <plan.json> [--json]
ael installation rollback --input <plan.json> [--json]
ael installation qualify --repository <path> [--json]
```

Inspection reports `current`, `outdated`, `missing`, `modified`, `unmanaged` or `unknown` separately for artifact identity and hook contract. Its public JSON uses repository IDs and build digests; an explicitly requested local plan contains the paths needed for the operator to review the mutation. A build with no manifest is `unknown`, never current because its package version matches.

The plan identifies only AEL-owned files, their current hashes, proposed hashes, target artifact and required event classes. Apply validates the plan again and either publishes all selected changes or restores the previous files. Inspection and planning do not modify hooks.

## Architecture and boundaries

A deterministic manifest at the package root records schema version, package version, source revision when available, a content-based build ID, owned artifact hashes, supported capture/result schemas and minimum reader/writer capabilities. The build ID hashes a canonical list of the shipped JS and skill files; it excludes timestamps and the manifest itself. A dirty checkout cannot claim the clean revision alone as its identity.

`src/installation/` owns manifest validation and alignment plans. The existing installer remains responsible for merging hook configuration. Inspection parses recognized managed wrapper forms as data; it never sources or executes arbitrary shell text. Unrecognized wrappers require a separately authorized migration, not an overwrite.

Successful new capture records retain build provenance through the bounded receipt contract from ARC. Historical records have unknown writer provenance. Installation checks can run without ARC; provenance persistence activates when its schema exists.

## State and lifecycle

`inspect → planned → applied → qualified` are separate facts. A content change after planning invalidates the plan. A repeated application of the same already-applied plan is idempotent. `qualified` requires a controlled start/action/result/end/resume test through the installed entrypoint, not file existence. Keep previous owned files and manifest as a rollback generation.

The package advertises its writable schema capabilities. After later schema upgrades, rollback may select only an artifact whose writer capabilities satisfy the store minimum. Otherwise capture is disabled for that artifact with a fixed diagnostic; an unsafe older writer is not launched.

## Failure behavior

Missing artifacts, invalid hashes, changed targets, symlinks crossing the managed installation boundary and incompatible writers reject apply before mutation. Alignment holds one repository-local SQLite write transaction before reading or publishing a generation journal. A persisted application ID identifies the owned lock file; an unrelated SQLite file at that path is left unchanged. An empty lock file left before initialization is recovered. A second process is rejected while the lock is held. Process exit, including SIGKILL immediately after acquisition and before journal publication, releases the lock automatically. Retrying the same hash-bound plan then recovers a recorded interrupted generation or starts publication when no generation was recorded. Foreign file edits still reject recovery. Existing legacy locks with a verified live owner remain protected; a verified dead owner can be removed under the new mutex. Ownerless, malformed or foreign legacy lock content is preserved because no safe ownership claim is available. Capture remains fail-open; installation failure does not block an agent action.

## Privacy and security

No credentials, machine-wide environment dump or raw hook payload enters the manifest. Local paths stay in the private alignment plan. Public reports expose bounded identity and compatibility fields. Hook trust changes remain an explicit host operation; file installation never claims host trust.

## Compatibility and rollout

Pilot the current AEL repository first, then one external project, then the remaining registered projects. Preserve foreign hook groups. Qualify the currently supported source aliases from actual integration evidence; include startup and resume without admitting unsupported lifecycle classes. Existing packages without manifests remain readable inventory entries.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| ABI-R1 | Manifest identity is deterministic for identical shipped content, changes when shipped code changes, and does not equate two 0.0.0 artifacts. | ABI-A1 | Build twice, compare identities, then change one shipped byte and require a different identity. |
| ABI-R2 | Inventory resolves the actual managed wrapper target without executing it and distinguishes unknown, modified and missing targets. | ABI-A2 | Inventory synthetic copies of the observed installation shapes; a trap wrapper is never executed. |
| ABI-R3 | Alignment uses hash-bound plans, preserves foreign hooks and supports idempotent apply and rollback. | ABI-A3 | Race a file edit after plan creation; reject it. Inject failure after the first publication and verify restoration. Kill immediately after lock acquisition and retry through the CLI without manual repair; preserve foreign hooks. Verify a live lock rejects a contender and SIGKILL releases it. A foreign SQLite lock file and ownerless legacy lock remain unchanged. |
| ABI-R4 | A qualified Codex integration delivers supported startup and resume signals and a correlated technical result through the installed artifact. | ABI-A4 | Run the lifecycle fixture through the installed package, then repeat with a matcher excluding resume and require qualification failure. |
| ABI-R5 | The actual build is attributable to new receipts and incompatible writer rollback is refused. | ABI-A5 | Capture two distinct operations through verified installed artifacts with different shipped bytes but the same package version. Reopen the receipt store, identify each retained receipt by private per-operation correlation, and compare its build ID and writer capability with the manifest of the artifact invoked for that operation. Swap the two receipt build IDs in a fixture: the association check must fail although the set of IDs is unchanged. Evict one receipt under the configured retention limit; report its receipt-level attribution as unavailable and do not reconstruct it from a surviving admission record. Caller-provided or unverified identity cannot establish attribution, and historical receipts remain unknown. Reject an older writer against a newer store before mutation and compare the store bytes. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Implementation amendment

The user authorized automatic lock recovery and this spec update on 2026-09-29. SQLite locking replaces the directory/owner-file acquisition protocol; lock lifetime follows the process rather than persisted owner metadata. The accepted ABI core scope remains unchanged, and receipt persistence still depends on ARC.

On 2026-09-29, the user accepted the controlled process-interruption test as sufficient evidence for the ABI-A3 lock-recovery behavior. This acceptance does not approve rollout or complete ABI-A5 and live-host qualification.

ABI-A5 now specifies per-operation persisted receipt attribution separately from the existing admission-envelope check. Its swapped-attribution negative control and receipt assertions remain pending ARC task 4; the existing ABI-A5 core test does not satisfy them.

Receipt attribution is defined only inside ARC's reported retention window. An evicted receipt has unavailable receipt-level attribution even if another record still describes the operation.

## Open decisions

No unresolved product choice is hidden in this specification. Source capability qualification is an implementation discovery task with explicit unsupported outcomes, not permission to guess a host contract. The delivery index records implementation approval.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-build-identity.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [2026-09-29-ael-records-and-lessons.md](../../../docs/analysis/2026-09-29-ael-records-and-lessons.md), [hook-installation.ts](../../../src/cli/hook-installation.ts), [ael-passive-capture.sh](../../../.agents/hooks/ael-passive-capture.sh), [roadmap.md](../../../docs/product/roadmap.md). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
