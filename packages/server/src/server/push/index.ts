import type pino from "pino";

import { PUSH_PROVIDERS } from "./manifest.js";
import type { PushPayload, PushProvider } from "./push-provider.js";
import { EXPO_PROVIDER_ID } from "./providers/expo/provider.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload, PushProvider } from "./push-provider.js";

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

/**
 * The channel a token belongs to when a client does not name one.
 *
 * COMPAT(pushProviders): every token registered before the provider field
 * existed was an Expo token, because Expo was the only channel.
 */
export const DEFAULT_PUSH_PROVIDER = EXPO_PROVIDER_ID;

export interface PushNotifications {
  renew(token: string, provider?: string): void;
  revoke(token: string, provider?: string): void;
  send(payload: PushPayload): Promise<void>;
  /** Provider ids this daemon can actually deliver through, for capability gating. */
  listDeliverableProviders(): string[];
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  /** Per-provider configuration, keyed by provider id. */
  providerConfig?: Record<string, unknown>;
  /**
   * Replaces delivery entirely, for tests. Bypasses every provider, so it also
   * bypasses provider-reported revocations.
   */
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);

  const providers = new Map<string, PushProvider>();
  for (const entry of PUSH_PROVIDERS) {
    const provider = entry.create({
      logger: options.logger,
      config: options.providerConfig?.[entry.providerId],
    });
    // A null provider means this host holds no credentials for that channel.
    if (provider) providers.set(entry.providerId, provider);
  }

  return {
    renew(token, provider = EXPO_PROVIDER_ID) {
      store.renewToken(provider, token);
    },
    revoke(token, provider = EXPO_PROVIDER_ID) {
      store.revokeToken(provider, token);
    },
    listDeliverableProviders() {
      return Array.from(providers.keys());
    },
    async send(payload) {
      const byProvider = store.getActiveTokensByProvider();
      const tokenCount = Array.from(byProvider.values()).reduce(
        (total, tokens) => total + tokens.length,
        0,
      );
      options.logger.info({ tokenCount }, "Sending push notification");
      if (tokenCount === 0) return;

      if (options.deliver) {
        await options.deliver(Array.from(byProvider.values()).flat(), payload);
        return;
      }

      // One failing channel must not stop the others, so each is awaited
      // independently and its revocations applied on its own.
      await Promise.all(
        Array.from(byProvider, async ([providerId, tokens]) => {
          const provider = providers.get(providerId);
          if (!provider) {
            options.logger.warn(
              { provider: providerId, tokenCount: tokens.length },
              "No provider registered for stored tokens",
            );
            return;
          }
          const result = await provider.deliver(tokens, payload);
          for (const token of result.revokedTokens ?? []) {
            store.revokeToken(providerId, token);
          }
        }),
      );
    },
  };
}
