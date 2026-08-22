import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE } from "../private-files.js";
import { createPushNotifications } from "./index.js";
import { PushTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("PushTokenStore file permissions", () => {
  test("persists push tokens with private permissions", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
      });

      pushNotifications.renew("ExponentPushToken[test]");

      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing push token file permissions when loading", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[test]"] }));
      chmodSync(tokenPath, PERMISSIVE_FILE_MODE);

      const deliveries: string[][] = [];
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
        deliver: async (tokens) => deliveries.push(tokens),
      });
      await pushNotifications.send({ title: "Agent finished", body: "Done" });

      expect(deliveries).toEqual([["ExponentPushToken[test]"]]);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore persistence", () => {
  test("does not apply a revocation until the updated subscriptions are durable", () => {
    let rejectWrites = false;
    let persisted = "";
    const store = new PushTokenStore(
      createLogger(),
      path.join(tmpdir(), `missing-push-token-store-${process.pid}`, "push-tokens.json"),
      () => Date.parse("2026-08-10T00:00:00.000Z"),
      48 * 60 * 60 * 1000,
      (_filePath, payload) => {
        if (rejectWrites) throw new Error("disk full");
        persisted = String(payload);
      },
    );

    store.renewToken("expo", "ExponentPushToken[test]");
    rejectWrites = true;

    expect(() => store.revokeToken("expo", "ExponentPushToken[test]")).toThrow("disk full");
    expect(store.getActiveSubscriptionsByProvider().get("expo")).toEqual([
      { provider: "expo", token: "ExponentPushToken[test]" },
    ]);
    expect(JSON.parse(persisted)).toEqual({
      subscriptions: [
        {
          token: "ExponentPushToken[test]",
          expiresAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });

    rejectWrites = false;
    store.revokeToken("expo", "ExponentPushToken[test]");
    expect(store.getActiveSubscriptionsByProvider().size).toBe(0);
    expect(JSON.parse(persisted)).toEqual({ subscriptions: [] });
  });
});

describe("PushTokenStore providers", () => {
  function makeStore(onPersist: (payload: string) => void, filePath?: string) {
    return new PushTokenStore(
      createLogger(),
      filePath ?? path.join(tmpdir(), `push-provider-store-${process.pid}`, "push-tokens.json"),
      () => Date.parse("2026-08-10T00:00:00.000Z"),
      48 * 60 * 60 * 1000,
      (_filePath, payload) => onPersist(String(payload)),
    );
  }

  test("keeps providers in separate buckets", () => {
    let persisted = "";
    const store = makeStore((payload) => {
      persisted = payload;
    });

    store.renewToken("expo", "ExponentPushToken[a]");
    store.renewToken("huawei", "hms-token-b");

    const active = store.getActiveSubscriptionsByProvider();
    expect(active.get("expo")).toEqual([{ provider: "expo", token: "ExponentPushToken[a]" }]);
    expect(active.get("huawei")).toEqual([{ provider: "huawei", token: "hms-token-b" }]);

    // The layout is the compatibility contract: an older daemon reads only
    // `subscriptions`, so it must contain Expo tokens and nothing else.
    const parsed = JSON.parse(persisted) as {
      subscriptions: { token: string }[];
      providers: Record<string, { token: string }[]>;
    };
    expect(parsed.subscriptions.map((entry) => entry.token)).toEqual(["ExponentPushToken[a]"]);
    expect(parsed.providers.huawei.map((entry) => entry.token)).toEqual(["hms-token-b"]);
    expect(parsed.providers.expo).toBeUndefined();
  });

  test("revoking one provider leaves the other intact", () => {
    const store = makeStore(() => undefined);
    store.renewToken("expo", "ExponentPushToken[a]");
    store.renewToken("huawei", "hms-token-b");

    store.revokeToken("huawei", "hms-token-b");

    const active = store.getActiveSubscriptionsByProvider();
    expect(active.get("expo")).toEqual([{ provider: "expo", token: "ExponentPushToken[a]" }]);
    expect(active.has("huawei")).toBe(false);
  });

  test("reads a pre-provider file as Expo and round-trips a provider file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-providers-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      // Written by a daemon that predates provider ids.
      writeFileSync(
        tokenPath,
        JSON.stringify({
          subscriptions: [
            { token: "ExponentPushToken[legacy]", expiresAt: "2026-08-12T00:00:00.000Z" },
          ],
        }),
      );

      let persisted = "";
      const store = makeStore((payload) => {
        persisted = payload;
      }, tokenPath);
      expect(store.getActiveSubscriptionsByProvider().get("expo")).toEqual([
        { provider: "expo", token: "ExponentPushToken[legacy]" },
      ]);

      store.renewToken("huawei", "hms-token-c");
      writeFileSync(tokenPath, persisted);

      const reloaded = makeStore(() => undefined, tokenPath);
      const active = reloaded.getActiveSubscriptionsByProvider();
      expect(active.get("expo")).toEqual([
        { provider: "expo", token: "ExponentPushToken[legacy]" },
      ]);
      expect(active.get("huawei")).toEqual([{ provider: "huawei", token: "hms-token-c" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore provider metadata", () => {
  test("round-trips metadata and keeps it across a renewal that omits it", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-metadata-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      let now = Date.parse("2026-08-10T00:00:00.000Z");
      const store = new PushTokenStore(createLogger(), tokenPath, () => now, 48 * 60 * 60 * 1000);

      // UnifiedPush registers an endpoint plus the keys the sender encrypts with.
      store.renewToken("unifiedpush", "https://push.example/UP123", {
        p256dh: "BExampleKey",
        auth: "ExampleAuth",
      });

      const registered = store.getActiveSubscriptionsByProvider().get("unifiedpush");
      expect(registered).toEqual([
        {
          provider: "unifiedpush",
          token: "https://push.example/UP123",
          metadata: { p256dh: "BExampleKey", auth: "ExampleAuth" },
        },
      ]);

      // A heartbeat renewal carries no metadata and must not erase it.
      now += 25 * 60 * 60 * 1000;
      store.renewToken("unifiedpush", "https://push.example/UP123");
      expect(store.getActiveSubscriptionsByProvider().get("unifiedpush")?.[0]?.metadata).toEqual({
        p256dh: "BExampleKey",
        auth: "ExampleAuth",
      });

      // And it survives a reload from disk.
      const reloaded = new PushTokenStore(
        createLogger(),
        tokenPath,
        () => now,
        48 * 60 * 60 * 1000,
      );
      expect(reloaded.getActiveSubscriptionsByProvider().get("unifiedpush")?.[0]?.metadata).toEqual(
        {
          p256dh: "BExampleKey",
          auth: "ExampleAuth",
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
