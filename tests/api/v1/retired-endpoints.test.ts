// Tests for the PA-215 Token Factory soft-removal stubs.
//
// The OpenAI-compatible inference endpoints were retired but must keep
// answering: existing SDK clients need an OpenAI-style error envelope and a
//410 Gone (not a 404) so they surface the retirement message instead of
// failing opaquely. A future relaunch will consciously delete these tests.

import { describe, it, expect } from "vitest";

import * as chatCompletions from "@/app/api/v1/chat/completions/route";
import * as completions from "@/app/api/v1/completions/route";
import * as embeddings from "@/app/api/v1/embeddings/route";
import * as models from "@/app/api/v1/models/route";
import * as batch from "@/app/api/v1/batch/route";

const RETIRED_ROUTES: Array<{ name: string; mod: Record<string, unknown> }> = [
  { name: "chat/completions", mod: chatCompletions },
  { name: "completions", mod: completions },
  { name: "embeddings", mod: embeddings },
  { name: "models", mod: models },
  { name: "batch", mod: batch },
];

describe("retired Token Factory endpoints (PA-215)", () => {
  for (const { name, mod } of RETIRED_ROUTES) {
    for (const method of ["GET", "POST"] as const) {
      const handler = mod[method] as (() => Response) | undefined;
      if (!handler) continue;

      it(`${method} /api/v1/${name} returns 410 with an OpenAI-style error body`, async () => {
        const res = handler();
        const body = await res.json();

        expect(res.status).toBe(410);
        expect(body.error.type).toBe("endpoint_retired");
        expect(body.error.code).toBe("token_factory_retired");
        expect(body.error.message).toMatch(/retired/i);
      });
    }
  }
});
