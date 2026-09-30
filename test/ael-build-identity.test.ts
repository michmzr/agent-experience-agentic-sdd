import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, statSync, realpathSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAlignmentPlan, applyAlignmentPlan } from "../src/installation/alignment.js";
import { ingestPassiveHook } from "../src/capture/hook-ingress.js";
import { tmpdir } from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createBuildManifest, validateManifest, verifyBuild } from "../src/installation/build-manifest.js";
import { CaptureSpool } from "../src/capture/spool.js";
import { runCli } from "../src/cli.js";
import { installHooks, managedEventSupported } from "../src/cli/hook-installation.js";
import { initializeGitRepository } from "./helpers/git-repository.js";
import { once } from "node:events";
import test from "node:test";

test("ABI-A1 build emits content identity rather than package version", () => {
  const path = join(process.cwd(), "build-manifest.json");
  assert.equal(existsSync(path), true, "build must emit an artifact manifest");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.match(manifest.buildId, /^[a-f0-9]{64}$/);
  assert.equal(manifest.packageVersion, "0.0.0");
});

function fixture(): string { const root = mkdtempSync(join(tmpdir(), "abi-")); initializeGitRepository(root); return realpathSync(root); }
function artifact(root: string): void {
  mkdirSync(join(root, "dist/src"), { recursive: true });
  mkdirSync(join(root, "skills/ael"), { recursive: true });
  writeFileSync(join(root, "dist/src/cli.js"), "console.log('fixture');\n");
  writeFileSync(join(root, "skills/ael/SKILL.md"), "fixture skill");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.0" }));
}
test("ABI-A1 deterministic builds, changed byte, duplicate paths and symlink escape", () => {
  const root = fixture(); const external = fixture();
  try {
    artifact(root); artifact(external);
    const first = createBuildManifest(root);
    assert.deepEqual(createBuildManifest(root), first);
    writeFileSync(join(root, "dist/src/cli.js"), "changed byte");
    const changed = createBuildManifest(root);
    assert.notEqual(changed.buildId, first.buildId);
    assert.equal(changed.packageVersion, first.packageVersion);
    assert.throws(() => validateManifest({ ...first, artifacts: [...first.artifacts, first.artifacts[0]] }), /Duplicate/);
    assert.throws(() => verifyBuild(root, first), /Modified/);
    symlinkSync(join(external, "skills/ael/SKILL.md"), join(root, "skills/escape"));
    assert.throws(() => createBuildManifest(root), /Symlink/);
    execFileSync(process.execPath, ["dist/src/installation/build-manifest.js"]);
    const one = readFileSync("build-manifest.json", "utf8");
    execFileSync(process.execPath, ["dist/src/installation/build-manifest.js"]);
    assert.equal(readFileSync("build-manifest.json", "utf8"), one);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
});

test("ABI-A2 public inventory resolves a managed target without executing a trap", () => {
  const root = fixture(); const build = fixture();
  try {
    artifact(build);
    installHooks({ repositoryRoot: root, sources: ["codex"], cliEntrypoint: join(build, "dist/src/cli.js") });
    const result = runCli(["installation", "inspect", "--repository", root, "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.artifact.status, "unknown");
    assert.equal(report.hooks.codex, "current");
    assert.equal(result.stdout.includes(build), false);
    assert.equal(result.stdout.includes(root), false);
    writeFileSync(join(build, "build-manifest.json"), JSON.stringify(createBuildManifest(build)));
    let next = runCli(["installation", "inspect", "--repository", root, "--json"]);
    assert.equal(JSON.parse(next.stdout).artifact.status, "outdated");
    writeFileSync(join(build, "dist/src/cli.js"), "modified");
    next = runCli(["installation", "inspect", "--repository", root, "--json"]);
    assert.equal(JSON.parse(next.stdout).artifact.status, "modified");
    rmSync(join(build, "dist/src/cli.js"));
    next = runCli(["installation", "inspect", "--repository", root, "--json"]);
    assert.equal(JSON.parse(next.stdout).artifact.status, "missing");
    const marker = join(root, "trap");
    const wrapper = join(root, ".agents/hooks/ael-passive-capture.sh");
    writeFileSync(wrapper, `#!/bin/sh\ncli="${join(build, "dist/src/cli.js")}"\ntouch "${marker}"\n`);
    next = runCli(["installation", "inspect", "--repository", root, "--json"]);
    assert.equal(JSON.parse(next.stdout).artifact.status, "unknown");
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(build, { recursive: true, force: true }); }
});

test("ABI-A3 public alignment plan is hash-bound, idempotent and preserves foreign hooks", () => {
  const root = fixture();
  try {
    const configuration = join(root, ".codex/hooks.json");
    mkdirSync(join(root, ".codex"));
    writeFileSync(configuration, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "foreign-command" }] }] } }));
    const plan = join(root, "plan.json");
    const result = runCli(["installation", "plan", "--repository", root, "--manifest", join(process.cwd(), "build-manifest.json"), "--output", plan, "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    const before = readFileSync(configuration, "utf8");
    writeFileSync(configuration, before + " ");
    assert.equal(runCli(["installation", "apply", "--input", plan, "--json"]).exitCode, 1);
    assert.equal(readFileSync(configuration, "utf8"), before + " ");
    writeFileSync(configuration, before);
    assert.equal(runCli(["installation", "apply", "--input", plan, "--json"]).exitCode, 0);
    const applied = readFileSync(configuration, "utf8");
    assert.equal(applied.includes("foreign-command"), true);
    assert.equal(runCli(["installation", "apply", "--input", plan, "--json"]).exitCode, 0);
    assert.equal(readFileSync(configuration, "utf8"), applied);
    assert.equal(runCli(["installation", "rollback", "--input", plan, "--json"]).exitCode, 0);
    assert.equal(readFileSync(configuration, "utf8"), before);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ABI-A3 failed publication restores files and rejects symlink boundaries", () => {
  const root = fixture(); const outside = fixture();
  try {
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    assert.throws(() => applyAlignmentPlan(plan, { afterPublication: count => { if (count === 1) throw new Error("injected failure"); } }), /injected failure/);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
    assert.equal(existsSync(join(root, ".codex/hooks.json")), false);
    symlinkSync(outside, join(root, ".codex"));
    assert.throws(() => applyAlignmentPlan(plan), /symlink/);
    assert.equal(existsSync(join(outside, "hooks.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("ABI-A4 installed lifecycle fixture qualifies startup, resume and correlated result", () => {
  const root = fixture();
  const installed = fixture();
  try {
    cpSync(join(process.cwd(), "dist/src"), join(installed, "dist/src"), { recursive: true });
    cpSync(join(process.cwd(), "skills"), join(installed, "skills"), { recursive: true });
    cpSync(join(process.cwd(), "package.json"), join(installed, "package.json"));
    cpSync(join(process.cwd(), "build-manifest.json"), join(installed, "build-manifest.json"));
    installHooks({ repositoryRoot: root, sources: ["codex"], cliEntrypoint: join(installed, "dist/src/cli.js") });
    let result = runCli(["installation", "qualify", "--repository", root, "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    const qualified = JSON.parse(result.stdout);
    assert.equal(qualified.status, "qualified");
    assert.equal(qualified.evidence, "controlled-fixture");
    assert.equal(qualified.startup && qualified.resume && qualified.correlatedResult && qualified.end, true);
    const path = join(root, ".codex/hooks.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.hooks.SessionStart[0].matcher = "startup";
    writeFileSync(path, JSON.stringify(config));
    result = runCli(["installation", "qualify", "--repository", root, "--json"]);
    assert.equal(JSON.parse(result.stdout).status, "unqualified");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(installed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("ABI-A5 admission carries actual build provenance and refuses newer writer stores", () => {
  const root = fixture();
  const databasePath = join(root, "experience.sqlite");
  const options = { source: "codex" as const, input: JSON.stringify({ session_id: "abi-provenance", hook_event_name: "SessionStart", source: "startup" }), databasePath, now: () => "2026-09-29T10:00:00.000Z", workingDirectory: root, scheduleDrain: () => {} };
  try {
    assert.equal(ingestPassiveHook(options).status, "captured");
    const db = new DatabaseSync(join(root, "capture-spool.sqlite"));
    const row = db.prepare("SELECT payload FROM records").get() as { payload: string };
    const provenance = JSON.parse(row.payload).buildProvenance;
    assert.equal(provenance?.buildId, JSON.parse(readFileSync("build-manifest.json", "utf8")).buildId);
    assert.equal(provenance?.writer, 2);
    assert.equal(row.payload.includes(root), false);
    db.exec("CREATE TABLE IF NOT EXISTS ael_writer_contract (id INTEGER PRIMARY KEY, minimum_writer INTEGER NOT NULL); INSERT OR REPLACE INTO ael_writer_contract VALUES (1, 3);");
    db.close();
    const before = readFileSync(join(root, "capture-spool.sqlite"));
    const result = ingestPassiveHook(options);
    assert.equal(result.status, "degraded");
    assert.equal("code" in result ? result.code : undefined, "INCOMPATIBLE_WRITER");
    assert.deepEqual(readFileSync(join(root, "capture-spool.sqlite")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ABI-A5 two installed builds retain per-operation capture and retry attribution", () => {
  const root = fixture(); const installedA = fixture(); const installedB = fixture();
  const databasePath = join(root, "experience.sqlite");
  const captureScript = `import {pathToFileURL} from 'node:url'; const {ingestPassiveHook} = await import(pathToFileURL(process.argv[1]).href); const result = ingestPassiveHook({source:'codex',input:process.argv[4],databasePath:process.argv[2],workingDirectory:process.argv[3],now:()=> '2026-09-29T10:00:00.000Z',scheduleDrain:()=>{}}); console.log(JSON.stringify(result));`;
  const retryScript = `import {pathToFileURL} from 'node:url'; const {CaptureSpool} = await import(pathToFileURL(process.argv[1]).href); const spool = new CaptureSpool(process.argv[2]); spool.claim('2026-09-29T10:00:00.000Z',2); spool.retry(process.argv[3],'2026-09-29T10:00:01.000Z'); spool.close();`;
  try {
    for (const installed of [installedA, installedB]) {
      cpSync(join(process.cwd(), "dist/src"), join(installed, "dist/src"), { recursive: true });
      cpSync(join(process.cwd(), "skills"), join(installed, "skills"), { recursive: true });
      cpSync(join(process.cwd(), "package.json"), join(installed, "package.json"));
    }
    writeFileSync(join(installedB, "skills/ael/SKILL.md"), readFileSync(join(installedB, "skills/ael/SKILL.md"), "utf8") + "\nsecond build\n");
    const manifestA = createBuildManifest(installedA); const manifestB = createBuildManifest(installedB);
    assert.equal(manifestA.packageVersion, manifestB.packageVersion);
    assert.notEqual(manifestA.buildId, manifestB.buildId);
    writeFileSync(join(installedA, "build-manifest.json"), JSON.stringify(manifestA));
    writeFileSync(join(installedB, "build-manifest.json"), JSON.stringify(manifestB));
    const inputs = ["first", "second"].map(session => JSON.stringify({ session_id: session, hook_event_name: "SessionStart", source: "startup" }));
    for (const [installed, input] of [[installedA, inputs[0]!], [installedB, inputs[1]!]] as const) {
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", captureScript, join(installed, "dist/src/capture/hook-ingress.js"), databasePath, root, input], { encoding: "utf8" }));
      assert.equal(result.status, "captured");
    }
    const initial = new CaptureSpool(join(root, "capture-spool.sqlite"));
    const initialReceipts = initial.receiptReport().receipts;
    const [first, second] = initialReceipts;
    assert.equal(initial.status().admitted, 2);
    assert.equal(initialReceipts.length, 2);
    assert.deepEqual(initialReceipts.map(receipt => receipt.buildId), [manifestA.buildId, manifestB.buildId]);
    assert.notEqual(first!.operationKey, second!.operationKey);
    const database = new DatabaseSync(join(root, "capture-spool.sqlite"));
    const firstDelivery = (database.prepare("SELECT delivery_id, payload FROM records").all() as Array<{ delivery_id: string; payload: string }>).find(row => JSON.parse(row.payload).session?.id === "first")?.delivery_id;
    database.close();
    assert.ok(firstDelivery);
    initial.close();
    execFileSync(process.execPath, ["--input-type=module", "-e", retryScript, join(installedB, "dist/src/capture/spool.js"), join(root, "capture-spool.sqlite"), firstDelivery]);
    const reopened = new CaptureSpool(join(root, "capture-spool.sqlite"));
    try {
      const receipts = reopened.receiptReport().receipts;
      assert.equal(reopened.status().admitted, 2);
      const retry = receipts.find(receipt => receipt.disposition === "delivery-retry")!;
      assert.equal(retry.operationKey, first!.operationKey);
      assert.equal(retry.buildRole, "writer");
      assert.equal(retry.buildId, manifestB.buildId);
      const expected = new Map([[first!.operationKey, manifestA.buildId], [second!.operationKey, manifestB.buildId]]);
      assert.equal(receipts.filter(receipt => receipt.disposition === "accepted").every(receipt => expected.get(receipt.operationKey) === receipt.buildId), true);
      const swapped = [{ ...first!, buildId: manifestB.buildId }, { ...second!, buildId: manifestA.buildId }];
      assert.equal(swapped.every(receipt => expected.get(receipt.operationKey) === receipt.buildId), false);
      assert.equal(JSON.stringify(receipts).includes(inputs[0]!), false);
    } finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(installedA, { recursive: true, force: true }); rmSync(installedB, { recursive: true, force: true }); }
});

test("ABI-A3 interrupted publication recovers the previous generation before replay", () => {
  const root = fixture();
  try {
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const path = join(root, "plan.json");
    writeFileSync(path, JSON.stringify(plan));
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", `import {readFileSync} from 'node:fs'; import {applyAlignmentPlan} from '${join(process.cwd(), "dist/src/installation/alignment.js")}'; applyAlignmentPlan(JSON.parse(readFileSync(process.argv[1],'utf8')), {afterPublication: n => {if(n===1) process.exit(17);}});`, path]));
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), true);
    assert.equal(applyAlignmentPlan(plan).status, "applied");
    assert.equal(applyAlignmentPlan(plan, { rollback: true }).status, "rolled-back");
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ABI-A2 repository-ID inspection reads registry without creating a database", () => {
  const root = fixture(); const data = fixture();
  try {
    const path = join(data, "experience.sqlite");
    let result = runCli(["installation", "inspect", "--repository-id", "repo-abi", "--data-dir", data, "--json"]);
    assert.equal(result.exitCode, 2);
    assert.equal(existsSync(path), false);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE repositories (repository_id TEXT, repository_root TEXT);");
    db.prepare("INSERT INTO repositories VALUES (?, ?)").run("repo-abi", root);
    db.close();
    const before = readFileSync(path);
    result = runCli(["installation", "inspect", "--repository-id", "repo-abi", "--data-dir", data, "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).repositoryId, "repo-abi");
    assert.equal(result.stdout.includes(root), false);
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test("ABI-A3 unsafe shell paths are rejected before writing a plan", () => {
  const root = fixture();
  const parent = fixture();
  const build = join(parent, "build-$UNSAFE");
  try {
    mkdirSync(build);
    artifact(build);
    writeFileSync(join(build, "build-manifest.json"), JSON.stringify(createBuildManifest(build)));
    assert.throws(() => createAlignmentPlan(root, join(build, "build-manifest.json")), /Unsafe|shell/);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(parent, { recursive: true, force: true }); }
});

test("ABI-A3 concurrent foreign configuration edit is preserved after wrapper publication", () => {
  const root = fixture();
  try {
    const config = join(root, ".codex/hooks.json");
    mkdirSync(join(root, ".codex")); writeFileSync(config, JSON.stringify({hooks:{}}));
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const foreign = JSON.stringify({hooks:{SessionStart:[{hooks:[{command:"concurrent-foreign"}]}]}});
    assert.throws(() => applyAlignmentPlan(plan, {afterPublication: count => {if(count === 1) writeFileSync(config, foreign);}}), /changed|edited/i);
    assert.equal(readFileSync(config, "utf8"), foreign);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("ABI-A3 alignment restores every required matcher without broadening foreign groups", () => {
  const root = fixture();
  try {
    installHooks({repositoryRoot:root,sources:["codex"],cliEntrypoint:join(process.cwd(),"dist/src/cli.js")});
    const path = join(root,".codex/hooks.json"); const config=JSON.parse(readFileSync(path,"utf8"));
    config.hooks.SessionStart[0].matcher="resume";
    config.hooks.PreToolUse[0].matcher="Read"; config.hooks.PostToolUse[0].matcher="Read";
    const foreign={matcher:"Read",hooks:[{type:"command",command:"foreign"}]}; config.hooks.PreToolUse.push(foreign);
    writeFileSync(path,JSON.stringify(config));
    const plan=createAlignmentPlan(root,join(process.cwd(),"build-manifest.json")); applyAlignmentPlan(plan);
    const updated=JSON.parse(readFileSync(path,"utf8")); const command=`"${join(root,".agents/hooks/ael-passive-capture.sh")}" codex`;
    assert.equal(managedEventSupported(updated.hooks.SessionStart,command,"startup"),true);
    assert.equal(managedEventSupported(updated.hooks.SessionStart,command,"resume"),true);
    assert.equal(managedEventSupported(updated.hooks.PreToolUse,command,"Bash"),true);
    assert.equal(managedEventSupported(updated.hooks.PostToolUse,command,"Bash"),true);
    assert.deepEqual(updated.hooks.PreToolUse.find((g:{hooks:{command:string}[]})=>g.hooks[0].command==="foreign"),foreign);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("ABI-A3 unknown previous writer is rejected before any publication or recovery", () => {
  const root=fixture(); const old=fixture();
  try {
    artifact(old); installHooks({repositoryRoot:root,sources:["codex"],cliEntrypoint:join(old,"dist/src/cli.js")});
    const wrapper=join(root,".agents/hooks/ael-passive-capture.sh"); const before=readFileSync(wrapper,"utf8");
    const plan=createAlignmentPlan(root,join(process.cwd(),"build-manifest.json"));
    assert.throws(()=>applyAlignmentPlan(plan,{afterPublication:count=>{if(count===1)throw new Error("injected");}}), /manifest|ENOENT|Rollback/);
    assert.equal(readFileSync(wrapper,"utf8"),before);
    assert.equal(existsSync(join(root,".agents/ael-installation",plan.planId+".json")),false);
  } finally {rmSync(root,{recursive:true,force:true});rmSync(old,{recursive:true,force:true});}
});

test("ABI-A4 nonexecutable installed wrapper cannot qualify",()=>{
  const root=fixture();
  try {
    installHooks({repositoryRoot:root,sources:["codex"],cliEntrypoint:join(process.cwd(),"dist/src/cli.js")});
    chmodSync(join(root,".agents/hooks/ael-passive-capture.sh"),0o644);
    const result=runCli(["installation","qualify","--repository",root,"--json"]);
    assert.equal(JSON.parse(result.stdout).status,"unqualified");
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("ABI-A3 interruption immediately after lock acquisition permits automatic retry", () => {
  const root = fixture();
  try {
    const configuration = join(root, ".codex/hooks.json");
    mkdirSync(join(root, ".codex"));
    const foreign = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "foreign-lock-fixture" }] }] } });
    writeFileSync(configuration, foreign);
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const path = join(root, "plan.json"); writeFileSync(path, JSON.stringify(plan));
    const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readFileSync} from 'node:fs'; import {applyAlignmentPlan} from '${join(process.cwd(), "dist/src/installation/alignment.js")}'; applyAlignmentPlan(JSON.parse(readFileSync(process.argv[1],'utf8')), {afterLockAcquired: () => process.exit(18)});`, path], { encoding: "utf8" });
    assert.equal(interrupted.status, 18, interrupted.stderr);
    assert.equal(readFileSync(configuration, "utf8"), foreign);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
    assert.equal(existsSync(join(root, ".agents/ael-installation", plan.planId + ".json")), false);
    assert.equal(runCli(["installation", "apply", "--input", path, "--json"]).exitCode, 0);
    const updated = JSON.parse(readFileSync(configuration, "utf8"));
    assert.deepEqual(updated.hooks.SessionStart[0], JSON.parse(foreign).hooks.SessionStart[0]);
    assert.equal(runCli(["installation", "rollback", "--input", path, "--json"]).exitCode, 0);
    assert.equal(readFileSync(configuration, "utf8"), foreign);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ABI-A3 a live alignment lock rejects a contender and process death releases it", async () => {
  const root = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const path = join(root, "plan.json"); writeFileSync(path, JSON.stringify(plan));
    child = spawn(process.execPath, ["--input-type=module", "-e", `import {readFileSync} from 'node:fs'; import {applyAlignmentPlan} from '${join(process.cwd(), "dist/src/installation/alignment.js")}'; applyAlignmentPlan(JSON.parse(readFileSync(process.argv[1],'utf8')), {afterLockAcquired: () => {process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);}});`, path], { stdio: ["ignore", "pipe", "pipe"] });
    const ready = await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => {throw new Error("Publisher exited before acquiring its lock");})]);
    assert.equal(String(ready[0]).trim(), "locked");
    assert.throws(() => applyAlignmentPlan(plan), /already running/);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; child = undefined;
    assert.equal(applyAlignmentPlan(plan).status, "applied");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("ABI-A3 ownerless legacy lock content is preserved and refuses automatic takeover", () => {
  const root = fixture();
  try {
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const legacy = join(root, ".agents/ael-installation/lock");
    mkdirSync(legacy, { recursive: true });
    assert.throws(() => applyAlignmentPlan(plan), /legacy alignment lock/);
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ABI-A3 dead verified legacy owner is recovered under the new mutex", () => {
  const root = fixture();
  try {
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const legacy = join(root, ".agents/ael-installation/lock");
    mkdirSync(legacy, { recursive: true });
    const completed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(completed.status, 0);
    assert.ok(completed.pid);
    writeFileSync(join(legacy, "owner.json"), JSON.stringify({ pid: completed.pid, planId: plan.planId }));
    assert.equal(applyAlignmentPlan(plan).status, "applied");
    assert.equal(existsSync(legacy), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ABI-A3 foreign SQLite lock file is preserved before publication", () => {
  const root = fixture();
  try {
    const plan = createAlignmentPlan(root, join(process.cwd(), "build-manifest.json"));
    const directory = join(root, ".agents/ael-installation"); mkdirSync(directory, { recursive: true });
    const path = join(directory, "lock.sqlite");
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE foreign_records (value TEXT); INSERT INTO foreign_records VALUES ('keep');"); foreign.close();
    chmodSync(path, 0o640);
    const bytes = readFileSync(path);
    assert.throws(() => applyAlignmentPlan(plan), /Unrecognized alignment lock/);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(existsSync(join(root, ".agents/hooks/ael-passive-capture.sh")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
