import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./helpers.js";
import { jobsForDay, resolveWatchJobIds, describeJob } from "../src/lib/dpe-cli.js";

test("jobsForDay retrouve les jobs couvrant une date", () => {
  const { repositories, close } = createTestApp();
  try {
    const id = repositories.dpe.createJob({
      dateFrom: "2025-12-18",
      dateTo: "2025-12-18",
      daysTotal: 1,
    });
    repositories.dpe.updateJob(id, { status: "running" });
    const matches = jobsForDay(repositories, "2025-12-18");
    assert.ok(matches.some((j) => j.id === id));
    const resolved = resolveWatchJobIds(repositories, { day: "2025-12-18" });
    assert.deepEqual(resolved.jobIds, [id]);
    const info = describeJob(repositories.dpe.getJob(id));
    assert.equal(info.rawStatus, "running");
    assert.match(info.progress, /préparation/);
  } finally {
    close();
  }
});
