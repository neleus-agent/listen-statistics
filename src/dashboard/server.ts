import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

/** Loopback only. The dashboard is never reachable from another machine. */
export const DASHBOARD_HOST = "127.0.0.1";

/**
 * Serve the offline viewer and (optionally) one CSV. Exactly two routes: `/` (the page) and `/data.csv`.
 * The Host header must be the loopback address we listen on, so a web page that DNS-rebinds its name to
 * 127.0.0.1 cannot read your data.
 */
export async function startDashboard(opts: { page: string; csv?: string; port?: number }): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const okHosts = [`${DASHBOARD_HOST}:${port}`, `localhost:${port}`];
    if (!okHosts.includes(String(req.headers.host))) { res.writeHead(403).end("forbidden"); return; }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    const path = (req.url ?? "/").split("?")[0];
    const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { ...common, "Content-Type": "text/html; charset=utf-8" }).end(await readFile(opts.page));
      } else if (path === "/data.csv" && opts.csv) {
        res.writeHead(200, { ...common, "Content-Type": "text/csv; charset=utf-8" }).end(await readFile(opts.csv));
      } else {
        res.writeHead(404, common).end("not found");
      }
    } catch {
      res.writeHead(500, common).end("could not read file");
    }
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, DASHBOARD_HOST, () => { server.off("error", reject); resolve(); });
    });
  try {
    await listen(opts.port ?? 8765);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    await listen(0); // preferred port taken: any free one
  }
  const { port } = server.address() as { port: number };
  return { server, url: `http://${DASHBOARD_HOST}:${port}/` };
}
