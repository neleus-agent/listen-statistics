import { request } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DASHBOARD_HOST, startDashboard } from "../../src/dashboard/server.js";

function get(port: number, path: string, host = `${DASHBOARD_HOST}:${port}`, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: DASHBOARD_HOST, port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("dashboard server", () => {
  it("listens on loopback only and serves exactly the page and the CSV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dash-test-"));
    await writeFile(join(dir, "index.html"), "<html>atlas</html>");
    await writeFile(join(dir, "tracks-history.csv"), "track,hist_plays\r\nInvented Song,3\r\n");
    await writeFile(join(dir, "secret.txt"), "do not serve");
    const { server, url } = await startDashboard({ page: join(dir, "index.html"), csv: join(dir, "tracks-history.csv"), port: 0 });
    close = () => server.close();
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe("127.0.0.1");
    expect(url).toBe(`http://127.0.0.1:${addr.port}/`);

    expect((await get(addr.port, "/")).body).toContain("atlas");
    expect((await get(addr.port, "/data.csv")).body).toContain("Invented Song");
    expect((await get(addr.port, "/secret.txt")).status).toBe(404);
    expect((await get(addr.port, "/../secret.txt")).status).toBe(404);
    expect((await get(addr.port, "/data.csv", `localhost:${addr.port}`)).status).toBe(200);
    // DNS-rebinding guard: a foreign Host header is refused
    expect((await get(addr.port, "/data.csv", "evil.example:80")).status).toBe(403);
    expect((await get(addr.port, "/data.csv", undefined, "POST")).status).toBe(405);
  });

  it("without a CSV the data route is 404 (the page shows its drop zone)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dash-test-"));
    await writeFile(join(dir, "index.html"), "<html></html>");
    const { server } = await startDashboard({ page: join(dir, "index.html"), port: 0 });
    close = () => server.close();
    expect((await get((server.address() as { port: number }).port, "/data.csv")).status).toBe(404);
  });
});
