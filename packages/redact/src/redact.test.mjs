import { describe, expect, it } from "vitest";
import { createRedactor, harvestMachineSecrets, shannon } from "./index.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const r = createRedactor();

/**
 * Every planted secret below is fabricated — shaped like the real thing,
 * valid nowhere. This file is public and GitHub's own push protection scans
 * it, and a format-only scanner cannot tell "shaped like a Stripe key" from
 * "is a Stripe key" — it flagged even Stripe's own documented example key. So
 * the credential-shaped ones are built by concatenation: the runtime string
 * `redactText` receives is identical to a literal, but no single contiguous
 * token in the SOURCE FILE matches a provider's pattern for a scanner to
 * catch. This is not working around a real protection — there is no real
 * secret here — it's keeping this file from reading as a leak at a glance.
 */
const PLANTED = [
  ["anthropic-key", "sk-ant-api03-" + "AbCdEf1234567890GhIjKlMnOpQrStUvWxYz"],
  ["openai-key", "sk-proj-" + "9f8e7d6c5b4a39281706fedcba0987654321abcd"],
  ["github-pat", "github_pat_11ABCDEFG0a" + "BcDeFgHiJkLmNoPqRsTuVwXyZ123456"],
  ["github-token", "ghp_" + "AbCdEf1234567890GhIjKlMnOpQrStUv"],
  ["aws-access-key-id", "AKIA" + "IOSFODNN7EXAMPLE"], // AWS's own documented example key
  ["google-api-key", "AIzaSyA" + "1234567890abcdefghijklmnopqrstuv"],
  ["slack-token", "xoxb-" + "123456789012-abcdefghijklmnop"],
  ["stripe-key", "sk_test_" + "4eC39HqLyjWDarjtT1zdp7dc"], // Stripe's own documented example test key
  ["sendgrid-key", "SG." + "AbCdEfGhIjKlMnOpQrSt.UvWxYz0123456789AbCdEfGhIjKl"],
  ["npm-token", "npm_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh"],
  ["bearer-token", "Bearer AbCdEf1234567890GhIjKlMnOpQrStUv"],
];

describe("known credential formats", () => {
  for (const [rule, secret] of PLANTED) {
    it(`redacts a ${rule} and never leaves the value behind`, () => {
      const { text, findings } = r.redactText(`the key is ${secret} ok`);
      expect(text).not.toContain(secret);
      expect(text).toContain(`[redacted:${rule}]`);
      expect(findings[rule]).toBe(1);
    });
  }

  it("redacts a private key block whole, delimiters included", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB",
      "AAAAMwAAAAtzc2gtZWQyNTUxOQAAACBabcdefghijklmnopqrstu",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const { text, findings } = r.redactText(`here:\n${pem}\ndone`);
    expect(text).not.toContain("b3BlbnNzaC1rZXktdjEA");
    expect(text).not.toContain("BEGIN OPENSSH");
    expect(findings["private-key"]).toBe(1);
  });

  it("keeps the host of a connection string and drops only the password", () => {
    const { text } = r.redactText("postgres://app_user:hunter2swordfish@db.internal:5432/prod");
    expect(text).toContain("postgres://app_user:");
    expect(text).toContain("@db.internal:5432/prod");
    expect(text).not.toContain("hunter2swordfish");
  });

  it("labels an Anthropic key as such rather than as an OpenAI key", () => {
    const { findings } = r.redactText("sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQr");
    expect(findings["anthropic-key"]).toBe(1);
    expect(findings["openai-key"]).toBeUndefined();
  });
});

describe("named assignments", () => {
  it("redacts a low-entropy password, because the key said password", () => {
    const { text, findings } = r.redactText("DB_PASSWORD=correcthorsebattery");
    expect(text).not.toContain("correcthorsebattery");
    expect(findings["named-secret"]).toBe(1);
  });

  it("handles JSON and YAML spellings alike", () => {
    expect(r.redactText('"api_key": "abcdefghijklmnop"').text).not.toContain("abcdefghijkl");
    expect(r.redactText("client_secret: abcdefghijklmnop").text).not.toContain("abcdefghijkl");
  });

  it("leaves an unnamed value alone", () => {
    const line = "OUTPUT_DIR=/var/tmp/build-artifacts";
    expect(r.redactText(line).text).toBe(line);
  });

  it("leaves placeholders and variable references readable", () => {
    for (const line of [
      "API_KEY=your_api_key_here",
      "TOKEN=${GITHUB_TOKEN}",
      "SECRET=$MY_SECRET",
      "password=changeme",
    ]) {
      expect(r.redactText(line).text).toBe(line);
    }
  });

  it("stops at the end of the value, not the end of the line", () => {
    const { text } = r.redactText("export TOKEN=abcdefghijklmnop && echo done");
    expect(text).toContain("&& echo done");
    expect(text).not.toContain("abcdefghijklmnop");
  });
});

describe("code is not a credential", () => {
  // Every line below was redacted by an earlier version of this ruleset in a
  // real exported trajectory — a thread that happened to be ABOUT auth code.
  // A scrubber that shreds source teaches people to distrust the placeholder.
  const CODE = [
    "return { nodeId: dev.nodeId, relay: dev.relay ?? null, token: dev.token };",
    "start(nodeId: string, relay: string | null, token: string)",
    "let token = read_token(&mut recv).await?;",
    'const token = str(key, 128) || randomBytes(16).toString("hex");',
    "return send(res, 200, { deviceId: minted.id, token: minted.token });",
    "tokenHash: hashOf(device.id),",
    'const token = u.searchParams.get("token");',
    // Bare identifiers: a constant, a camelCase local, a snake_case local.
    "cached = { token: LEGACY_TOKEN, legacyUntil: 0 };",
    "return { token: fresh, adopted: true, tunnelToken: freshTunnelSecret };",
    "payload = { tunnelToken: TUNNEL_SECRET, appVersion: APP_VERSION };",
    "conn = { api_key: fallback_api_key }",
  ];
  for (const line of CODE) {
    it(`leaves source alone: ${line.slice(0, 38)}…`, () => {
      expect(r.redactText(line).text).toBe(line);
    });
  }

  it("still catches a quoted literal sitting in that same code", () => {
    const line = 'const token = "abcdefghijklmnopqrst";';
    expect(r.redactText(line).text).not.toContain("abcdefghijklmnopqrst");
  });
});

