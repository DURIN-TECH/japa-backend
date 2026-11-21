// ============================================
// A small per-IP rate limit for public, unauthenticated routes (issue #391)
// ============================================
//
// The pay-link routes (`POST /consultations/public/pay-links/lookup` and
// `/checkout`) need no
// sign-in. A 256-bit token cannot be guessed, but a caller hammering the
// routes would still cost Firestore reads (and, on the checkout route, a
// Paystack lookup). This caps each client IP at a fixed number of requests
// per window.
//
// IN MEMORY, PER INSTANCE, ON PURPOSE: no Firestore write per request (a
// Firestore-backed counter would let an attacker turn requests into writes),
// bounded memory (at most MAX_TRACKED_KEYS keys; the oldest window is evicted
// first). Each Cloud Functions instance keeps its own counts, so the global
// cap is "limit x instances": a brake, not a wall. A shared limiter for all
// public routes is out of scope (#391 "Out of scope"); this is the one
// protection these two routes add on top of the unguessable token.

import { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/response";

/** Most keys tracked at once; past it the oldest entry is dropped. */
const MAX_TRACKED_KEYS = 10_000;

/** One key's count in its current window. */
interface Bucket {
  /** Requests seen in this window. */
  count: number;
  /** When this window ends (epoch ms). */
  resetAt: number;
}

/** Options for one limiter. */
export interface RateLimitOptions {
  /** Requests allowed per window per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Clock (tests replace it). */
  now?: () => number;
}

/** A limiter middleware, plus `reset()` for tests. */
export type RateLimiter = ((req: Request, res: Response, next: NextFunction) => void) & { reset: () => void };

/**
 * Build a fixed-window, per-IP limiter. Over the limit it answers 429
 * RATE_LIMITED with a `Retry-After` header and calls nothing else.
 */
export function createPublicRateLimit(opts: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const now = opts.now ?? (() => Date.now());

  const limiter = ((req: Request, res: Response, next: NextFunction) => {
    // `req.ip` honours the app's trust-proxy setting; never a raw header.
    const key = req.ip || "unknown";
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket || at >= bucket.resetAt) {
      // A new window. Re-inserting moves the key to the end (Map keeps
      // insertion order), so the first key is always the oldest window.
      buckets.delete(key);
      bucket = { count: 0, resetAt: at + opts.windowMs };
      buckets.set(key, bucket);
      if (buckets.size > MAX_TRACKED_KEYS) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    }
    bucket.count += 1;
    if (bucket.count > opts.limit) {
      res.setHeader?.("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - at) / 1000))));
      sendError(res, "RATE_LIMITED", "Too many requests. Please try again in a minute.", 429);
      return;
    }
    next();
  }) as RateLimiter;
  limiter.reset = () => buckets.clear();
  return limiter;
}

/**
 * The limiter of the pay-link routes: 30 requests per minute per IP, both
 * routes together. A real guest makes a handful (load the page, press Pay,
 * maybe retry).
 */
export const payLinkRateLimit = createPublicRateLimit({ limit: 30, windowMs: 60_000 });
