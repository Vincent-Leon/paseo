import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * One device's registration with one provider.
 *
 * `token` is the primary identifier and what the store keys on. `metadata`
 * exists because a token is not always a single opaque string: UnifiedPush
 * registers an endpoint URL plus the client's `p256dh` public key and `auth`
 * secret, since RFC 8291 encryption happens on the sending side. Expo and HMS
 * carry none.
 *
 * Contents are provider-defined; the store keeps them as opaque strings and only
 * the owning provider interprets them.
 */
export interface PushSubscription {
  readonly provider: string;
  readonly token: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A delivery channel for push notifications.
 *
 * Providers are stateless with respect to the token store: they are handed the
 * tokens to deliver to and report back which ones the upstream service says are
 * permanently gone. They never mutate the store themselves — see
 * {@link PushDeliveryResult.revokedTokens} for why.
 */
export interface PushProvider {
  /** Wire value, config key and manifest key. One name, no synonyms. */
  readonly providerId: string;

  /**
   * Delivers to every subscription.
   *
   * Must not throw: one provider failing has to leave the others unaffected.
   * Transport errors are the provider's own to log and swallow.
   */
  deliver(
    subscriptions: readonly PushSubscription[],
    payload: PushPayload,
  ): Promise<PushDeliveryResult>;
}

export interface PushDeliveryResult {
  /**
   * Tokens the upstream service reports as permanently dead.
   *
   * Returned rather than revoked directly because the store only considers a
   * revocation real once it is durable — `persist` throws on a write failure and
   * the caller keeps the previous state. A provider holding a revoke callback
   * cannot honour that, and would drop tokens that are still live on disk.
   *
   * Only permanent failures belong here. A timeout or a 500 is not one.
   * Identified by token, which is unique within a provider.
   */
  readonly revokedTokens?: readonly string[];
}

export interface PushProviderFactoryOptions {
  readonly logger: pino.Logger;
  /** The provider's own slice of persisted config; each provider validates its own. */
  readonly config: unknown;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export interface PushProviderManifestEntry {
  readonly providerId: string;
  /**
   * Builds the provider, or returns null when the daemon holds no credentials
   * for it. A null provider is not an error: it means this host cannot deliver
   * through that channel, which is what the client is told so it never
   * registers a token nobody can route.
   */
  create(options: PushProviderFactoryOptions): PushProvider | null;
}