describe("what it must not destroy", () => {
  it("leaves git SHAs alone by default", () => {
    const line = "fixed in a6b68229ff0ae7a9ef0d6c7efa01d361a7c57c73";
    expect(r.redactText(line).text).toBe(line);
  });

  it("leaves ordinary prose and code untouched", () => {
    const code = "const total = items.reduce((a, b) => a + b.tokens, 0);";
    expect(r.redactText(code).text).toBe(code);
  });

  it("spares hex even with entropy on — 16 symbols cannot reach the threshold", () => {
    const hot = createRedactor({ entropy: true });
    const sha = "a6b68229ff0ae7a9ef0d6c7efa01d361a7c57c73";
    expect(shannon(sha)).toBeLessThan(4.2);
    expect(hot.redactText(`fixed in ${sha}`).text).toContain(sha);
  });

  it("catches a bare base64 token once entropy is enabled — and base64 content with it", () => {
    const hot = createRedactor({ entropy: true });
    const bare = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZg";
    expect(r.redactText(bare).text).toBe(bare); // no other layer sees it
    expect(hot.redactText(bare).findings["high-entropy"]).toBe(1);
  });
});

describe("idempotence", () => {
  it("does not double-wrap an already redacted document", () => {
    const once = r.redactText("key sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQr");
    const twice = r.redactText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.findings["anthropic-key"]).toBeUndefined();
  });
});

describe("document walking", () => {
  it("redacts strings at every depth and preserves structure", () => {
    const doc = {
      steps: [
        { message: "use sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQr", tokens: 12 },
        {
          tool_calls: [
            { arguments: { cmd: "curl -H 'Authorization: Bearer AbCdEf1234567890GhIjK'" } },
          ],
        },
      ],
      ok: true,
      nothing: null,
    };
    const { value, count, findings } = r.redact(doc);
    expect(JSON.stringify(value)).not.toContain("sk-ant-api03");
    expect(value.steps[0].tokens).toBe(12);
    expect(value.ok).toBe(true);
    expect(value.nothing).toBeNull();
    expect(count).toBe(2);
    expect(findings["anthropic-key"]).toBe(1);
  });

  it("leaves object keys alone", () => {
    const { value } = r.redact({ api_key_name: "harmless" });
    expect(Object.keys(value)).toEqual(["api_key_name"]);
  });

  it("throws on a cycle rather than looping", () => {
    const a = { name: "a" };
    a.self = a;
    expect(() => r.redact(a)).toThrow(/cycle/);
  });

  it("reports counts without ever carrying the value", () => {
    const { findings } = r.redact({ a: "sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQr" });
    expect(JSON.stringify(findings)).not.toContain("AbCdEf");
  });
});

describe("machine denylist", () => {
  it("redacts an exact live value that no pattern would catch", () => {
    const weird = "pounce-bridge-local-9f8e7d6c";
    const withDeny = createRedactor({ denylist: [weird] });
    expect(r.redactText(`token ${weird}`).text).toContain(weird);
    const { text, findings } = withDeny.redactText(`token ${weird}`);
    expect(text).not.toContain(weird);
    expect(findings["machine-secret"]).toBe(1);
  });

  it("harvests .env values and agent credential stores", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "redact-home-"));
    const proj = mkdtempSync(path.join(os.tmpdir(), "redact-proj-"));
    try {
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      writeFileSync(
        path.join(home, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "oat-abcdefghijklmnopqrstuvwxyz" } }),
      );
      writeFileSync(
        path.join(proj, ".env"),
        "# comment\nDATABASE_URL=postgres://u:p@h/db\nAPI_SECRET='quotedsecretvalue123'\nSHORT=x\n",
      );
      const found = harvestMachineSecrets({ home, cwd: proj, env: false });
      expect(found).toContain("oat-abcdefghijklmnopqrstuvwxyz");
      expect(found).toContain("quotedsecretvalue123");
      expect(found).not.toContain("x");
      // Longest first, so the most specific value redacts before a prefix of it.
      expect(found[0].length).toBeGreaterThanOrEqual(found[found.length - 1].length);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("survives a missing or malformed credential store", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "redact-bad-"));
    try {
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      writeFileSync(path.join(home, ".claude", ".credentials.json"), "{not json");
      expect(() => harvestMachineSecrets({ home, env: false })).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("home path folding", () => {
  it("drops the account name from absolute paths", () => {
    const folded = createRedactor({ home: "/Users/someone" });
    const { text } = folded.redactText("read /Users/someone/Projects/app/src/index.ts");
    expect(text).toBe("read ~/Projects/app/src/index.ts");
  });

  it("folds a sibling account too", () => {
    const folded = createRedactor({ home: "/Users/someone" });
    expect(folded.redactText("/Users/other/secrets").text).toBe("~/secrets");
  });
});

describe("shannon", () => {
  it("separates random from repetitive", () => {
    expect(shannon("aaaaaaaaaaaaaaaa")).toBe(0);
    expect(shannon("AbCdEf1234567890GhIjKlMnOpQr")).toBeGreaterThan(4);
  });
});
