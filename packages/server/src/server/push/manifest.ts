import { ExpoPushProvider, EXPO_PROVIDER_ID } from "./providers/expo/provider.js";
import type { PushProviderManifestEntry } from "./push-provider.js";

/**
 * Every push channel the daemon knows about.
 *
 * Adding one is a new directory under providers/ plus one entry here. Nothing
 * else in the push module should need to know a provider exists.
 */
export const PUSH_PROVIDERS: readonly PushProviderManifestEntry[] = [
  {
    providerId: EXPO_PROVIDER_ID,
    // Always available: Expo needs no daemon-side credentials.
    create: (options) => new ExpoPushProvider(options),
  },
];
