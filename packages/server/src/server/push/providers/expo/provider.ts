import type pino from "pino";

import type {
  PushDeliveryResult,
  PushPayload,
  PushProvider,
  PushProviderFactoryOptions,
} from "../../push-provider.js";

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const DEFAULT_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

export const EXPO_PROVIDER_ID = "expo";

interface ExpoProviderConfig {
  /** Overridable so a test or a proxy deployment does not have to patch fetch. */
  baseUrl?: string;
}

function readConfig(config: unknown): ExpoProviderConfig {
  if (!config || typeof config !== "object") return {};
  const candidate = config as { baseUrl?: unknown };
  return typeof candidate.baseUrl === "string" && candidate.baseUrl.length > 0
    ? { baseUrl: candidate.baseUrl }
    : {};
}

/**
 * Expo push delivery.
 *
 * Behaviour is unchanged from the previous PushService: same endpoint, same
 * batch size, same ticket handling. The only difference is that dead tokens are
 * returned instead of revoked through a callback, so the store decides when a
 * revocation is durable.
 */
export class ExpoPushProvider implements PushProvider {
  readonly providerId = EXPO_PROVIDER_ID;

  private readonly logger: pino.Logger;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PushProviderFactoryOptions) {
    this.logger = options.logger.child({ component: "push-provider", provider: EXPO_PROVIDER_ID });
    this.baseUrl = readConfig(options.config).baseUrl ?? DEFAULT_EXPO_PUSH_URL;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async deliver(tokens: readonly string[], payload: PushPayload): Promise<PushDeliveryResult> {
    if (tokens.length === 0) {
      return {};
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    const revoked = await Promise.all(batches.map((batch) => this.sendBatch(batch)));
    return { revokedTokens: revoked.flat() };
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<string[]> {
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return [];
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      return this.collectRevoked(messages, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
      return [];
    }
  }

  private collectRevoked(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): string[] {
    const revoked: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];
      if (!ticket || !message || ticket.status !== "error") continue;

      this.logger.error(
        { token: message.to, message: ticket.message, details: ticket.details },
        "Push failed for token",
      );

      if (
        ticket.details?.error === "DeviceNotRegistered" ||
        ticket.details?.error === "InvalidCredentials"
      ) {
        revoked.push(message.to);
      }
    }
    return revoked;
  }
}
