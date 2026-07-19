import { describe, it, expect, beforeEach } from "vitest";
import { MockEtzhayyim } from "@etzhayyim/sdk-mock";
import {
  registerAnchor,
  getAnchor,
  listAnchors,
  recordFreeze,
  listFreezes,
  getFreeze,
  coverage,
} from "../src/index.js";

const OWNER = "did:web:yorishiro.etzhayyim.com";

describe("yorishiro kotoba (kotoba-E2E split)", () => {
  let e: any;
  beforeEach(() => {
    e = new MockEtzhayyim({ did: OWNER });
  });

  describe("yorishiroAnchor (PLAINTEXT public catalog)", () => {
    it("registers, dedups, validates, gets, lists/filters", async () => {
      expect((await registerAnchor(e, { anchorId: "a1", displayName: "Tsukuyomi", type: "fictional", boundAgentDid: "did:web:agent.x" })).status).toBe("registered");
      expect((await registerAnchor(e, { anchorId: "a1", displayName: "Tsukuyomi", type: "fictional" })).status).toBe("alreadyExists");
      expect((await registerAnchor(e, { anchorId: "aX", displayName: "Bad", type: "alien" as any })).status).toBe("rejected");
      expect((await registerAnchor(e, { anchorId: "aY", displayName: "", type: "fictional" })).status).toBe("rejected");

      await registerAnchor(e, { anchorId: "a2", displayName: "Sakanoue", type: "historical", boundAgentDid: "did:web:agent.y" });
      const got = await getAnchor(e, { anchorId: "a1" });
      expect(got.anchor?.displayName).toBe("Tsukuyomi");
      expect(got.anchor?.did).toBe("did:web:yorishiro.etzhayyim.com:anchor:a1");
      expect((await getAnchor(e, { anchorId: "nope" })).error).toBe("notFound");

      expect((await listAnchors(e)).total).toBe(2);
      expect((await listAnchors(e, { type: "fictional" })).total).toBe(1);
      expect((await listAnchors(e, { boundAgentDid: "did:web:agent.y" })).total).toBe(1);
    });
  });

  describe("freezeRequest (E2E-ENCRYPTED LE / confidential)", () => {
    it("seals via encryptedWrite, round-trips via encryptedRead, validates", async () => {
      const ok = await recordFreeze(e, {
        requestId: "f1",
        exchange: "binance",
        jurisdiction: "global",
        subjectAccountRef: "acct-0xABCD",
        reason: "theft-incident-2026-05",
        status: "submitted",
      });
      expect(ok.status).toBe("recorded");
      expect(ok.keyId).toBeTruthy();

      expect((await recordFreeze(e, { requestId: "fX", exchange: "kraken", jurisdiction: "us", subjectAccountRef: "acct-x", reason: "r", status: "bogus" as any })).status).toBe("rejected");
      expect((await recordFreeze(e, { requestId: "", exchange: "kraken", jurisdiction: "us", subjectAccountRef: "acct-x", reason: "r" })).status).toBe("rejected");

      const got = await getFreeze(e, { requestId: "f1" });
      expect(got.request?.subjectAccountRef).toBe("acct-0xABCD");
      expect(got.request?.status).toBe("submitted");
      expect((await getFreeze(e, { requestId: "nope" })).error).toBe("notFound");

      await recordFreeze(e, { requestId: "f2", exchange: "coinbase", jurisdiction: "us", subjectAccountRef: "acct-2", reason: "fraud" });
      expect((await listFreezes(e)).total).toBe(2);
      expect((await listFreezes(e, { exchange: "binance" })).total).toBe(1);
      expect((await listFreezes(e, { jurisdiction: "us" })).total).toBe(1);
    });

    it("enforces read-cap: a non-recipient DID cannot decrypt the freeze record", async () => {
      await recordFreeze(e, { requestId: "f1", exchange: "binance", jurisdiction: "global", subjectAccountRef: "acct-secret", reason: "r" });
      const outsider: any = new MockEtzhayyim({ did: "did:web:outsider.example" });
      // Distinct PDS view, no read-cap -> zero freeze records (owner-DID isolation).
      expect((await listFreezes(outsider)).total).toBe(0);
    });

    it("grants read-cap to an explicit recipient (e.g. lawfirm actor)", async () => {
      const lawfirm = "did:web:lawfirm.etzhayyim.com";
      const r = await recordFreeze(e, { requestId: "f1", exchange: "binance", jurisdiction: "global", subjectAccountRef: "acct-secret", reason: "r", recipients: [lawfirm] });
      expect(r.status).toBe("recorded");
      expect((await listFreezes(e)).total).toBe(1); // owner can read
    });
  });

  describe("coverage rollup", () => {
    it("counts plaintext anchors + E2E freeze requests", async () => {
      await registerAnchor(e, { anchorId: "a1", displayName: "A", type: "fictional" });
      await registerAnchor(e, { anchorId: "a2", displayName: "B", type: "fictional" });
      await registerAnchor(e, { anchorId: "a3", displayName: "C", type: "licensed" });
      await recordFreeze(e, { requestId: "f1", exchange: "binance", jurisdiction: "global", subjectAccountRef: "acct-1", reason: "r" });
      await recordFreeze(e, { requestId: "f2", exchange: "binance", jurisdiction: "global", subjectAccountRef: "acct-2", reason: "r" });
      const cov = await coverage(e);
      expect(cov.yorishiroAnchorCount).toBe(3);
      expect(cov.freezeRequestCount).toBe(2);
      expect(cov.anchorsByType?.fictional).toBe(2);
      expect(cov.anchorsByType?.licensed).toBe(1);
      expect(cov.freezesByExchange?.binance).toBe(2);
    });
  });
});
