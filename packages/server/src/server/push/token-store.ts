import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import type { PushSubscription } from "./push-provider.js";
import { EXPO_PROVIDER_ID } from "./providers/expo/provider.js";

interface StoredSubscription {
  expiresAt: number;
  /** Provider-defined; opaque here. Absent for providers that need none. */
  metadata?: Record<string, string>;
}

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
  /** provider id -> token -> stored subscription. */
  private subscriptions = new Map<string, Map<string, StoredSubscription>>();
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

  /**
   * Registers or extends a lease.
   *
   * `metadata` is supplied at registration; a heartbeat renewal omits it and
   * must not erase what is already stored.
   */
  renewToken(provider: string, token: string, metadata?: Record<string, string>): void {
    const normalized = token.trim();
    if (!normalized || !provider) return;
    const now = this.now();
    const existing = this.subscriptions.get(provider)?.get(normalized);
    const metadataUnchanged = metadata === undefined || sameMetadata(existing?.metadata, metadata);
    if (
      existing !== undefined &&
      metadataUnchanged &&
      existing.expiresAt - now > this.leaseMs / 2
    ) {
      return;
    }
    const next = this.clone();
    const forProvider = next.get(provider) ?? new Map<string, StoredSubscription>();
    const nextMetadata = metadata ?? existing?.metadata;
    forProvider.set(normalized, {
      expiresAt: now + this.leaseMs,
      ...(nextMetadata ? { metadata: nextMetadata } : {}),
    });
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

  /** Live subscriptions grouped by provider, pruning anything expired. */
  getActiveSubscriptionsByProvider(): Map<string, PushSubscription[]> {
    const now = this.now();
    const active = new Map<string, Map<string, StoredSubscription>>();
    let pruned = false;

    for (const [provider, tokens] of this.subscriptions) {
      const live = new Map<string, StoredSubscription>();
      for (const [token, stored] of tokens) {
        if (stored.expiresAt > now) live.set(token, stored);
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

    const result = new Map<string, PushSubscription[]>();
    for (const [provider, tokens] of active) {
      result.set(
        provider,
        Array.from(tokens, ([token, stored]) => ({
          provider,
          token,
          ...(stored.metadata ? { metadata: stored.metadata } : {}),
        })),
      );
    }
    return result;
  }

  private total(): number {
    let count = 0;
    for (const tokens of this.subscriptions.values()) count += tokens.size;
    return count;
  }

  private clone(): Map<string, Map<string, StoredSubscription>> {
    const next = new Map<string, Map<string, StoredSubscription>>();
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
      const loaded = new Map<string, Map<string, StoredSubscription>>();

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
        const forExpo = migrated.get(EXPO_PROVIDER_ID) ?? new Map<string, StoredSubscription>();
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) forExpo.set(normalized, { expiresAt });
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

  private persist(
    subscriptions: ReadonlyMap<string, ReadonlyMap<string, StoredSubscription>>,
  ): void {
    try {
      const providers: Record<string, SerialisedSubscription[]> = {};
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

interface SerialisedSubscription {
  token: string;
  expiresAt: string;
  metadata?: Record<string, string>;
}

function readSubscriptionList(value: unknown): Map<string, StoredSubscription> {
  const loaded = new Map<string, StoredSubscription>();
  if (!Array.isArray(value)) return loaded;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { token?: unknown; expiresAt?: unknown; metadata?: unknown };
    if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string") continue;
    const token = candidate.token.trim();
    const expiresAt = Date.parse(candidate.expiresAt);
    if (!token || !Number.isFinite(expiresAt)) continue;
    const metadata = readMetadata(candidate.metadata);
    loaded.set(token, { expiresAt, ...(metadata ? { metadata } : {}) });
  }
  return loaded;
}

/** Strings only — anything else is a provider bug, not something to persist. */
function readMetadata(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sameMetadata(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function serialiseList(tokens: ReadonlyMap<string, StoredSubscription>): SerialisedSubscription[] {
  return Array.from(tokens, ([token, stored]) => ({
    token,
    expiresAt: new Date(stored.expiresAt).toISOString(),
    ...(stored.metadata ? { metadata: stored.metadata } : {}),
  }));
}
