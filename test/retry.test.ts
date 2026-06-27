import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RETRY_POLICY,
  backoffMs,
  classifyFailure,
  decideRetry,
  type RetryPolicy,
} from "../src/runner/retry.js";

const policy: RetryPolicy = {
  maxAttempts: 4,
  maxNonRetryableAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitter: 0, // deterministic for assertions
};

// --- classifyFailure: the retryable / non-retryable split --------------------

test("transient signals classify as retryable", () => {
  assert.equal(classifyFailure({ limitHit: true }), "retryable");
  assert.equal(classifyFailure({ sessionError: true }), "retryable");
  assert.equal(classifyFailure({ landFailed: true }), "retryable");
  assert.equal(classifyFailure({ streamStalled: true }), "retryable");
});

test("a clean agent failure (no transient signal) is non-retryable", () => {
  assert.equal(classifyFailure({}), "non-retryable");
  assert.equal(classifyFailure({ limitHit: false, sessionError: false, landFailed: false }), "non-retryable");
});

// --- backoffMs: exponential growth, cap, and jitter --------------------------

test("backoff doubles per attempt and is capped at maxDelayMs", () => {
  assert.equal(backoffMs(1, policy), 1_000);
  assert.equal(backoffMs(2, policy), 2_000);
  assert.equal(backoffMs(3, policy), 4_000);
  assert.equal(backoffMs(4, policy), 8_000);
  assert.equal(backoffMs(5, policy), 10_000, "capped");
  assert.equal(backoffMs(99, policy), 10_000, "stays capped");
});

test("jitter adds up to jitter× of the step, never below the step", () => {
  const jittered: RetryPolicy = { ...policy, jitter: 0.5 };
  assert.equal(backoffMs(1, jittered, () => 0), 1_000, "no jitter at rand=0");
  assert.equal(backoffMs(1, jittered, () => 1), 1_500, "full jitter at rand=1");
  const mid = backoffMs(2, jittered, () => 0.5);
  assert.ok(mid >= 2_000 && mid <= 3_000, `within band, got ${mid}`);
});

// --- decideRetry: cap enforcement + the kind-dependent policy ----------------

test("retryable failures retry with backoff until the cap, then dead-letter", () => {
  for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
    const d = decideRetry({ kind: "retryable", attempts: attempt, policy });
    assert.equal(d.action, "retry", `attempt ${attempt} should retry`);
    if (d.action === "retry") assert.ok(d.delayMs > 0);
  }
  const giveUp = decideRetry({ kind: "retryable", attempts: policy.maxAttempts, policy });
  assert.equal(giveUp.action, "dead-letter");
});

test("non-retryable failures hit a lower cap", () => {
  assert.equal(decideRetry({ kind: "non-retryable", attempts: 1, policy }).action, "retry");
  assert.equal(decideRetry({ kind: "non-retryable", attempts: 2, policy }).action, "dead-letter");
});

test("a non-retryable failure dead-letters sooner than a retryable one for the same attempt", () => {
  const attempts = policy.maxNonRetryableAttempts;
  assert.equal(decideRetry({ kind: "non-retryable", attempts, policy }).action, "dead-letter");
  assert.equal(decideRetry({ kind: "retryable", attempts, policy }).action, "retry");
});

test("the default policy is sane: retryable cap > non-retryable cap, backoff grows", () => {
  assert.ok(DEFAULT_RETRY_POLICY.maxAttempts > DEFAULT_RETRY_POLICY.maxNonRetryableAttempts);
  assert.ok(DEFAULT_RETRY_POLICY.baseDelayMs > 0);
  assert.ok(DEFAULT_RETRY_POLICY.maxDelayMs >= DEFAULT_RETRY_POLICY.baseDelayMs);
});
