import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import { EXPO_PROVIDER_ID } from "./providers/expo/provider.js";

/**
 * Store for push tokens, keyed by provider.
 *
 * Tokens are persisted so pushes still work after daemon restarts.
 *
 * On-disk layout keeps Expo tokens exactly where they were and puts every other
 * provider under a separate `providers` key:
 *
 *   { "subscriptions": [ … expo … ], "providers": { "huawei": [ … ] } }
 *
 * That separation is deliberate. An older daemon reading the same PASEO_HOME —
 * a rollback, a downgrade, a second install — understands `subscriptions` and
 * ignores `providers` entirely, so it can never POST a non-Expo token to Expo
 * and never revoke one off the back of an Expo ticket error. A single flat list
 * with a `provider` field would not survive that: the field is dropped on read
 * and erased on the next write.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  /** provider id -> token -> expiry (epoch ms). */
  private subscriptions = new Map<string, Map<string, number>>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number,
    leaseMs: number,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
    this.loadFromDisk();
  }

  renewToken(provider: string, token: string): void {
    const normalized = token.trim();
    if (!normalized || !provider) return;
    const now = this.now();
    const currentExpiry = this.subscriptions.get(provider)?.get(normalized);
    if (currentExpiry !== undefined && currentExpiry - now > this.leaseMs / 2) return;
    const next = this.clone();
    const forProvider = next.get(provider) ?? new Map<string, number>();
    forProvider.set(normalized, now + this.leaseMs);
    next.set(provider, forProvider);
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ provider, total: this.total() }, "Renewed token");
  }

  revokeToken(provider: string, token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (!this.subscriptions.get(provider)?.has(normalized)) return;
    const next = this.clone();
    const forProvider = next.get(provider);
    forProvider?.delete(normalized);
    if (forProvider && forProvider.size === 0) next.delete(provider);
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ provider, total: this.total() }, "Revoked token");
  }

  /** Live tokens grouped by provider, pruning anything expired. */
  getActiveTokensByProvider(): Map<string, string[]> {
    const now = this.now();
    const active = new Map<string, Map<string, number>>();
    let pruned = false;

    for (const [provider, tokens] of this.subscriptions) {
      const live = new Map<string, number>();
      for (const [token, expiresAt] of tokens) {
        if (expiresAt > now) live.set(token, expiresAt);
        else pruned = true;
      }
      if (live.size > 0) active.set(provider, live);
      else if (tokens.size > 0) pruned = true;
    }

    if (pruned) {
      try {
        this.persist(active);
        this.subscriptions = active;
      } catch {
        // Keep the previous state so a later send retries pruning. Expired
        // tokens are still excluded from this delivery.
      }
    }

    const result = new Map<string, string[]>();
    for (const [provider, tokens] of active) {
      result.set(provider, Array.from(tokens.keys()));
    }
    return result;
  }

  private total(): number {
    let count = 0;
    for (const tokens of this.subscriptions.values()) count += tokens.size;
    return count;
  }

  private clone(): Map<string, Map<string, number>> {
    const next = new Map<string, Map<string, number>>();
    for (const [provider, tokens] of this.subscriptions) {
      next.set(provider, new Map(tokens));
    }
    return next;
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as {
        subscriptions?: unknown;
        tokens?: unknown;
        providers?: unknown;
      };
      const loaded = new Map<string, Map<string, number>>();

      // COMPAT(pushProviders): `subscriptions` predates provider ids and can
      // only ever have held Expo tokens. Remove after 2027-02-01, once no
      // deployment can still be writing that shape.
      const expo = readSubscriptionList(parsed.subscriptions);
      if (expo.size > 0) loaded.set(EXPO_PROVIDER_ID, expo);

      if (parsed.providers && typeof parsed.providers === "object") {
        for (const [provider, value] of Object.entries(
          parsed.providers as Record<string, unknown>,
        )) {
          if (provider === EXPO_PROVIDER_ID) continue;
          const tokens = readSubscriptionList(value);
          if (tokens.size > 0) loaded.set(provider, tokens);
        }
      }
      this.subscriptions = loaded;

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      if (legacyTokens.length > 0) {
        const migrated = this.clone();
        const forExpo = migrated.get(EXPO_PROVIDER_ID) ?? new Map<string, number>();
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) forExpo.set(normalized, expiresAt);
        }
        migrated.set(EXPO_PROVIDER_ID, forExpo);
        this.persist(migrated);
        this.subscriptions = migrated;
      }
      this.logger.info({ total: this.total() }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(subscriptions: ReadonlyMap<string, ReadonlyMap<string, number>>): void {
    try {
      const providers: Record<string, { token: string; expiresAt: string }[]> = {};
      for (const [provider, tokens] of subscriptions) {
        if (provider === EXPO_PROVIDER_ID) continue;
        providers[provider] = serialiseList(tokens);
      }

      const payload =
        JSON.stringify(
          {
            subscriptions: serialiseList(subscriptions.get(EXPO_PROVIDER_ID) ?? new Map()),
            ...(Object.keys(providers).length > 0 ? { providers } : {}),
          },
          null,
          2,
        ) + "\n";
      this.write(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
      throw err;
    }
  }
}

function readSubscriptionList(value: unknown): Map<string, number> {
  const loaded = new Map<string, number>();
  if (!Array.isArray(value)) return loaded;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { token?: unknown; expiresAt?: unknown };
    if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string") continue;
    const token = candidate.token.trim();
    const expiresAt = Date.parse(candidate.expiresAt);
    if (token && Number.isFinite(expiresAt)) loaded.set(token, expiresAt);
  }
  return loaded;
}

function serialiseList(
  tokens: ReadonlyMap<string, number>,
): { token: string; expiresAt: string }[] {
  return Array.from(tokens, ([token, expiresAt]) => ({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
  }));
}
