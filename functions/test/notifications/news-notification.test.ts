// ============================================
// Issue #267 — visa-news pushes go through notifyUser
// ============================================

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { collections } from "../../src/utils/firebase";
import { notificationService } from "../../src/services/notification.service";
import { newsNotificationService } from "../../src/services/news-notification.service";

/* eslint-disable @typescript-eslint/no-explicit-any */
const col: any = collections;

let originals: Record<string, unknown>;
let recentCounts: Record<string, number>;
let notifyMock: any;

const sub = (userId: string, importanceThreshold = "normal") => ({
  userId,
  countryCodes: ["GB"],
  pushEnabled: true,
  importanceThreshold,
});

const article: any = {
  id: "art1",
  countryCodes: ["GB", "CA"],
  importance: "high",
  summary: "S".repeat(300),
};

beforeEach(() => {
  originals = { s: col.newsSubscriptions, n: col.notifications };
  recentCounts = {};
  const subs = [sub("u1"), sub("u2"), sub("u3", "breaking")];
  col.newsSubscriptions = {
    where: (field: string) => ({
      where: () => ({
        get: async () => ({
          // country queries return the subscribers; the "subscribed to all" query none
          docs: field === "countryCodes" ? subs.map((s) => ({ data: () => s })) : [],
        }),
      }),
    }),
  };
  // Rate-limit query: where(userId).where(type).where(createdAt).count().get()
  col.notifications = {
    where: (_f: string, _o: string, uid: string) => ({
      where: () => ({
        where: () => ({
          count: () => ({ get: async () => ({ data: () => ({ count: recentCounts[uid] ?? 0 }) }) }),
        }),
      }),
    }),
  };
  notifyMock = mock.method(notificationService, "notifyUser", async () => {});
  mock.method(console, "error", () => {});
});

afterEach(() => {
  mock.restoreAll();
  col.newsSubscriptions = originals.s;
  col.notifications = originals.n;
});

describe("notifySubscribers (#267)", () => {
  it("delivers each eligible subscriber via notifyUser with the exact payload", async () => {
    const n = await newsNotificationService.notifySubscribers(article);

    // u3 wants breaking only, the article is "high" -> filtered out
    assert.equal(n, 2);
    assert.equal(notifyMock.mock.callCount(), 2);
    assert.deepEqual(notifyMock.mock.calls[0].arguments[0], {
      userId: "u1",
      type: "visa_news",
      title: "[Important] UK, Canada Visa News",
      body: "S".repeat(150),
      channels: ["in_app", "push"],
      relatedEntityType: "news_article",
      relatedEntityId: "art1",
      actionUrl: "/news/art1",
      data: { articleId: "art1", countryCodes: "GB,CA", importance: "high" },
    });
  });

  it("keeps the 3-per-24h rate limit", async () => {
    recentCounts = { u1: 3, u2: 2 };
    const n = await newsNotificationService.notifySubscribers(article);
    assert.equal(n, 1);
    assert.equal(notifyMock.mock.calls[0].arguments[0].userId, "u2");
  });

  it("a failing subscriber is logged, the loop continues, count excludes it", async () => {
    notifyMock.mock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const n = await newsNotificationService.notifySubscribers(article);
    assert.equal(n, 1);
    assert.equal(notifyMock.mock.callCount(), 2);
  });
});
