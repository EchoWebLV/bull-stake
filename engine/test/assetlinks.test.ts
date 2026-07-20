import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.ts";

describe("GET /.well-known/assetlinks.json", () => {
  it("serves the Digital Asset Links statement for the Android TWA", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/.well-known/assetlinks.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.bullstake.app",
          sha256_cert_fingerprints: [
            "4B:34:85:EE:3F:19:DB:7A:CB:7D:1D:A3:EC:1E:C8:6A:F3:2B:D9:72:FA:3C:F3:DD:3D:26:32:B8:12:FD:EF:9C",
          ],
        },
      },
    ]);
  });
});
