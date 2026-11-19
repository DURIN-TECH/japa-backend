// ============================================
// Issue #267 — reliable push delivery (notifyUser)
// ============================================
//
// No emulator, no network: `messaging.sendEachForMulticast` is mocked and the
// `users` / `notifications` collection refs are replaced with tiny stubs.

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { FieldValue } from "firebase-admin/firestore";
import { collections, messaging } from "../../src/utils/firebase";
import { notificationService } from "../../src/services/notification.service";

/* eslint-disable @typescript-eslint/no-explicit-any */
const col: any = collections;

const UID = "u1";
let userData: Record<string, unknown>;
let userUpdates: Record<string, unknown>[];
let notificationsWritten: unknown[];
let unreadCount: number;
let sendMock: any;
let originalUsers: unknown;
let originalNotifications: unknown;
let updateImpl: (data: Record<string, unknown>) => Promise<void>;

/** Build per-token FCM responses from a list of error codes (null = success). */
const responsesFor = (codes: (string | null)[]) => ({
  successCount: codes.filter((c) => c === null).length,
  failureCount: codes.filter((c) => c !== null).length,
  responses: codes.map((c) =>
    c === null ? { success: true } : { success: false, error: { code: c } }
  ),
});

beforeEach(() => {
  userData = { email: "delivered+pushy@resend.dev", fcmTokens: ["t1"] };
  userUpdates = [];
  notificationsWritten = [];
  unreadCount = 4;
  updateImpl = async (data) => {
    userUpdates.push(data);
  };
  originalUsers = col.users;
  originalNotifications = col.notifications;
  col.users = {
    doc: () => ({
      get: async () => ({ exists: true, data: () => userData }),
      update: (d: Record<string, unknown>) => updateImpl(d),
    }),
  };
  col.notifications = {
    doc: () => ({
      id: "n1",
      set: async (n: unknown) => {
        notificationsWritten.push(n);
      },
    }),
    where: () => ({
      where: () => ({
        count: () => ({ get: async () => ({ data: () => ({ count: unreadCount }) }) }),
      }),
    }),
  };
  sendMock = mock.method(messaging, "sendEachForMulticast", async (m: any) =>
    responsesFor(m.tokens.map(() => null))
  );
  mock.method(console, "error", () => {});
});

afterEach(() => {
  mock.restoreAll();
  col.users = originalUsers;
  col.notifications = originalNotifications;
});

const base = {
  userId: UID,
  type: "application_update" as const,
  title: "Hello",
  body: "World",
  relatedEntityType: "application" as const,
  relatedEntityId: "app1",
  data: { extra: "x" },
};

describe("notifyUser push payload (#267)", () => {
  it("in_app + push: sends sound, channel, priority and the unread badge", async () => {
    await notificationService.notifyUser({ ...base, channels: ["in_app", "push"] });

    assert.equal(sendMock.mock.callCount(), 1);
    assert.deepEqual(sendMock.mock.calls[0].arguments[0], {
      tokens: ["t1"],
      notification: { title: "Hello", body: "World" },
      data: {
        type: "application_update",
        relatedEntityId: "app1",
        relatedEntityType: "application",
        extra: "x",
      },
      android: {
        priority: "high",
        notification: { channelId: "default", sound: "default" },
      },
      apns: { payload: { aps: { sound: "default", badge: 4 } } },
    });
    assert.equal(notificationsWritten.length, 1);
  });

  it("push-only: omits the badge rather than guessing", async () => {
    await notificationService.notifyUser({ ...base, channels: ["push"] });

    const msg = sendMock.mock.calls[0].arguments[0];
    assert.deepEqual(msg.apns, { payload: { aps: { sound: "default" } } });
    assert.ok(!("badge" in msg.apns.payload.aps));
    assert.deepEqual(msg.android, {
      priority: "high",
      notification: { channelId: "default", sound: "default" },
    });
    assert.equal(notificationsWritten.length, 0);
  });
});

describe("notifyUser dead-token pruning (#267)", () => {
  it("prunes not-registered and invalid tokens atomically, keeps healthy and transient ones", async () => {
    userData.fcmTokens = ["ok", "gone", "bad", "busy"];
    sendMock.mock.mockImplementation(async () =>
      responsesFor([
        null,
        "messaging/registration-token-not-registered",
        "messaging/invalid-registration-token",
        "messaging/server-unavailable",
      ])
    );

    await notificationService.notifyUser({ ...base, channels: ["push"] });

    assert.equal(userUpdates.length, 1);
    const expected = FieldValue.arrayRemove("gone", "bad");
    assert.ok(
      (userUpdates[0].fcmTokens as FieldValue).isEqual(expected),
      "update uses arrayRemove of exactly the two dead tokens"
    );
  });

  it("does not write when every failure is transient", async () => {
    userData.fcmTokens = ["a", "b"];
    sendMock.mock.mockImplementation(async () =>
      responsesFor(["messaging/quota-exceeded", "messaging/internal-error"])
    );
    await notificationService.notifyUser({ ...base, channels: ["push"] });
    assert.equal(userUpdates.length, 0);
  });

  it("a sole dead token is removed (arrayRemove of that token)", async () => {
    userData.fcmTokens = ["only"];
    sendMock.mock.mockImplementation(async () =>
      responsesFor(["messaging/registration-token-not-registered"])
    );
    await notificationService.notifyUser({ ...base, channels: ["push"] });
    assert.equal(userUpdates.length, 1);
    assert.ok(
      (userUpdates[0].fcmTokens as FieldValue).isEqual(FieldValue.arrayRemove("only"))
    );
  });

  it("a pruning failure is logged and never throws; in_app still delivered", async () => {
    sendMock.mock.mockImplementation(async () =>
      responsesFor(["messaging/registration-token-not-registered"])
    );
    updateImpl = async () => {
      throw new Error("firestore down");
    };

    await assert.doesNotReject(
      notificationService.notifyUser({ ...base, channels: ["in_app", "push"] })
    );
    assert.equal(notificationsWritten.length, 1);
  });
});
