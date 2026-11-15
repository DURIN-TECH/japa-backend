// ============================================
// Unit tests — upload size helpers (issue #310)
// ============================================
//
// The pure parts of the registration size check: the megabytes stored on a
// document and the refusal's message. The check itself (real size from Cloud
// Storage, 413, object deleted, no record) needs a real bucket and is covered
// on the Storage emulator by test/emulator/document-size.emu.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// First, on purpose: document.service builds its Firestore / Storage handles at
// import time, so the Admin app must exist before it loads (no call is made).
import "../../src/utils/firebase";
import { FileTooLargeError, megabytesFromBytes } from "../../src/services/document.service";
import { MODEL_IMAGE_MAX_BYTES } from "../../src/services/ai/ai-settings";

const MB = 1024 * 1024;

describe("megabytesFromBytes", () => {
  test("real megabytes to three decimals", () => {
    assert.equal(megabytesFromBytes(10 * MB), 10);
    assert.equal(megabytesFromBytes(2.5 * MB), 2.5);
    assert.equal(megabytesFromBytes(21 * MB), 21, "a 21 MB object can no longer be stored as 0.001 MB");
    assert.equal(megabytesFromBytes(1_234_567), 1.177);
  });

  test("a tiny file is never stored as 0, and an empty one is 0", () => {
    assert.equal(megabytesFromBytes(10), 0.001);
    assert.equal(megabytesFromBytes(0), 0);
  });
});

describe("FileTooLargeError", () => {
  test("the message is the plain line the app shows, naming the limit that applied", () => {
    const pdf = new FileTooLargeError(10 * MB, 21 * MB, false);
    assert.equal(pdf.message, "This file is larger than 10 MB. Upload a smaller copy, for example a scan at a lower resolution.");
    assert.deepEqual([pdf.maxBytes, pdf.sizeBytes, pdf.isImage], [10 * MB, 21 * MB, false]);

    const image = new FileTooLargeError(MODEL_IMAGE_MAX_BYTES, 8 * MB, true);
    assert.equal(image.message, "This file is larger than 7 MB. Upload a smaller copy, for example a scan at a lower resolution.");
  });
});
